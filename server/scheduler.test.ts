import { describe, expect, it, vi } from 'vitest';
import { createDatabase, nowIso } from './db.js';
import { evaluateGroupTask, evaluateTask, runDueTasks } from './scheduler.js';
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

  it('triggers when a group is added', () => {
    const result = evaluateGroupTask(
      task({ type: 'group_added' }),
      [{ name: 'default', ratio: 1 }],
      [
        { name: 'default', ratio: 1 },
        { name: 'vip', ratio: 0.8 }
      ],
      'test'
    );
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('vip');
  });

  it('triggers when a group is removed', () => {
    const result = evaluateGroupTask(
      task({ type: 'group_removed' }),
      [
        { name: 'default', ratio: 1 },
        { name: 'vip', ratio: 0.8 }
      ],
      [{ name: 'default', ratio: 1 }],
      'test'
    );
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('vip');
  });

  it('triggers when a group ratio changes', () => {
    const result = evaluateGroupTask(task({ type: 'group_ratio_changed' }), [{ name: 'default', ratio: 1 }], [{ name: 'default', ratio: 1.5 }], 'test');
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('1 -> 1.5');
  });

  it('triggers when a sub2api group rate multiplier changes', () => {
    const result = evaluateGroupTask(
      task({ type: 'group_ratio_changed' }),
      [{ name: 'default', rate_multiplier: 1 }],
      [{ name: 'default', rate_multiplier: 1.5 }],
      'test'
    );
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('1 -> 1.5');
  });

  it('does not trigger group alerts before a baseline cache exists', () => {
    const result = evaluateGroupTask(task({ type: 'group_added' }), [], [{ name: 'default', ratio: 1 }], 'test', false);
    expect(result.triggered).toBe(false);
    expect(result.message).toContain('建立基线');
  });

  it('triggers group added from an existing empty baseline', () => {
    const result = evaluateGroupTask(task({ type: 'group_added' }), [], [{ name: 'default', ratio: 1 }], 'test', true);
    expect(result.triggered).toBe(true);
    expect(result.message).toContain('default');
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

  it('shares one channel sync across multiple due group tasks', async () => {
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO channels (id, name, type, base_url, username, password, status, created_at, updated_at)
      VALUES (1, 's', 'sub2api', 'http://127.0.0.1:1', 'u', 'p', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'groups', ?, ?, ?)
    `).run(JSON.stringify([{ name: 'default', ratio: 1 }]), JSON.stringify([{ name: 'default', ratio: 1 }]), now);
    db.prepare(`
      INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
      VALUES
        (1, 'group_added', 1, 1, 0, 60, 0, ?, ?),
        (1, 'group_ratio_changed', 1, 1, 0, 60, 0, ?, ?)
    `).run(now, now, now, now);
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockImplementation(async () => {
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'groups'
      `).run(
        JSON.stringify([
          { name: 'default', ratio: 2 },
          { name: 'vip', ratio: 0.8 }
        ]),
        JSON.stringify([
          { name: 'default', ratio: 2 },
          { name: 'vip', ratio: 0.8 }
        ]),
        nowIso()
      );
      return {
        profile: {},
        balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
        groups: [
          { name: 'default', ratio: 2 },
          { name: 'vip', ratio: 0.8 }
        ],
        tokens: [],
        raw: {}
      };
    });
    const mailer = vi.fn(async () => 'ok');

    await runDueTasks(db, mailer);

    const alerts = db.prepare('SELECT type, message FROM alert_events ORDER BY id ASC').all() as Array<{ type: string; message: string }>;
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(mailer).toHaveBeenCalledTimes(2);
    expect(alerts.map((alert) => alert.type)).toEqual(['group_added', 'group_ratio_changed']);
    expect(alerts[0].message).toContain('vip');
    expect(alerts[1].message).toContain('default 1 -> 2');
    syncSpy.mockRestore();
    db.close();
  });

  it('uses per-task group baseline even when channel cache was manually synced', async () => {
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO channels (id, name, type, base_url, username, password, status, created_at, updated_at)
      VALUES (1, 's', 'sub2api', 'http://127.0.0.1:1', 'u', 'p', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'groups', ?, ?, ?)
    `).run(JSON.stringify([{ name: 'default', ratio: 1 }]), JSON.stringify([{ name: 'default', ratio: 1 }]), now);
    const taskId = Number(
      db.prepare(`
        INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
        VALUES (1, 'group_removed', 1, 1, 0, 60, 0, ?, ?)
      `).run(now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO automation_task_state (task_id, state_key, value_json, updated_at)
      VALUES (?, 'groups', ?, ?)
    `).run(
      taskId,
      JSON.stringify([
        { name: 'default', ratio: 1 },
        { name: 'vip', ratio: 0.8 }
      ]),
      now
    );
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockResolvedValue({
      profile: {},
      balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
      groups: [{ name: 'default', ratio: 1 }],
      tokens: [],
      raw: {}
    });
    const mailer = vi.fn(async () => 'ok');

    await runDueTasks(db, mailer);

    const alert = db.prepare('SELECT type, message FROM alert_events').get() as { type: string; message: string };
    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(taskId) as { value_json: string };
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(alert.type).toBe('group_removed');
    expect(alert.message).toContain('vip');
    expect(JSON.parse(state.value_json)).toEqual([{ name: 'default', ratio: 1 }]);
    syncSpy.mockRestore();
    db.close();
  });

  it('backfills missing per-task group baseline from the existing channel cache', async () => {
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO channels (id, name, type, base_url, username, password, status, created_at, updated_at)
      VALUES (1, 's', 'sub2api', 'http://127.0.0.1:1', 'u', 'p', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'groups', ?, ?, ?)
    `).run(
      JSON.stringify([{ name: 'default', rate_multiplier: 1 }]),
      JSON.stringify([{ name: 'default', rate_multiplier: 1 }]),
      now
    );
    const taskId = Number(
      db.prepare(`
        INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
        VALUES (1, 'group_ratio_changed', 1, 1, 0, 60, 0, ?, ?)
      `).run(now, now).lastInsertRowid
    );
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockImplementation(async () => {
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'groups'
      `).run(
        JSON.stringify([{ name: 'default', rate_multiplier: 2 }]),
        JSON.stringify([{ name: 'default', rate_multiplier: 2 }]),
        nowIso()
      );
      return {
        profile: {},
        balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
        groups: [{ name: 'default', rate_multiplier: 2 }],
        tokens: [],
        raw: {}
      };
    });
    const mailer = vi.fn(async () => 'ok');

    await runDueTasks(db, mailer);

    const alert = db.prepare('SELECT type, message FROM alert_events').get() as { type: string; message: string };
    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(taskId) as { value_json: string };
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(alert.type).toBe('group_ratio_changed');
    expect(alert.message).toContain('default 1 -> 2');
    expect(JSON.parse(state.value_json)).toEqual([{ name: 'default', rate_multiplier: 2 }]);
    syncSpy.mockRestore();
    db.close();
  });
});
