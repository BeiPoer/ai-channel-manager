import { DatabaseSync } from 'node:sqlite';
import { getEmailSettings, sendEmail } from './email.js';
import { nowIso, parseJson, parseTask, readChannelCache, readTaskState, upsertTaskState } from './db.js';
import { syncChannel } from './adapters.js';
import type { AutomationTaskRecord, BalanceSnapshot } from './types.js';

export interface EvaluationResult {
  triggered: boolean;
  message: string;
  snapshot?: unknown;
}

interface GroupInfo {
  key: string;
  label: string;
  ratio: number | null;
  raw: unknown;
}

const groupTaskStateKey = 'groups';

function minutesSince(value: string | null, now = new Date()): number {
  if (!value) return Infinity;
  return (now.getTime() - new Date(value).getTime()) / 60000;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function groupKey(group: unknown): string {
  if (!group || typeof group !== 'object') return stringValue(group) || JSON.stringify(group);
  const record = group as Record<string, unknown>;
  const keyFields = ['name', 'group', 'key', 'code', 'id', 'group_id', 'group_name', 'display_name'];
  for (const field of keyFields) {
    const value = stringValue(record[field]);
    if (value) return value;
  }
  return JSON.stringify(record);
}

function groupRatio(group: unknown): number | null {
  if (typeof group === 'number' && Number.isFinite(group)) return group;
  if (!group || typeof group !== 'object') return null;
  const record = group as Record<string, unknown>;
  const ratioFields = ['ratio', 'rate', 'multiplier', 'rate_multiplier', 'rateMultiplier', 'group_ratio', 'model_ratio', '倍率', 'value'];
  for (const field of ratioFields) {
    const value = record[field];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeGroups(groups: unknown): Map<string, GroupInfo> {
  const items = Array.isArray(groups)
    ? groups
    : groups && typeof groups === 'object'
      ? Object.entries(groups as Record<string, unknown>).map(([name, value]) => ({ name, ...(value && typeof value === 'object' ? value : { value }) }))
      : [];
  const map = new Map<string, GroupInfo>();
  for (const item of items) {
    const key = groupKey(item);
    map.set(key, {
      key,
      label: key,
      ratio: groupRatio(item),
      raw: item
    });
  }
  return map;
}

function groupList(groups: Iterable<GroupInfo>): string {
  return Array.from(groups)
    .map((group) => (group.ratio === null ? group.label : `${group.label}(${group.ratio})`))
    .join('、');
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

export async function runDueTasks(db: DatabaseSync, mailer = sendEmail): Promise<void> {
  const rows = db.prepare(`
    SELECT t.*, c.name AS channel_name
    FROM automation_tasks t
    JOIN channels c ON c.id = t.channel_id
    WHERE t.enabled = 1
  `).all() as unknown as Array<AutomationTaskRecord & { channel_name: string }>;
  const now = new Date();
  const dueRows = rows.filter((row) => minutesSince(row.last_run_at, now) >= row.interval_minutes);
  const rowsByChannel = new Map<number, Array<AutomationTaskRecord & { channel_name: string }>>();
  for (const row of dueRows) {
    const channelRows = rowsByChannel.get(row.channel_id) || [];
    channelRows.push(row);
    rowsByChannel.set(row.channel_id, channelRows);
  }
  for (const channelRows of rowsByChannel.values()) {
    const first = channelRows[0];
    const beforeChannelGroups = readChannelCache(db, first.channel_id, 'groups', []);
    for (const row of channelRows) {
      db.prepare('UPDATE automation_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), row.id);
    }
    try {
      await syncChannel(db, first.channel_id);
    } catch {
      // 同步失败已经写入渠道状态；这里保留旧缓存，不额外触发余额判断。
      continue;
    }
    const afterGroups = readChannelCache(db, first.channel_id, 'groups', []);
    const snapshots = db.prepare(`
      SELECT * FROM balance_snapshots
      WHERE channel_id = ? AND captured_at >= ?
      ORDER BY captured_at ASC
    `).all(first.channel_id, nowIso(new Date(now.getTime() - Math.max(...channelRows.map((row) => row.lookback_minutes)) * 60000))) as unknown as BalanceSnapshot[];
    for (const row of channelRows) {
      if (isGroupTask(row)) {
        const taskGroups = readTaskState(db, row.id, groupTaskStateKey, []);
        const beforeGroups = taskGroups.exists ? taskGroups : beforeChannelGroups;
        await recordAlert(db, row, evaluateGroupTask(row, beforeGroups.value, afterGroups.value, row.channel_name, beforeGroups.exists), now, mailer);
        upsertTaskState(db, row.id, groupTaskStateKey, afterGroups.value);
        continue;
      }
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
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly db: DatabaseSync) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runDueTasks(this.db);
    } finally {
      this.running = false;
    }
  }
}

export function parseTaskRow(row: AutomationTaskRecord) {
  return parseTask(row);
}
