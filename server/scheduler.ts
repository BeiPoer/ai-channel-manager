import { DatabaseSync } from 'node:sqlite';
import { getEmailSettings, sendEmail } from './email.js';
import { cleanupHistory, nowIso, parseJson, parseTask, readChannelCache, readTaskState, upsertTaskState } from './db.js';
import { filterGroupsByIdentifiers, filterGroupsByTokenUsage, groupList, normalizeGroups, watchedGroupIdentifiers } from './groupMonitoring.js';
import { syncChannel, syncChannelBalance } from './adapters.js';
import { runDueOwnedSiteTasks, runDueOwnedSiteUpstreamMonitors } from './ownedSites.js';
import type { AutomationTaskRecord, BalanceSnapshot, ChannelType } from './types.js';

export interface EvaluationResult {
  triggered: boolean;
  message: string;
  snapshot?: unknown;
}

const groupTaskStateKey = 'groups';
const cleanupIntervalMs = 24 * 60 * 60 * 1000;
type ChannelTaskRow = AutomationTaskRecord & { channel_name: string; channel_type: ChannelType };
type SchedulerJob = () => Promise<void>;

function minutesSince(value: string | null, now = new Date()): number {
  if (!value) return Infinity;
  return (now.getTime() - new Date(value).getTime()) / 60000;
}

export function evaluateGroupTask(
  task: AutomationTaskRecord,
  beforeGroups: unknown,
  afterGroups: unknown,
  channelName = '渠道',
  hasBaseline = true
): EvaluationResult {
  const before = normalizeGroups(beforeGroups);
  const after = normalizeGroups(afterGroups);
  if (!hasBaseline) {
    return { triggered: false, message: `${channelName} 缺少历史分组缓存，本次仅建立基线`, snapshot: { before: [], after: Array.from(after.values()) } };
  }
  const added = Array.from(after.values()).filter((group) => !before.has(group.key));
  const removed = Array.from(before.values()).filter((group) => !after.has(group.key));
  const ratioChanged = Array.from(after.values()).flatMap((group) => {
    const old = before.get(group.key);
    if (!old || old.ratio === null || group.ratio === null || old.ratio === group.ratio) return [];
    return [{ key: group.key, label: group.label, before: old.ratio, after: group.ratio, beforeRaw: old.raw, afterRaw: group.raw }];
  });
  if (task.type === 'group_added') {
    return {
      triggered: added.length > 0,
      message: added.length ? `${channelName} 新增分组：${groupList(added)}` : `${channelName} 未发现新增分组`,
      snapshot: { added, before: Array.from(before.values()), after: Array.from(after.values()) }
    };
  }
  if (task.type === 'group_removed') {
    return {
      triggered: removed.length > 0,
      message: removed.length ? `${channelName} 减少分组：${groupList(removed)}` : `${channelName} 未发现减少分组`,
      snapshot: { removed, before: Array.from(before.values()), after: Array.from(after.values()) }
    };
  }
  return {
    triggered: ratioChanged.length > 0,
    message: ratioChanged.length
      ? `${channelName} 分组倍率变化：${ratioChanged.map((item) => `${item.label} ${item.before} -> ${item.after}`).join('、')}`
      : `${channelName} 未发现分组倍率变化`,
    snapshot: { changed: ratioChanged, before: Array.from(before.values()), after: Array.from(after.values()) }
  };
}

export function evaluateTask(task: AutomationTaskRecord, snapshots: BalanceSnapshot[], channelName = '渠道'): EvaluationResult {
  const latest = snapshots.at(-1);
  if (!latest) return { triggered: false, message: '缺少余额快照' };
  if (task.type === 'low_balance') {
    const triggered = latest.balance <= task.threshold;
    return {
      triggered,
      message: triggered
        ? `${channelName} 当前余额 ${latest.balance} ${latest.unit}，已低于或等于阈值 ${task.threshold}`
        : `${channelName} 当前余额未低于阈值`,
      snapshot: latest
    };
  }
  const cutoff = new Date(new Date(latest.captured_at).getTime() - task.lookback_minutes * 60000);
  const old = snapshots.find((item) => new Date(item.captured_at) >= cutoff) || snapshots[0];
  if (!old || old.id === latest.id) {
    return { triggered: false, message: '窗口内余额快照不足', snapshot: latest };
  }
  const consumed = old.balance - latest.balance;
  if (consumed <= 0) {
    return {
      triggered: false,
      message: `${channelName} 余额上涨或未消耗，不触发消耗过快预警`,
      snapshot: { old, latest, consumed }
    };
  }
  const elapsedMinutes = Math.max(1, (new Date(latest.captured_at).getTime() - new Date(old.captured_at).getTime()) / 60000);
  const hourlyRate = consumed / (elapsedMinutes / 60);
  const triggered = hourlyRate >= task.threshold;
  return {
    triggered,
    message: triggered
      ? `${channelName} 最近 ${Math.round(elapsedMinutes)} 分钟消耗 ${consumed.toFixed(4)} ${latest.unit}，折算每小时 ${hourlyRate.toFixed(4)}，超过阈值 ${task.threshold}`
      : `${channelName} 消耗速度未超过阈值`,
    snapshot: { old, latest, consumed, hourlyRate }
  };
}

function isGroupTask(task: AutomationTaskRecord): boolean {
  return task.type === 'group_added' || task.type === 'group_removed' || task.type === 'group_ratio_changed';
}

function taskGroupsForEvaluation(
  task: AutomationTaskRecord,
  beforeGroups: unknown,
  afterGroups: unknown,
  afterTokens: unknown,
  channelType: ChannelType
): { before: unknown; after: unknown; state: unknown } {
  if (task.type !== 'group_ratio_changed') return { before: beforeGroups, after: afterGroups, state: afterGroups };
  const identifiers = watchedGroupIdentifiers(afterGroups, afterTokens, channelType);
  return {
    before: filterGroupsByIdentifiers(beforeGroups, identifiers),
    after: filterGroupsByIdentifiers(afterGroups, identifiers),
    state: filterGroupsByTokenUsage(afterGroups, afterTokens, channelType)
  };
}

function alertSubject(task: AutomationTaskRecord): string {
  return isGroupTask(task) ? 'AI 渠道分组预警' : 'AI 渠道余额预警';
}

async function recordAlert(
  db: DatabaseSync,
  row: AutomationTaskRecord & { channel_name: string },
  evaluation: EvaluationResult,
  now: Date,
  mailer: typeof sendEmail
): Promise<void> {
  if (!evaluation.triggered) return;
  if (minutesSince(row.last_alert_at, now) < row.cooldown_minutes) return;
  const recipients = parseJson<string[]>(row.recipients_json, []);
  const fallbackRecipients = getEmailSettings(db).default_recipients;
  let emailSent = 0;
  let emailError: string | null = null;
  try {
    await mailer(db, recipients.length ? recipients : fallbackRecipients, alertSubject(row), evaluation.message);
    emailSent = 1;
  } catch (error) {
    emailError = (error as Error).message;
  }
  db.prepare(`
    INSERT INTO alert_events (channel_id, task_id, type, message, snapshot_json, email_sent, email_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.channel_id, row.id, row.type, evaluation.message, JSON.stringify(evaluation.snapshot ?? null), emailSent, emailError, nowIso(now));
  db.prepare('UPDATE automation_tasks SET last_alert_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), row.id);
}

function loadDueTaskRows(db: DatabaseSync, now: Date, groupTasks: boolean): ChannelTaskRow[] {
  const rows = db.prepare(`
    SELECT t.*, c.name AS channel_name, c.type AS channel_type
    FROM automation_tasks t
    JOIN channels c ON c.id = t.channel_id
    WHERE t.enabled = 1
      AND c.type <> 'other'
      AND c.ignored = 0
  `).all() as unknown as ChannelTaskRow[];
  return rows.filter((row) => isGroupTask(row) === groupTasks && minutesSince(row.last_run_at, now) >= row.interval_minutes);
}

function taskRowsByChannel(rows: ChannelTaskRow[]): Map<number, ChannelTaskRow[]> {
  const grouped = new Map<number, ChannelTaskRow[]>();
  for (const row of rows) {
    const channelRows = grouped.get(row.channel_id) || [];
    channelRows.push(row);
    grouped.set(row.channel_id, channelRows);
  }
  return grouped;
}

function markTaskRowsStarted(db: DatabaseSync, rows: ChannelTaskRow[], now: Date): void {
  for (const row of rows) {
    db.prepare('UPDATE automation_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), row.id);
  }
}

async function runBalanceTaskRows(db: DatabaseSync, channelRows: ChannelTaskRow[], now: Date, mailer: typeof sendEmail): Promise<void> {
  markTaskRowsStarted(db, channelRows, now);
  try {
    await syncChannelBalance(db, channelRows[0].channel_id);
  } catch {
    return;
  }
  const snapshots = db.prepare(`
    SELECT * FROM balance_snapshots
    WHERE channel_id = ? AND captured_at >= ?
    ORDER BY captured_at ASC
  `).all(channelRows[0].channel_id, nowIso(new Date(now.getTime() - Math.max(...channelRows.map((row) => row.lookback_minutes)) * 60000))) as unknown as BalanceSnapshot[];
  for (const row of channelRows) {
    const cutoff = new Date(now.getTime() - row.lookback_minutes * 60000);
    const taskSnapshots = snapshots.filter((snapshot) => new Date(snapshot.captured_at) >= cutoff);
    if (taskSnapshots.length < 2) {
      const latest = db.prepare(`
        SELECT * FROM balance_snapshots WHERE channel_id = ? ORDER BY captured_at DESC LIMIT 1
      `).get(row.channel_id) as BalanceSnapshot | undefined;
      if (latest && !taskSnapshots.some((snapshot) => snapshot.id === latest.id)) taskSnapshots.push(latest);
    }
    await recordAlert(db, row, evaluateTask(row, taskSnapshots, row.channel_name), now, mailer);
  }
}

export async function runDueBalanceTasks(db: DatabaseSync, mailer = sendEmail): Promise<void> {
  const now = new Date();
  await Promise.all(Array.from(taskRowsByChannel(loadDueTaskRows(db, now, false)).values(), (rows) => runBalanceTaskRows(db, rows, now, mailer)));
}

export async function runDueGroupTasks(db: DatabaseSync, mailer = sendEmail): Promise<void> {
  const now = new Date();
  for (const channelRows of taskRowsByChannel(loadDueTaskRows(db, now, true)).values()) {
    const first = channelRows[0];
    const beforeChannelGroups = readChannelCache(db, first.channel_id, 'groups', []);
    markTaskRowsStarted(db, channelRows, now);
    try {
      await syncChannel(db, first.channel_id);
    } catch {
      // 同步失败已经写入渠道状态；这里保留旧缓存，不额外触发余额判断。
      continue;
    }
    const afterGroups = readChannelCache(db, first.channel_id, 'groups', []);
    const afterTokens = readChannelCache(db, first.channel_id, 'tokens', []);
    for (const row of channelRows) {
      const taskGroups = readTaskState(db, row.id, groupTaskStateKey, []);
      const beforeGroups = taskGroups.exists ? taskGroups : beforeChannelGroups;
      const groups = taskGroupsForEvaluation(row, beforeGroups.value, afterGroups.value, afterTokens.value, row.channel_type);
      await recordAlert(db, row, evaluateGroupTask(row, groups.before, groups.after, row.channel_name, beforeGroups.exists), now, mailer);
      upsertTaskState(db, row.id, groupTaskStateKey, groups.state);
    }
  }
}

export async function runDueTasks(db: DatabaseSync, mailer = sendEmail): Promise<void> {
  await runDueBalanceTasks(db, mailer);
  await runDueGroupTasks(db, mailer);
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningJobs = new Set<SchedulerJob>();
  private lastCleanupAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly jobs: SchedulerJob[] = [
      () => runDueBalanceTasks(db),
      () => runDueGroupTasks(db),
      () => runDueOwnedSiteTasks(db),
      () => runDueOwnedSiteUpstreamMonitors(db)
    ]
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt >= cleanupIntervalMs) {
      cleanupHistory(this.db, new Date(now));
      this.lastCleanupAt = now;
    }
    for (const job of this.jobs) {
      if (this.runningJobs.has(job)) continue;
      this.runningJobs.add(job);
      void job()
        .catch((error) => console.error('Scheduler job failed:', error))
        .finally(() => this.runningJobs.delete(job));
    }
  }
}

export function parseTaskRow(row: AutomationTaskRecord) {
  return parseTask(row);
}
