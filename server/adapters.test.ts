import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { getTokenModels, syncChannel, updateTokenGroup } from './adapters.js';
import { createDatabase, nowIso } from './db.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;

const servers: http.Server[] = [];

async function startMock(handler: Handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
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

describe('channel adapters', () => {
  it('syncs sub2api profile, groups, paged tokens and subscriptions', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/v1/auth/login') return json(res, 200, { code: 0, data: { access_token: 'access-a', refresh_token: 'refresh-a' } });
      if (req.headers.authorization !== 'Bearer access-a') return json(res, 401, { message: 'unauthorized' });
      if (url.pathname === '/api/v1/auth/me') return json(res, 200, { code: 0, data: { id: 7, email: 'u@example.com', balance: 12.5 } });
      if (url.pathname === '/api/v1/groups/available') return json(res, 200, { code: 0, data: [{ id: 3, name: 'default', rate_multiplier: 1 }] });
      if (url.pathname === '/api/v1/groups/rates') return json(res, 200, { code: 0, data: { 3: 0.1 } });
      if (url.pathname === '/api/v1/keys') {
        const page = Number(url.searchParams.get('page'));
        return json(res, 200, { code: 0, data: { items: page === 1 ? [{ name: 'k1' }] : [], total: 1 } });
      }
      if (url.pathname === '/api/v1/subscriptions/active') return json(res, 200, { code: 0, data: [{ id: 1, plan: 'pro' }] });
      if (url.pathname === '/api/v1/subscriptions/summary') return json(res, 200, { code: 0, data: { active_count: 1 } });
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
      VALUES ('s', 'sub2api', ?, 'u@example.com', 'pw', 'syncing', ?, ?)
    `).run(baseUrl, now, now);

    await syncChannel(db, Number(result.lastInsertRowid));

    const snapshot = db.prepare('SELECT * FROM balance_snapshots').get() as { balance: number };
    const groups = db.prepare("SELECT normalized_json FROM channel_cache WHERE cache_key = 'groups'").get() as { normalized_json: string };
    const tokens = db.prepare("SELECT normalized_json FROM channel_cache WHERE cache_key = 'tokens'").get() as { normalized_json: string };
    const queryLog = db.prepare('SELECT * FROM balance_query_logs').get() as { status: string; balance: number; error: string | null };
    expect(snapshot.balance).toBe(12.5);
    expect(JSON.parse(groups.normalized_json)).toEqual([{ id: 3, name: 'default', rate_multiplier: 1, user_rate_multiplier: 0.1 }]);
    expect(JSON.parse(tokens.normalized_json)).toHaveLength(1);
    expect(queryLog).toMatchObject({ status: 'success', balance: 12.5, error: null });
    db.close();
  });

  it('fails sub2api sync and records a failed balance query when balance is missing', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/v1/auth/login') return json(res, 200, { code: 0, data: { access_token: 'access-a', refresh_token: 'refresh-a' } });
      if (req.headers.authorization !== 'Bearer access-a') return json(res, 401, { message: 'unauthorized' });
      if (url.pathname === '/api/v1/auth/me') return json(res, 200, { code: 0, data: { id: 7, email: 'u@example.com' } });
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
      VALUES ('s', 'sub2api', ?, 'u@example.com', 'pw', 'syncing', ?, ?)
    `).run(baseUrl, now, now);

    await expect(syncChannel(db, Number(result.lastInsertRowid))).rejects.toThrow(/balance/);

    const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM balance_snapshots').get() as { count: number };
    const queryLog = db.prepare('SELECT * FROM balance_query_logs').get() as { status: string; balance: number | null; error: string; raw_json: string };
    const channel = db.prepare('SELECT status, last_error FROM channels').get() as { status: string; last_error: string };
    expect(snapshotCount.count).toBe(0);
    expect(queryLog.status).toBe('error');
    expect(queryLog.balance).toBeNull();
    expect(queryLog.error).toContain('balance');
    expect(JSON.parse(queryLog.raw_json)).toEqual({ id: 7, email: 'u@example.com' });
    expect(channel.status).toBe('error');
    expect(channel.last_error).toContain('balance');
    db.close();
  });

  it('refreshes sub2api token after 401', async () => {
    let refreshed = false;
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/v1/auth/me' && req.headers.authorization === 'Bearer old') return json(res, 401, { message: 'expired' });
      if (url.pathname === '/api/v1/auth/refresh') {
        refreshed = true;
        return json(res, 200, { code: 0, data: { access_token: 'new', refresh_token: 'refresh' } });
      }
      if (req.headers.authorization !== 'Bearer new') return json(res, 401, { message: 'unauthorized' });
      if (url.pathname === '/api/v1/auth/me') return json(res, 200, { code: 0, data: { balance: 3 } });
      if (url.pathname === '/api/v1/groups/available') return json(res, 200, { code: 0, data: [] });
      if (url.pathname === '/api/v1/keys') return json(res, 200, { code: 0, data: { items: [], total: 0 } });
      if (url.pathname.startsWith('/api/v1/subscriptions/')) return json(res, 200, { code: 0, data: {} });
      return json(res, 404, {});
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, sub2api_access_token, sub2api_refresh_token, status, created_at, updated_at
      ) VALUES ('s', 'sub2api', ?, 'u', 'p', 'old', 'refresh', 'syncing', ?, ?)
    `).run(baseUrl, now, now);

    await syncChannel(db, Number(result.lastInsertRowid));

    const channel = db.prepare('SELECT sub2api_access_token FROM channels').get() as { sub2api_access_token: string };
    expect(refreshed).toBe(true);
    expect(channel.sub2api_access_token).toBe('new');
    db.close();
  });

  it('syncs new-api with Authorization and New-Api-User headers', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
      if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      if (url.pathname === '/api/status') return json(res, 200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } });
      if (url.pathname === '/api/user/self') {
        return json(res, 200, { success: true, data: { id: 42, quota: 1000000, used_quota: 250000, request_count: 3 } });
      }
      if (url.pathname === '/api/user/self/groups') return json(res, 200, { success: true, data: { default: { ratio: 1 } } });
      if (url.pathname === '/api/token/') return json(res, 200, { success: true, data: { items: [{ name: 'token-a' }], total: 1 } });
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'syncing', ?, ?)
    `).run(baseUrl, now, now);

    await syncChannel(db, Number(result.lastInsertRowid));

    const snapshot = db.prepare('SELECT * FROM balance_snapshots').get() as { balance: number; used_balance: number };
    const queryLog = db.prepare('SELECT * FROM balance_query_logs').get() as { status: string; balance: number; used_balance: number; unit: string };
    expect(snapshot.balance).toBe(2);
    expect(snapshot.used_balance).toBe(0.5);
    expect(queryLog).toMatchObject({ status: 'success', balance: 2, used_balance: 0.5, unit: 'new-api-USD' });
    db.close();
  });

  it('fails new-api sync and records a failed balance query when quota is missing', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
      if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      if (url.pathname === '/api/user/self') return json(res, 200, { success: true, data: { id: 42, used_quota: 250000 } });
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'syncing', ?, ?)
    `).run(baseUrl, now, now);

    await expect(syncChannel(db, Number(result.lastInsertRowid))).rejects.toThrow(/quota/);

    const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM balance_snapshots').get() as { count: number };
    const queryLog = db.prepare('SELECT * FROM balance_query_logs').get() as { status: string; balance: number | null; error: string; raw_json: string };
    expect(snapshotCount.count).toBe(0);
    expect(queryLog.status).toBe('error');
    expect(queryLog.balance).toBeNull();
    expect(queryLog.error).toContain('quota');
    expect(JSON.parse(queryLog.raw_json)).toEqual({ id: 42, used_quota: 250000 });
    db.close();
  });

  it('rejects record-only other channel sync and token capabilities without upstream requests', async () => {
    let requestCount = 0;
    const baseUrl = await startMock((_req, res) => {
      requestCount += 1;
      return json(res, 500, { message: 'other channels must not call upstream' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
      VALUES ('o', 'other', ?, 'u@example.com', 'pw', 'active', ?, ?)
    `).run(baseUrl, now, now);
    const channelId = Number(result.lastInsertRowid);

    await expect(syncChannel(db, channelId)).rejects.toThrow(/其它渠道/);
    await expect(updateTokenGroup(db, channelId, 1, { group_id: 1 })).rejects.toThrow(/其它渠道/);
    await expect(getTokenModels(db, channelId, 1)).rejects.toThrow(/其它渠道/);

    const channel = db.prepare('SELECT status, last_error, last_sync_at FROM channels WHERE id = ?').get(channelId) as {
      status: string;
      last_error: string | null;
      last_sync_at: string | null;
    };
    const queryLogCount = db.prepare('SELECT COUNT(*) AS count FROM balance_query_logs').get() as { count: number };
    expect(channel.status).toBe('active');
    expect(channel.last_error).toBeNull();
    expect(channel.last_sync_at).toBeNull();
    expect(queryLogCount.count).toBe(0);
    expect(requestCount).toBe(0);
    db.close();
  });

  it('migrates old new-api quota snapshots to display units when syncing', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
      if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      if (url.pathname === '/api/status') return json(res, 200, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'USD' } });
      if (url.pathname === '/api/user/self') return json(res, 200, { success: true, data: { id: 42, quota: 1500000, used_quota: 500000 } });
      if (url.pathname === '/api/user/self/groups') return json(res, 200, { success: true, data: {} });
      if (url.pathname === '/api/token/') return json(res, 200, { success: true, data: { items: [], total: 0 } });
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'syncing', ?, ?)
    `).run(baseUrl, now, now);
    const channelId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO balance_snapshots (channel_id, balance, used_balance, unit, raw_json, captured_at)
      VALUES (?, 1000000, 250000, 'new-api-quota', '{}', ?)
    `).run(channelId, now);

    await syncChannel(db, channelId);

    const snapshots = db.prepare('SELECT balance, used_balance, unit FROM balance_snapshots ORDER BY id ASC').all() as {
      balance: number;
      used_balance: number;
      unit: string;
    }[];
    expect(snapshots[0]).toEqual({ balance: 2, used_balance: 0.5, unit: 'new-api-USD' });
    expect(snapshots[1]).toEqual({ balance: 3, used_balance: 1, unit: 'new-api-USD' });
    db.close();
  });

  it('updates a sub2api token group without clearing IP rules', async () => {
    let updateBody: Record<string, unknown> | null = null;
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/v1/auth/login') return json(res, 200, { code: 0, data: { access_token: 'access-a', refresh_token: 'refresh-a' } });
      if (req.headers.authorization !== 'Bearer access-a') return json(res, 401, { message: 'unauthorized' });
      if (url.pathname === '/api/v1/keys/9' && req.method === 'GET') {
        return json(res, 200, { code: 0, data: { id: 9, name: 'key-a', group_id: 1, ip_whitelist: ['1.1.1.1'], ip_blacklist: ['2.2.2.2'] } });
      }
      if (url.pathname === '/api/v1/keys/9' && req.method === 'PUT') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          updateBody = JSON.parse(raw);
          json(res, 200, { code: 0, data: { id: 9, name: 'key-a', group_id: updateBody?.group_id } });
        });
        return;
      }
      if (url.pathname === '/api/v1/keys') return json(res, 200, { code: 0, data: { items: [{ id: 9, group_id: 2 }], total: 1 } });
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
      VALUES ('s', 'sub2api', ?, 'u@example.com', 'pw', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const updated = await updateTokenGroup(db, Number(result.lastInsertRowid), 9, { group_id: 2 });

    expect(updateBody).toEqual({ group_id: 2, ip_whitelist: ['1.1.1.1'], ip_blacklist: ['2.2.2.2'] });
    expect(updated.tokens).toEqual([{ id: 9, group_id: 2 }]);
    db.close();
  });

  it('updates a new-api token group while preserving editable fields', async () => {
    let updateBody: Record<string, unknown> | null = null;
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
      if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      if (url.pathname === '/api/token/11') {
        return json(res, 200, {
          success: true,
          data: {
            id: 11,
            name: 'token-a',
            expired_time: -1,
            remain_quota: 123,
            unlimited_quota: false,
            model_limits_enabled: true,
            model_limits: 'gpt-4o',
            allow_ips: '1.1.1.1',
            group: 'default',
            cross_group_retry: true
          }
        });
      }
      if (url.pathname === '/api/token/' && req.method === 'PUT') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += String(chunk);
        });
        req.on('end', () => {
          updateBody = JSON.parse(raw);
          json(res, 200, { success: true, data: { ...updateBody } });
        });
        return;
      }
      if (url.pathname === '/api/token/' && req.method === 'GET') {
        return json(res, 200, { success: true, data: { items: [{ id: 11, group: 'vip' }], total: 1 } });
      }
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const updated = await updateTokenGroup(db, Number(result.lastInsertRowid), 11, { group: 'vip' });

    expect(updateBody).toEqual({
      id: 11,
      name: 'token-a',
      expired_time: -1,
      remain_quota: 123,
      unlimited_quota: false,
      model_limits_enabled: true,
      model_limits: 'gpt-4o',
      allow_ips: '1.1.1.1',
      group: 'vip',
      cross_group_retry: true
    });
    expect(updated.tokens).toEqual([{ id: 11, group: 'vip' }]);
    db.close();
  });

  it('reads new-api token model limits', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
      if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      if (url.pathname === '/api/token/11') {
        return json(res, 200, {
          success: true,
          data: {
            id: 11,
            name: 'token-a',
            model_limits_enabled: true,
            model_limits: 'gpt-4o, claude-3-5-sonnet'
          }
        });
      }
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const models = await getTokenModels(db, Number(result.lastInsertRowid), 11);

    expect(models).toEqual({
      token_id: 11,
      token_name: 'token-a',
      source: 'token_limits',
      models: ['gpt-4o', 'claude-3-5-sonnet']
    });
    db.close();
  });

  it('reads new-api token models through the full token key endpoint', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/token/11' || url.pathname === '/api/token/11/key') {
        if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
        if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      }
      if (url.pathname === '/api/token/11') {
        return json(res, 200, {
          success: true,
          data: {
            id: 11,
            name: 'token-a',
            key: 'sk-toke**********1234',
            model_limits_enabled: false
          }
        });
      }
      if (url.pathname === '/api/token/11/key' && req.method === 'POST') {
        return json(res, 200, { success: true, data: { key: 'new-api-token-key' } });
      }
      if (url.pathname === '/v1/models') {
        if (req.headers.authorization !== 'Bearer sk-new-api-token-key') return json(res, 401, { error: { message: 'bad token' } });
        return json(res, 200, { object: 'list', data: [{ id: 'gpt-4o' }, { id: 'claude-sonnet-4-5' }] });
      }
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const models = await getTokenModels(db, Number(result.lastInsertRowid), 11);

    expect(models).toEqual({
      token_id: 11,
      token_name: 'token-a',
      source: 'upstream_models',
      models: ['gpt-4o', 'claude-sonnet-4-5']
    });
    db.close();
  });

  it('falls back to new-api channel models when token model endpoints are unavailable', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/token/11' || url.pathname === '/api/token/11/key' || url.pathname.startsWith('/api/channel/')) {
        if (req.headers.authorization !== 'Bearer system-token') return json(res, 401, { success: false, message: 'missing token' });
        if (req.headers['new-api-user'] !== '42') return json(res, 403, { success: false, message: 'bad user' });
      }
      if (url.pathname === '/api/token/11') {
        return json(res, 200, {
          success: true,
          data: {
            id: 11,
            name: 'token-a',
            model_limits_enabled: false
          }
        });
      }
      if (url.pathname === '/api/token/11/key') return json(res, 404, { success: false, message: 'not found' });
      if (url.pathname === '/api/user/self/models') return json(res, 404, { success: false, message: 'not found' });
      if (url.pathname === '/api/channel/models_enabled') {
        return json(res, 200, { success: true, data: ['gpt-4o-mini', 'gpt-5'] });
      }
      return json(res, 404, { success: false, message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'p', 'system-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const models = await getTokenModels(db, Number(result.lastInsertRowid), 11);

    expect(models).toEqual({
      token_id: 11,
      token_name: 'token-a',
      source: 'upstream_models',
      models: ['gpt-4o-mini', 'gpt-5']
    });
    db.close();
  });

  it('reads sub2api token models through the token key', async () => {
    const baseUrl = await startMock((req, res, url) => {
      if (url.pathname === '/api/v1/auth/login') return json(res, 200, { code: 0, data: { access_token: 'access-a', refresh_token: 'refresh-a' } });
      if (url.pathname === '/api/v1/keys/9') {
        if (req.headers.authorization !== 'Bearer access-a') return json(res, 401, { message: 'unauthorized' });
        return json(res, 200, { code: 0, data: { id: 9, name: 'token-s', key: 'sk-sub-token' } });
      }
      if (url.pathname === '/v1/models') {
        if (req.headers.authorization !== 'Bearer sk-sub-token') return json(res, 401, { message: 'bad token' });
        return json(res, 200, { object: 'list', data: [{ id: 'claude-sonnet-4-5' }, { id: 'gpt-5' }] });
      }
      return json(res, 404, { message: 'not found' });
    });
    const db = createDatabase(':memory:');
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
      VALUES ('s', 'sub2api', ?, 'u@example.com', 'pw', 'active', ?, ?)
    `).run(baseUrl, now, now);

    const models = await getTokenModels(db, Number(result.lastInsertRowid), 9);

    expect(models).toEqual({
      token_id: 9,
      token_name: 'token-s',
      source: 'upstream_models',
      models: ['claude-sonnet-4-5', 'gpt-5']
    });
    db.close();
  });
});
