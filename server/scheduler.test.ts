import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, nowIso } from './db.js';
import { evaluateGroupTask, evaluateTask, runDueTasks } from './scheduler.js';
import { runDueOwnedSiteTasks } from './ownedSites.js';
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
});
