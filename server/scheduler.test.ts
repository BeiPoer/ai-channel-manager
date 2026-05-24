import { describe, expect, it, vi } from 'vitest';
import { createDatabase, nowIso } from './db.js';
import { evaluateTask, runDueTasks } from './scheduler.js';
import type { AutomationTaskRecord, BalanceSnapshot } from './types.js';

function task(overrides: Partial<AutomationTaskRecord>): AutomationTaskRecord {
  return {
    id: 1,
    channel_id: 1,
    type: 'low_balance',
    enabled: 1,
    interval_minutes: 1,
    threshold: 10,
    lookback_minutes: 60,
    cooldown_minutes: 60,
    recipients_json: null,
    last_run_at: null,
    last_alert_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides
  };
}

function snapshot(id: number, balance: number, minutesAgo: number): BalanceSnapshot {
  return {
    id,
    channel_id: 1,
    balance,
    used_balance: null,
    unit: 'quota',
    raw_json: null,
    captured_at: nowIso(new Date(Date.now() - minutesAgo * 60000))
  };
}

describe('automation evaluation', () => {
  it('triggers low balance under threshold', () => {
    const result = evaluateTask(task({ threshold: 5 }), [snapshot(1, 4, 0)], 'test');
    expect(result.triggered).toBe(true);
  });

  it('does not trigger burn rate when balance increases', () => {
    const result = evaluateTask(
      task({ type: 'burn_rate', threshold: 1, lookback_minutes: 60 }),
      [snapshot(1, 10, 50), snapshot(2, 12, 0)],
      'test'
    );
    expect(result.triggered).toBe(false);
  });

  it('records email failure without blocking later tasks', async () => {
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO channels (id, name, type, base_url, username, password, status, created_at, updated_at)
      VALUES (1, 's', 'sub2api', 'http://127.0.0.1:1', 'u', 'p', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
      VALUES (1, 'low_balance', 1, 1, 99, 60, 0, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO balance_snapshots (channel_id, balance, used_balance, unit, raw_json, captured_at)
      VALUES (1, 1, NULL, 'quota', '{}', ?)
    `).run(now);
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockResolvedValue({
      profile: {},
      balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
      groups: [],
      tokens: [],
      raw: {}
    });
    const mailer = vi.fn(async () => {
      throw new Error('smtp failed');
    });

    await runDueTasks(db, mailer);

    const alert = db.prepare('SELECT * FROM alert_events').get() as { email_sent: number; email_error: string };
    expect(alert.email_sent).toBe(0);
    expect(alert.email_error).toContain('smtp failed');
    syncSpy.mockRestore();
    db.close();
  });
});

