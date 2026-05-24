import { DatabaseSync } from 'node:sqlite';
import { getEmailSettings, sendEmail } from './email.js';
import { nowIso, parseJson, parseTask } from './db.js';
import { syncChannel } from './adapters.js';
import type { AutomationTaskRecord, BalanceSnapshot } from './types.js';

export interface EvaluationResult {
  triggered: boolean;
  message: string;
  snapshot?: unknown;
}

function minutesSince(value: string | null, now = new Date()): number {
  if (!value) return Infinity;
  return (now.getTime() - new Date(value).getTime()) / 60000;
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

export async function runDueTasks(db: DatabaseSync, mailer = sendEmail): Promise<void> {
  const rows = db.prepare(`
    SELECT t.*, c.name AS channel_name
    FROM automation_tasks t
    JOIN channels c ON c.id = t.channel_id
    WHERE t.enabled = 1
  `).all() as unknown as Array<AutomationTaskRecord & { channel_name: string }>;
  const now = new Date();
  for (const row of rows) {
    if (minutesSince(row.last_run_at, now) < row.interval_minutes) continue;
    db.prepare('UPDATE automation_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), row.id);
    try {
      await syncChannel(db, row.channel_id);
    } catch {
      // 同步失败已经写入渠道状态；这里保留旧缓存，不额外触发余额判断。
      continue;
    }
    const snapshots = db.prepare(`
      SELECT * FROM balance_snapshots
      WHERE channel_id = ? AND captured_at >= ?
      ORDER BY captured_at ASC
    `).all(row.channel_id, nowIso(new Date(now.getTime() - row.lookback_minutes * 60000))) as unknown as BalanceSnapshot[];
    if (snapshots.length < 2) {
      const latest = db.prepare(`
        SELECT * FROM balance_snapshots WHERE channel_id = ? ORDER BY captured_at DESC LIMIT 1
      `).get(row.channel_id) as BalanceSnapshot | undefined;
      if (latest) snapshots.push(latest);
    }
    const evaluation = evaluateTask(row, snapshots, row.channel_name);
    if (!evaluation.triggered) continue;
    if (minutesSince(row.last_alert_at, now) < row.cooldown_minutes) continue;
    const recipients = parseJson<string[]>(row.recipients_json, []);
    const fallbackRecipients = getEmailSettings(db).default_recipients;
    let emailSent = 0;
    let emailError: string | null = null;
    try {
      await mailer(db, recipients.length ? recipients : fallbackRecipients, 'AI 渠道余额预警', evaluation.message);
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
