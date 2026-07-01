import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, migrate, nowIso, setSetting } from './db.js';
import { evaluateGroupTask, evaluateTask, runDueTasks } from './scheduler.js';
import { filterSkippedModels, modelMatchesPattern, runDueOwnedSiteTasks, runDueOwnedSiteUpstreamMonitors } from './ownedSites.js';
import type { AutomationTaskRecord, BalanceSnapshot } from './types.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;

const servers: http.Server[] = [];

async function startMock(handler: Handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server failed');
  return `http://127.0.0.1:${address.port}`;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function timeOfDay(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function pauseWindowCovering(date: Date): { start: string; end: string } {
  const current = date.getHours() * 60 + date.getMinutes();
  return {
    start: timeOfDay(current - 5),
    end: timeOfDay(current + 5)
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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
  it('matches upstream monitor model wildcard patterns', () => {
    expect(modelMatchesPattern('gpt-image-1', 'gpt-image-*')).toBe(true);
    expect(modelMatchesPattern('gpt-4o', 'gpt-image-*')).toBe(false);
    expect(modelMatchesPattern('claude-3-5-haiku', 'claude-*')).toBe(true);
    expect(modelMatchesPattern('codex-auto-review', 'codex-auto-review')).toBe(true);
    expect(filterSkippedModels(['gpt-4o', 'gpt-image-1', 'claude-3'], ['gpt-image-*', 'claude-3'])).toEqual({
      tested: ['gpt-4o'],
      skipped: ['gpt-image-1', 'claude-3']
    });
  });

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

  it('does not alert when channel sync fails during balance query', async () => {
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
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockRejectedValue(new Error('余额查询失败：profile.balance 缺失'));
    const mailer = vi.fn(async () => 'ok');

    await runDueTasks(db, mailer);

    const alertCount = db.prepare('SELECT COUNT(*) AS count FROM alert_events').get() as { count: number };
    const taskRow = db.prepare('SELECT last_run_at FROM automation_tasks WHERE channel_id = 1').get() as { last_run_at: string | null };
    expect(alertCount.count).toBe(0);
    expect(mailer).not.toHaveBeenCalled();
    expect(taskRow.last_run_at).toBeTruthy();
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
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'tokens', ?, ?, ?)
    `).run(JSON.stringify([{ id: 9, group: { name: 'default' } }]), JSON.stringify([{ id: 9, group: { name: 'default' } }]), now);
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
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'tokens'
      `).run(JSON.stringify([{ id: 9, group: { name: 'default' } }]), JSON.stringify([{ id: 9, group: { name: 'default' } }]), nowIso());
      return {
        profile: {},
        balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
        groups: [
          { name: 'default', ratio: 2 },
          { name: 'vip', ratio: 0.8 }
        ],
        tokens: [{ id: 9, group: { name: 'default' } }],
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
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'tokens', ?, ?, ?)
    `).run(JSON.stringify([{ id: 9, group: { name: 'default' } }]), JSON.stringify([{ id: 9, group: { name: 'default' } }]), now);
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
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'tokens'
      `).run(JSON.stringify([{ id: 9, group: { name: 'default' } }]), JSON.stringify([{ id: 9, group: { name: 'default' } }]), nowIso());
      return {
        profile: {},
        balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
        groups: [{ name: 'default', rate_multiplier: 2 }],
        tokens: [{ id: 9, group: { name: 'default' } }],
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

  it('ignores ratio changes for groups that are not used by current tokens', async () => {
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
      JSON.stringify([
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 1 }
      ]),
      JSON.stringify([
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 1 }
      ]),
      now
    );
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (1, 'tokens', ?, ?, ?)
    `).run(JSON.stringify([{ id: 9, group_id: 1 }]), JSON.stringify([{ id: 9, group_id: 1 }]), now);
    const taskId = Number(
      db.prepare(`
        INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
        VALUES (1, 'group_ratio_changed', 1, 1, 0, 60, 0, ?, ?)
      `).run(now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO automation_task_state (task_id, state_key, value_json, updated_at)
      VALUES (?, 'groups', ?, ?)
    `).run(
      taskId,
      JSON.stringify([
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 1 }
      ]),
      now
    );
    const syncSpy = vi.spyOn(await import('./adapters.js'), 'syncChannel');
    syncSpy.mockImplementation(async () => {
      const groups = [
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 2 }
      ];
      const tokens = [{ id: 9, group_id: 1 }];
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'groups'
      `).run(JSON.stringify(groups), JSON.stringify(groups), nowIso());
      db.prepare(`
        UPDATE channel_cache
        SET raw_json = ?, normalized_json = ?, synced_at = ?
        WHERE channel_id = 1 AND cache_key = 'tokens'
      `).run(JSON.stringify(tokens), JSON.stringify(tokens), nowIso());
      return {
        profile: {},
        balanceSnapshot: { balance: 1, unit: 'quota', raw: {} },
        groups,
        tokens,
        raw: {}
      };
    });
    const mailer = vi.fn(async () => 'ok');

    await runDueTasks(db, mailer);

    const alertCount = db.prepare('SELECT COUNT(*) AS count FROM alert_events').get() as { count: number };
    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(taskId) as { value_json: string };
    expect(mailer).not.toHaveBeenCalled();
    expect(alertCount.count).toBe(0);
    expect(JSON.parse(state.value_json)).toEqual([{ id: 1, name: 'default', rate_multiplier: 1 }]);
    syncSpy.mockRestore();
    db.close();
  });

  it('builds owned-site account baseline before alerting on error transitions', async () => {
    let accountStatus = 'active';
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts/11') {
        return json(res, 200, { code: 0, data: { id: 11, name: 'acc-a', status: accountStatus, error_message: accountStatus === 'error' ? 'token expired' : '' } });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_account_id, target_account_name,
        interval_minutes, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'account_error', 1, 'account', '11', 'acc-a', 1, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(0);

    accountStatus = 'error';
    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    const alert = db.prepare('SELECT account_id, before_status, after_status, message FROM owned_site_alert_events').get() as {
      account_id: string;
      before_status: string;
      after_status: string;
      message: string;
    };
    expect(alert.account_id).toBe('11');
    expect(alert.before_status).toBe('active');
    expect(alert.after_status).toBe('error');
    expect(alert.message).toContain('token expired');

    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('alerts once when an owned-site account is already error on first run', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts/11') {
        return json(res, 200, { code: 0, data: { id: 11, name: 'acc-a', status: 'error', error_message: 'token revoked' } });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_account_id,
        interval_minutes, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'account_error', 1, 'account', '11', 1, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    const alert = db.prepare('SELECT account_id, before_status, after_status, message FROM owned_site_alert_events').get() as {
      account_id: string;
      before_status: string | null;
      after_status: string;
      message: string;
    };
    expect(alert.account_id).toBe('11');
    expect(alert.before_status).toBeNull();
    expect(alert.after_status).toBe('error');
    expect(alert.message).toContain('首次检查');
    expect(alert.message).toContain('token revoked');

    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('alerts for owned-site group accounts and records email failures', async () => {
    let statuses = ['active', 'active'];
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 11, name: 'acc-a', status: statuses[0], group_ids: [url.searchParams.get('group')], error_message: statuses[0] === 'error' ? 'bad a' : '' },
              { id: 12, name: 'acc-b', status: statuses[1], group_ids: [url.searchParams.get('group')], error_message: statuses[1] === 'error' ? 'bad b' : '' }
            ],
            total: 2,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, target_group_name,
        interval_minutes, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'account_error', 1, 'group', '7', 'vip', 1, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => {
      throw new Error('smtp failed');
    });

    await runDueOwnedSiteTasks(db, mailer);
    statuses = ['error', 'error'];
    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);

    const alerts = db.prepare('SELECT account_id, email_sent, email_error FROM owned_site_alert_events ORDER BY account_id').all() as Array<{
      account_id: string;
      email_sent: number;
      email_error: string;
    }>;
    expect(alerts.map((alert) => alert.account_id)).toEqual(['11', '12']);
    expect(alerts.every((alert) => alert.email_sent === 0)).toBe(true);
    expect(alerts.every((alert) => alert.email_error.includes('smtp failed'))).toBe(true);
    db.close();
  });

  it('alerts for owned-site group accounts already error on first run', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 11, name: 'acc-a', status: 'error', group_ids: [url.searchParams.get('group')], error_message: 'bad a' },
              { id: 12, name: 'acc-b', status: 'active', group_ids: [url.searchParams.get('group')] },
              { id: 13, name: 'acc-c', status: 'error', group_ids: [url.searchParams.get('group')], error_message: 'bad c' }
            ],
            total: 3,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, target_group_name,
        interval_minutes, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'account_error', 1, 'group', '7', 'vip', 1, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    const alerts = db.prepare('SELECT account_id, before_status, after_status, message FROM owned_site_alert_events ORDER BY account_id').all() as Array<{
      account_id: string;
      before_status: string | null;
      after_status: string;
      message: string;
    }>;
    expect(alerts.map((alert) => alert.account_id)).toEqual(['11', '13']);
    expect(alerts.every((alert) => alert.before_status === null)).toBe(true);
    expect(alerts.every((alert) => alert.after_status === 'error')).toBe(true);
    expect(alerts[0].message).toContain('首次检查');

    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(2);
    db.close();
  });

  it('marks owned site error when upstream polling fails without creating false alerts', async () => {
    const baseUrl = await startMock((_req, res) => {
      json(res, 500, { message: 'upstream down' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_account_id,
        interval_minutes, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'account_error', 1, 'account', '11', 1, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);

    const site = db.prepare('SELECT status, last_error FROM owned_sites WHERE id = 1').get() as { status: string; last_error: string };
    expect(site.status).toBe('error');
    expect(site.last_error).toContain('upstream down');
    expect(mailer).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(0);
    db.close();
  });

  it('alerts when owned-site group first token latency breaches the configured threshold', async () => {
    const usageRequests: URL[] = [];
    const now = new Date();
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/usage') {
        usageRequests.push(url);
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 1, request_id: 'r1', model: 'gpt-5', group_id: 7, group: { id: 7, name: 'vip' }, first_token_ms: 6200, created_at: nowIso(new Date(now.getTime() - 60_000)) },
              { id: 2, request_id: 'r2', model: 'gpt-5', group_id: 7, group: { id: 7, name: 'vip' }, first_token_ms: 5100, created_at: nowIso(new Date(now.getTime() - 120_000)) },
              { id: 3, request_id: 'r3', model: 'gpt-5', group_id: 8, group: { id: 8, name: 'backup' }, first_token_ms: 5400, created_at: nowIso(new Date(now.getTime() - 150_000)) },
              { id: 4, request_id: 'r4', model: 'gpt-5', group_id: 7, group_name: 'vip', first_token_ms: 1200, created_at: nowIso(new Date(now.getTime() - 180_000)) }
            ],
            total: 4,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const created = nowIso(now);
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, created, created);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, target_group_name,
        interval_minutes, lookback_minutes, sample_size, breach_count, latency_threshold_ms,
        cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'group_first_token_latency', 1, 'group', '7', 'vip', 1, 10, 4, 2, 5000, 0, ?, ?)
    `).run(created, created);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);

    expect(mailer).toHaveBeenCalledTimes(1);
    expect(usageRequests).toHaveLength(1);
    expect(usageRequests[0].searchParams.get('group_id')).toBe('7');
    expect(usageRequests[0].searchParams.get('page')).toBe('1');
    expect(usageRequests[0].searchParams.get('page_size')).toBe('1000');
    expect(usageRequests[0].searchParams.get('sort_by')).toBe('created_at');
    expect(usageRequests[0].searchParams.get('sort_order')).toBe('desc');
    const alert = db.prepare('SELECT type, target_type, target_id, account_id, before_status, after_status, message, snapshot_json FROM owned_site_alert_events').get() as {
      type: string;
      target_type: string;
      target_id: string;
      account_id: string | null;
      before_status: string | null;
      after_status: string;
      message: string;
      snapshot_json: string;
    };
    expect(alert.type).toBe('group_first_token_latency');
    expect(alert.target_type).toBe('group');
    expect(alert.target_id).toBe('7');
    expect(alert.account_id).toBeNull();
    expect(alert.before_status).toBeNull();
    expect(alert.after_status).toBe('slow_first_token');
    expect(alert.message).toContain('近 4 次请求有 3 次首 Token 耗时超过 5 秒');
    expect(alert.message).toContain('慢请求分组：【vip * 2】、【backup * 1】');
    expect(JSON.parse(alert.snapshot_json)).toMatchObject({
      sample_count: 4,
      slow_count: 3,
      slow_group_counts: [
        { name: 'vip', count: 2 },
        { name: 'backup', count: 1 }
      ],
      task: {
        target_group_id: '7',
        sample_size: 4,
        breach_count: 2,
        latency_threshold_ms: 5000
      }
    });
    db.close();
  });

  it('does not alert when owned-site first token samples are insufficient and ignores null first token values', async () => {
    const now = new Date();
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/usage') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 1, request_id: 'r1', group_id: 7, first_token_ms: null, created_at: nowIso(new Date(now.getTime() - 60_000)) },
              { id: 2, request_id: 'r2', group_id: 7, created_at: nowIso(new Date(now.getTime() - 120_000)) },
              { id: 3, request_id: 'r3', group_id: 7, first_token_ms: 9000, created_at: nowIso(new Date(now.getTime() - 180_000)) }
            ],
            total: 3,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const created = nowIso(now);
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, created, created);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, interval_minutes, lookback_minutes,
        sample_size, breach_count, latency_threshold_ms, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'group_first_token_latency', 1, 'group', '7', 1, 10, 2, 1, 5000, 0, ?, ?)
    `).run(created, created);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);

    expect(mailer).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(0);
    db.close();
  });

  it('honors cooldown for owned-site first token latency alerts', async () => {
    const now = new Date();
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/usage') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 1, first_token_ms: 9000, created_at: nowIso(new Date(now.getTime() - 60_000)) },
              { id: 2, first_token_ms: 8000, created_at: nowIso(new Date(now.getTime() - 120_000)) }
            ],
            total: 2,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const created = nowIso(now);
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, created, created);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, interval_minutes, lookback_minutes,
        sample_size, breach_count, latency_threshold_ms, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'group_first_token_latency', 1, 'group', '7', 1, 10, 2, 1, 5000, 60, ?, ?)
    `).run(created, created);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);
    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = NULL WHERE site_id = 1').run();
    await runDueOwnedSiteTasks(db, mailer);

    expect(mailer).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('marks owned site error when first token latency usage polling fails', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/usage') return json(res, 500, { message: 'usage down' });
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_group_id, interval_minutes, lookback_minutes,
        sample_size, breach_count, latency_threshold_ms, cooldown_minutes, created_at, updated_at
      ) VALUES (1, 'group_first_token_latency', 1, 'group', '7', 1, 10, 2, 1, 5000, 0, ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteTasks(db, mailer);

    const site = db.prepare('SELECT status, last_error FROM owned_sites WHERE id = 1').get() as { status: string; last_error: string };
    expect(site.status).toBe('error');
    expect(site.last_error).toContain('usage down');
    expect(mailer).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(0);
    db.close();
  });

  it('migrates old owned-site automation tasks and allows first token latency tasks', () => {
    const db = createDatabase(':memory:');
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE owned_site_automation_tasks;
      CREATE TABLE owned_site_automation_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'account_error' CHECK (type IN ('account_error')),
        enabled INTEGER NOT NULL DEFAULT 1,
        target_type TEXT NOT NULL CHECK (target_type IN ('account', 'group')),
        target_account_id TEXT,
        target_account_name TEXT,
        target_group_id TEXT,
        target_group_name TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 30,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        recipients_json TEXT,
        last_run_at TEXT,
        last_alert_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA foreign_keys = ON;
    `);
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', 'https://owned.example.com', 'admin-key', 'active', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        id, site_id, type, enabled, target_type, target_account_id, target_account_name,
        interval_minutes, cooldown_minutes, recipients_json, last_run_at, last_alert_at, created_at, updated_at
      ) VALUES (9, 1, 'account_error', 1, 'account', '11', 'acc-a', 1, 30, '[]', ?, ?, ?, ?)
    `).run(now, now, now, now);

    migrate(db);

    const existing = db.prepare('SELECT * FROM owned_site_automation_tasks WHERE id = 9').get() as {
      type: string;
      lookback_minutes: number;
      sample_size: number;
      breach_count: number;
      latency_threshold_ms: number;
    };
    expect(existing).toMatchObject({
      type: 'account_error',
      lookback_minutes: 10,
      sample_size: 20,
      breach_count: 5,
      latency_threshold_ms: 7000
    });
    expect(() =>
      db.prepare(`
        INSERT INTO owned_site_automation_tasks (
          site_id, type, target_type, target_group_id, created_at, updated_at
        ) VALUES (1, 'group_first_token_latency', 'group', '7', ?, ?)
      `).run(now, now)
    ).not.toThrow();
    db.close();
  });

  it('runs due owned-site upstream monitors and records model results', async () => {
    const requests: Array<{ path: string; body: string }> = [];
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [
              { id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] },
              { id: 12, name: 'inactive', platform: 'openai', type: 'apikey', status: 'inactive', group_ids: [url.searchParams.get('group')] },
              { id: 13, name: 'gemini', platform: 'gemini', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] }
            ],
            total: 3,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      if (url.pathname === '/api/v1/admin/accounts/11') {
        return json(res, 200, { code: 0, data: { id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: ['7'] } });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/models') {
        return json(res, 200, { code: 0, data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1-mini' }, { id: 'gpt-image-1' }, { id: 'codex-auto-review' }] });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/test') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          requests.push({ path: url.pathname, body });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"type":"test_complete","success":true,"message":"ok"}\n\n');
        });
        return;
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_group_monitors (site_id, group_id, group_name, enabled, created_at, updated_at)
      VALUES (1, '7', 'vip', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_monitors (
        site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json, created_at, updated_at
      ) VALUES (1, '11', 'acc-a', 'openai', 'apikey', '["7"]', 0, 10, 2, '00:00', '00:00', '["gpt-image-*","codex-auto-review"]', ?, ?)
    `).run(now, now);

    await runDueOwnedSiteUpstreamMonitors(db);

    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[0].body)).toEqual({ model_id: 'gpt-4o' });
    expect(JSON.parse(requests[1].body)).toEqual({ model_id: 'gpt-4.1-mini' });
    const monitor = db.prepare('SELECT last_status, last_error FROM owned_site_upstream_monitors WHERE site_id = 1 AND account_id = ?').get('11') as {
      last_status: string;
      last_error: string | null;
    };
    expect(monitor.last_status).toBe('success');
    expect(monitor.last_error).toBeNull();
    const results = db.prepare('SELECT model, status FROM owned_site_upstream_monitor_results ORDER BY id ASC').all() as Array<{ model: string | null; status: string }>;
    expect(results).toEqual([
      { model: 'gpt-image-1', status: 'skipped' },
      { model: 'codex-auto-review', status: 'skipped' },
      { model: 'gpt-4o', status: 'success' },
      { model: 'gpt-4.1-mini', status: 'success' }
    ]);
    db.close();
  });

  it('skips due upstream monitor tests during configured pause window', async () => {
    const requests: Array<{ path: string; body: string }> = [];
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [{ id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] }],
            total: 1,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/test') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          requests.push({ path: url.pathname, body });
          json(res, 200, { success: true, message: 'ok' });
        });
        return;
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const pause = pauseWindowCovering(new Date());
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_group_monitors (site_id, group_id, group_name, enabled, created_at, updated_at)
      VALUES (1, '7', 'vip', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_monitors (
        site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json, last_run_at, created_at, updated_at
      ) VALUES (1, '11', 'acc-a', 'openai', 'apikey', '["7"]', 0, 1, 2, ?, ?, '[]', ?, ?, ?)
    `).run(pause.start, pause.end, nowIso(new Date(Date.now() - 10 * 60000)), now, now);

    await runDueOwnedSiteUpstreamMonitors(db);

    expect(requests).toHaveLength(0);
    const monitor = db.prepare('SELECT last_status FROM owned_site_upstream_monitors WHERE site_id = 1 AND account_id = ?').get('11') as {
      last_status: string | null;
    };
    expect(monitor.last_status).toBeNull();
    const count = db.prepare('SELECT COUNT(*) AS count FROM owned_site_upstream_monitor_results').get() as { count: number };
    expect(count.count).toBe(0);
    db.close();
  });

  it('sends owned-site upstream alert email when a model fails all retry attempts', async () => {
    const requests: Array<{ path: string; body: string }> = [];
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [{ id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] }],
            total: 1,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      if (url.pathname === '/api/v1/admin/accounts/11') {
        return json(res, 200, { code: 0, data: { id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: ['7'] } });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/models') {
        return json(res, 200, { code: 0, data: [{ id: 'gpt-4o' }] });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/test') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          requests.push({ path: url.pathname, body });
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"type":"error","success":false,"message":"model down"}\n\n');
        });
        return;
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    setSetting(db, 'default_recipients', 'ops@example.com');
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_group_monitors (site_id, group_id, group_name, enabled, created_at, updated_at)
      VALUES (1, '7', 'vip', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_alert_settings (site_id, enabled, created_at, updated_at)
      VALUES (1, 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_monitors (
        site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json, created_at, updated_at
      ) VALUES (1, '11', 'acc-a', 'openai', 'apikey', '["7"]', 0, 10, 2, '00:00', '00:00', '[]', ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteUpstreamMonitors(db, mailer);

    expect(requests).toHaveLength(3);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(mailer.mock.calls[0][1]).toEqual(['ops@example.com']);
    expect(mailer.mock.calls[0][2]).toBe('AI 自有站点上游监控预警');
    expect(mailer.mock.calls[0][3]).toContain('gpt-4o');
    const alert = db.prepare('SELECT type, account_id, after_status, email_sent, email_error, snapshot_json FROM owned_site_alert_events').get() as {
      type: string;
      account_id: string;
      after_status: string;
      email_sent: number;
      email_error: string | null;
      snapshot_json: string;
    };
    expect(alert.type).toBe('upstream_monitor_failed');
    expect(alert.account_id).toBe('11');
    expect(alert.after_status).toBe('failed');
    expect(alert.email_sent).toBe(1);
    expect(alert.email_error).toBeNull();
    expect(JSON.parse(alert.snapshot_json)).toMatchObject({
      model: 'gpt-4o',
      attempt_count: 3,
      success_count: 0,
      failure_count: 3
    });

    await runDueOwnedSiteUpstreamMonitors(db, mailer);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('does not send owned-site upstream alert email when the alert switch is off', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') return json(res, 401, { code: 401, message: 'bad key' });
      if (url.pathname === '/api/v1/admin/accounts') {
        return json(res, 200, {
          code: 0,
          data: {
            items: [{ id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] }],
            total: 1,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        });
      }
      if (url.pathname === '/api/v1/admin/accounts/11') {
        return json(res, 200, { code: 0, data: { id: 11, name: 'acc-a', platform: 'openai', type: 'apikey', status: 'active', group_ids: ['7'] } });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/models') {
        return json(res, 200, { code: 0, data: [{ id: 'gpt-4o' }] });
      }
      if (url.pathname === '/api/v1/admin/accounts/11/test') {
        req.on('data', () => undefined);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"type":"error","success":false,"message":"model down"}\n\n');
        });
        return;
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    db.prepare(`
      INSERT INTO owned_sites (id, name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (1, 'owned', 'sub2api', ?, 'admin-key', 'active', ?, ?)
    `).run(baseUrl, now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_group_monitors (site_id, group_id, group_name, enabled, created_at, updated_at)
      VALUES (1, '7', 'vip', 1, ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO owned_site_upstream_monitors (
        site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json, created_at, updated_at
      ) VALUES (1, '11', 'acc-a', 'openai', 'apikey', '["7"]', 0, 10, 2, '00:00', '00:00', '[]', ?, ?)
    `).run(now, now);
    const mailer = vi.fn(async () => 'ok');

    await runDueOwnedSiteUpstreamMonitors(db, mailer);

    expect(mailer).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS count FROM owned_site_alert_events').get() as { count: number }).count).toBe(0);
    db.close();
  });
});
