import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, migrate } from './db.js';
import { createApp } from './routes.js';
import type { AppConfig } from './config.js';

const servers: http.Server[] = [];
const testConfig: AppConfig = {
  accessPassword: 'test-password',
  sessionSecret: 'test-session-secret',
  sessionTtlHours: 24,
  secureCookies: false
};

async function startSub2apiMock() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/auth/login') return res.end(JSON.stringify({ code: 0, data: { access_token: 'a', refresh_token: 'r' } }));
    if (url.pathname === '/api/v1/auth/refresh') return res.end(JSON.stringify({ code: 0, data: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 } }));
    if (url.pathname === '/api/v1/auth/me') return res.end(JSON.stringify({ code: 0, data: { id: 1, balance: 5 } }));
    if (url.pathname === '/api/v1/groups/available') return res.end(JSON.stringify({ code: 0, data: [] }));
    if (url.pathname === '/api/v1/keys') return res.end(JSON.stringify({ code: 0, data: { items: [], total: 0 } }));
    if (url.pathname.startsWith('/api/v1/subscriptions/')) return res.end(JSON.stringify({ code: 0, data: {} }));
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return `http://127.0.0.1:${address.port}`;
}

async function startNewApiMock() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer system-token') {
      res.writeHead(401);
      return res.end(JSON.stringify({ success: false, message: 'missing token' }));
    }
    if (req.headers['new-api-user'] !== '42') {
      res.writeHead(403);
      return res.end(JSON.stringify({ success: false, message: 'bad user' }));
    }
    if (url.pathname === '/api/token/11') {
      return res.end(JSON.stringify({
        success: true,
        data: {
          id: 11,
          name: 'token-a',
          model_limits_enabled: true,
          model_limits: 'gpt-4o,gpt-5'
        }
      }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return `http://127.0.0.1:${address.port}`;
}

async function startNewApiUnauthorizedMock() {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(401);
    res.end(JSON.stringify({ success: false, message: 'No permission to perform this operation, not logged in and no access token provided' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return `http://127.0.0.1:${address.port}`;
}

async function startOwnedSub2apiMock(handler?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean | void) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    const handled = handler?.(req, res, url);
    if (handled) return;
    if (req.headers['x-api-key'] !== 'admin-key') {
      res.writeHead(401);
      return res.end(JSON.stringify({ code: 401, message: 'bad admin key' }));
    }
    if (url.pathname === '/api/v1/admin/groups/all') {
      return res.end(JSON.stringify({ code: 0, data: [{ id: 1, name: 'default', platform: 'openai', status: 'active' }] }));
    }
    if (url.pathname === '/api/v1/admin/accounts') {
      return res.end(JSON.stringify({
        code: 0,
        data: {
          items: [
            {
              id: 11,
              name: 'account-a',
              platform: 'openai',
              type: 'oauth',
              status: 'active',
              group_ids: [String(url.searchParams.get('group') || '1')]
            }
          ],
          total: 1,
          page: Number(url.searchParams.get('page') || 1),
          page_size: Number(url.searchParams.get('page_size') || 20),
          pages: 1
        }
      }));
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock failed');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('local API', () => {
  it('requires login before accessing protected APIs', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);

    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/channels').expect(401);
    await request(app).post('/api/auth/login').send({ password: 'wrong' }).expect(401);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    await agent.get('/api/channels').expect(200);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/channels').expect(401);
    db.close();
  });

  it('keeps the local session when channel sync receives an upstream 401', async () => {
    const baseUrl = await startNewApiUnauthorizedMock();
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const channelId = Number(db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'bad-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now).lastInsertRowid);

    const response = await agent.post(`/api/channels/${channelId}/sync`).expect(502);
    expect(response.body.error).toBe('No permission to perform this operation, not logged in and no access token provided');

    const channels = await agent.get('/api/channels').expect(200);
    expect(channels.body[0]).toMatchObject({
      id: channelId,
      status: 'error',
      last_error: 'No permission to perform this operation, not logged in and no access token provided'
    });
    db.close();
  });

  it('creates channels, exposes channel credentials and cascades delete', async () => {
    const baseUrl = await startSub2apiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);

    const created = await agent
      .post('/api/channels')
      .send({ type: 'sub2api', base_url: baseUrl, username: 'u', password: 'p', name: 'mock' })
      .expect(201);

    expect(created.body.has_password).toBe(true);
    expect(created.body.password).toBe('p');
    expect(created.body.ignored).toBe(false);

    await agent.put(`/api/channels/${created.body.id}`).send({ ignored: 'false' }).expect(400);
    const ignored = await agent.put(`/api/channels/${created.body.id}`).send({ ignored: true }).expect(200);
    expect(ignored.body.ignored).toBe(true);

    await agent
      .post(`/api/channels/${created.body.id}/tasks`)
      .send({ type: 'low_balance', threshold: 3 })
      .expect(201)
      .expect(({ body }) => {
        expect(body.interval_minutes).toBe(5);
        expect(body.cooldown_minutes).toBe(30);
      });

    const list = await agent.get('/api/channels').expect(200);
    expect(list.body[0].has_password).toBe(true);
    expect(list.body[0].password).toBe('p');
    expect(list.body[0].ignored).toBe(true);

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', 'https://new-api.example.com', 'u', 'system-token', '1', 'active', ?, ?)
    `).run(now, now);

    const withNewApi = await agent.get('/api/channels').expect(200);
    const newApiChannel = withNewApi.body.find((channel: { type: string }) => channel.type === 'newapi');
    expect(newApiChannel.has_newapi_access_token).toBe(true);
    expect(newApiChannel.newapi_access_token).toBe('system-token');

    await agent.delete(`/api/channels/${created.body.id}`).expect(204);
    const taskCount = db.prepare('SELECT COUNT(*) AS count FROM automation_tasks').get() as { count: number };
    const cacheCount = db.prepare('SELECT COUNT(*) AS count FROM channel_cache').get() as { count: number };
    expect(taskCount.count).toBe(0);
    expect(cacheCount.count).toBe(0);
    db.close();
  });

  it('creates record-only other channels without syncing upstream capabilities', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);

    const created = await agent
      .post('/api/channels')
      .send({ type: 'other', base_url: 'https://other.example.com/', username: 'u', password: 'p', name: 'record only' })
      .expect(201);

    expect(created.body).toMatchObject({
      type: 'other',
      status: 'active',
      last_sync_at: null,
      last_error: null,
      has_password: true,
      password: 'p'
    });

    const cacheCount = db.prepare('SELECT COUNT(*) AS count FROM channel_cache').get() as { count: number };
    const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM balance_snapshots').get() as { count: number };
    const queryLogCount = db.prepare('SELECT COUNT(*) AS count FROM balance_query_logs').get() as { count: number };
    expect(cacheCount.count).toBe(0);
    expect(snapshotCount.count).toBe(0);
    expect(queryLogCount.count).toBe(0);

    const overview = await agent.get(`/api/channels/${created.body.id}/overview`).expect(200);
    expect(overview.body).toMatchObject({
      profile: null,
      groups: [],
      tokens: [],
      subscriptions: null,
      latest_snapshot: null,
      history: []
    });

    const sync = await agent.post(`/api/channels/${created.body.id}/sync`).expect(400);
    expect(sync.body.error).toContain('其它渠道');
    const task = await agent.post(`/api/channels/${created.body.id}/tasks`).send({ type: 'low_balance', threshold: 1 }).expect(400);
    expect(task.body.error).toContain('其它渠道');
    const login = await agent.get(`/api/channels/${created.body.id}/upstream-login`).expect(400);
    expect(login.body.error).toContain('当前仅支持 sub2api');
    db.close();
  });

  it('migrates existing channel type constraints to allow other channels', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('sub2api', 'newapi')),
        base_url TEXT NOT NULL,
        username TEXT,
        password TEXT,
        newapi_access_token TEXT,
        newapi_user_id TEXT,
        sub2api_access_token TEXT,
        sub2api_refresh_token TEXT,
        sub2api_token_expires_at INTEGER,
        status TEXT NOT NULL DEFAULT 'syncing',
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    migrate(db);
    const now = new Date().toISOString();
    expect(() => {
      db.prepare(`
        INSERT INTO channels (name, type, base_url, username, password, status, created_at, updated_at)
        VALUES ('o', 'other', 'https://other.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now, now);
    }).not.toThrow();
    const channel = db.prepare("SELECT ignored FROM channels WHERE type = 'other'").get() as { ignored: number };
    expect(channel.ignored).toBe(0);
    db.close();
  });

  it('keeps existing sensitive values when update sends blank fields', async () => {
    const baseUrl = await startSub2apiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const created = await agent
      .post('/api/channels')
      .send({ type: 'sub2api', base_url: baseUrl, username: 'u', password: 'p', name: 'mock' })
      .expect(201);

    await agent.put(`/api/channels/${created.body.id}`).send({ name: 'renamed', password: '' }).expect(200);

    const row = db.prepare('SELECT name, password FROM channels WHERE id = ?').get(created.body.id) as { name: string; password: string };
    expect(row.name).toBe('renamed');
    expect(row.password).toBe('p');
    db.close();
  });

  it('redirects sub2api channels to the upstream callback with login tokens', async () => {
    const baseUrl = await startSub2apiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const created = await agent
      .post('/api/channels')
      .send({ type: 'sub2api', base_url: baseUrl, username: 'u', password: 'p', name: 'mock' })
      .expect(201);

    const response = await agent.get(`/api/channels/${created.body.id}/upstream-login`).expect(302);
    const location = response.headers.location as string;
    expect(location.startsWith(`${baseUrl}/auth/oauth/callback#`)).toBe(true);

    const fragment = new URLSearchParams(location.split('#')[1]);
    expect(fragment.get('access_token')).toBe('a2');
    expect(fragment.get('refresh_token')).toBe('r2');
    expect(fragment.get('token_type')).toBe('Bearer');
    expect(fragment.get('redirect')).toBe('/dashboard');
    expect(Number(fragment.get('expires_in'))).toBeGreaterThan(0);
    db.close();
  });

  it('returns paginated channel balance query logs', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date('2026-06-05T08:00:00.000Z');
    const channelId = Number(
      db.prepare(`
        INSERT INTO channels (
          name, type, base_url, username, password, status, created_at, updated_at
        ) VALUES ('s', 'sub2api', 'https://sub2api.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now.toISOString(), now.toISOString()).lastInsertRowid
    );
    for (let index = 0; index < 12; index += 1) {
      const createdAt = new Date(now.getTime() + index * 60000).toISOString();
      db.prepare(`
        INSERT INTO balance_query_logs (
          channel_id, status, balance, used_balance, unit, message, error, raw_json, created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        channelId,
        index % 2 === 0 ? 'success' : 'error',
        index % 2 === 0 ? index : null,
        index % 2 === 0 ? 'sub2api-balance' : null,
        index % 2 === 0 ? '余额查询成功' : '余额查询失败',
        index % 2 === 0 ? null : `error-${index}`,
        JSON.stringify({ index }),
        createdAt
      );
    }

    const firstPage = await agent.get(`/api/channels/${channelId}/balance-query-logs`).expect(200);
    const secondPage = await agent.get(`/api/channels/${channelId}/balance-query-logs?page=2`).expect(200);

    expect(firstPage.body).toMatchObject({ total: 12, page: 1, page_size: 10, pages: 2 });
    expect(firstPage.body.items).toHaveLength(10);
    expect(firstPage.body.items[0]).toMatchObject({ status: 'error', error: 'error-11' });
    expect(firstPage.body.items[9]).toMatchObject({ status: 'success', balance: 2 });
    expect(secondPage.body).toMatchObject({ total: 12, page: 2, page_size: 10, pages: 2 });
    expect(secondPage.body.items).toHaveLength(2);
    db.close();
  });

  it('rejects upstream login for new-api channels', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', 'https://new-api.example.com', 'u', 'token', '1', 'active', ?, ?)
    `).run(now, now);

    const response = await agent.get(`/api/channels/${Number(result.lastInsertRowid)}/upstream-login`).expect(400);
    expect(response.body.error).toContain('当前仅支持 sub2api');
    db.close();
  });

  it('returns token model list for a channel token', async () => {
    const baseUrl = await startNewApiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const channelId = Number(db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES ('n', 'newapi', ?, 'u', 'system-token', '42', 'active', ?, ?)
    `).run(baseUrl, now, now).lastInsertRowid);

    const response = await agent.get(`/api/channels/${channelId}/tokens/11/models`).expect(200);

    expect(response.body).toEqual({
      token_id: 11,
      token_name: 'token-a',
      source: 'token_limits',
      models: ['gpt-4o', 'gpt-5']
    });
    db.close();
  });

  it('seeds group task baseline from current channel cache', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const channelId = Number(
      db.prepare(`
        INSERT INTO channels (
          name, type, base_url, username, password, status, created_at, updated_at
        ) VALUES ('s', 'sub2api', 'https://sub2api.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (?, 'groups', ?, ?, ?)
    `).run(channelId, JSON.stringify([{ name: 'vip' }]), JSON.stringify([{ name: 'vip' }]), now);

    const response = await agent.post(`/api/channels/${channelId}/tasks`).send({ type: 'group_removed' }).expect(201);

    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(response.body.id) as
      | { value_json: string }
      | undefined;
    expect(state).toBeTruthy();
    expect(JSON.parse(state?.value_json || '[]')).toEqual([{ name: 'vip' }]);
    db.close();
  });

  it('seeds group ratio task baseline from token-used groups only', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const channelId = Number(
      db.prepare(`
        INSERT INTO channels (
          name, type, base_url, username, password, status, created_at, updated_at
        ) VALUES ('s', 'sub2api', 'https://sub2api.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (?, 'groups', ?, ?, ?)
    `).run(
      channelId,
      JSON.stringify([
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 2 }
      ]),
      JSON.stringify([
        { id: 1, name: 'default', rate_multiplier: 1 },
        { id: 2, name: 'vip', rate_multiplier: 2 }
      ]),
      now
    );
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (?, 'tokens', ?, ?, ?)
    `).run(channelId, JSON.stringify([{ id: 9, group_id: 2 }]), JSON.stringify([{ id: 9, group_id: 2 }]), now);

    const response = await agent.post(`/api/channels/${channelId}/tasks`).send({ type: 'group_ratio_changed' }).expect(201);

    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(response.body.id) as
      | { value_json: string }
      | undefined;
    expect(state).toBeTruthy();
    expect(JSON.parse(state?.value_json || '[]')).toEqual([{ id: 2, name: 'vip', rate_multiplier: 2 }]);
    db.close();
  });

  it('does not reset group task baseline when updating unrelated task fields', async () => {
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const now = new Date().toISOString();
    const channelId = Number(
      db.prepare(`
        INSERT INTO channels (
          name, type, base_url, username, password, status, created_at, updated_at
        ) VALUES ('s', 'sub2api', 'https://sub2api.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now, now).lastInsertRowid
    );
    const taskId = Number(
      db.prepare(`
        INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
        VALUES (?, 'group_removed', 1, 1, 0, 60, 0, ?, ?)
      `).run(channelId, now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO automation_task_state (task_id, state_key, value_json, updated_at)
      VALUES (?, 'groups', ?, ?)
    `).run(taskId, JSON.stringify([{ name: 'old' }]), now);
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (?, 'groups', ?, ?, ?)
    `).run(channelId, JSON.stringify([{ name: 'current' }]), JSON.stringify([{ name: 'current' }]), now);

    await agent.put(`/api/channels/${channelId}/tasks/${taskId}`).send({ interval_minutes: 5 }).expect(200);

    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(taskId) as { value_json: string };
    expect(JSON.parse(state.value_json)).toEqual([{ name: 'old' }]);
    db.close();
  });

  it('seeds existing group task state during migration', () => {
    const db = createDatabase(':memory:');
    const now = new Date().toISOString();
    const channelId = Number(
      db.prepare(`
        INSERT INTO channels (
          name, type, base_url, username, password, status, created_at, updated_at
        ) VALUES ('s', 'sub2api', 'https://sub2api.example.com', 'u', 'p', 'active', ?, ?)
      `).run(now, now).lastInsertRowid
    );
    const taskId = Number(
      db.prepare(`
        INSERT INTO automation_tasks (channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, created_at, updated_at)
        VALUES (?, 'group_added', 1, 1, 0, 60, 0, ?, ?)
      `).run(channelId, now, now).lastInsertRowid
    );
    db.prepare(`
      INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
      VALUES (?, 'groups', ?, ?, ?)
    `).run(channelId, JSON.stringify([{ name: 'current' }]), JSON.stringify([{ name: 'current' }]), now);

    migrate(db);

    const state = db.prepare("SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = 'groups'").get(taskId) as { value_json: string };
    expect(JSON.parse(state.value_json)).toEqual([{ name: 'current' }]);
    db.close();
  });

  it('manages owned sub2api sites and proxies paginated accounts', async () => {
    let accountQuery: URLSearchParams | null = null;
    const baseUrl = await startOwnedSub2apiMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 401, message: 'bad admin key' }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/groups/all') {
        res.end(JSON.stringify({ code: 0, data: [{ id: 9, name: 'vip', platform: 'openai', status: 'active' }] }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/accounts') {
        accountQuery = url.searchParams;
        res.end(JSON.stringify({
          code: 0,
          data: {
            items: [{ id: 22, name: 'acc-b', platform: 'openai', type: 'oauth', status: 'active', group_ids: [url.searchParams.get('group')] }],
            total: 1,
            page: 2,
            page_size: 5,
            pages: 1
          }
        }));
        return true;
      }
      return false;
    });
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    await request(app).get('/api/owned-sites').expect(401);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);

    const created = await agent
      .post('/api/owned-sites')
      .send({ type: 'sub2api', base_url: baseUrl, name: 'owned', admin_api_key: 'admin-key' })
      .expect(201);
    expect(created.body.has_admin_api_key).toBe(true);
    expect(created.body.status).toBe('active');

    const accounts = await agent
      .get(`/api/owned-sites/${created.body.id}/accounts?page=2&page_size=5&search=acc&group=9&status=active&sort_by=name&sort_order=desc`)
      .expect(200);
    expect(accounts.body.items[0].id).toBe('22');
    expect(accountQuery?.get('page')).toBe('2');
    expect(accountQuery?.get('page_size')).toBe('5');
    expect(accountQuery?.get('search')).toBe('acc');
    expect(accountQuery?.get('group')).toBe('9');
    expect(accountQuery?.get('status')).toBe('active');
    expect(accountQuery?.get('sort_by')).toBe('name');
    expect(accountQuery?.get('sort_order')).toBe('desc');

    await agent.put(`/api/owned-sites/${created.body.id}`).send({ name: 'renamed', admin_api_key: '' }).expect(200);
    const row = db.prepare('SELECT name, admin_api_key FROM owned_sites WHERE id = ?').get(created.body.id) as { name: string; admin_api_key: string };
    expect(row.name).toBe('renamed');
    expect(row.admin_api_key).toBe('admin-key');

    await agent
      .post(`/api/owned-sites/${created.body.id}/tasks`)
      .send({ target_type: 'group', target_group_id: '9', target_group_name: 'vip', interval_minutes: 5, cooldown_minutes: 10 })
      .expect(201);
    const defaultLatencyTask = await agent
      .post(`/api/owned-sites/${created.body.id}/tasks`)
      .send({ type: 'group_first_token_latency', target_type: 'group', target_group_id: '9', target_group_name: 'vip' })
      .expect(201);
    expect(defaultLatencyTask.body).toMatchObject({
      type: 'group_first_token_latency',
      target_type: 'group',
      target_group_id: '9',
      lookback_minutes: 10,
      sample_size: 20,
      breach_count: 5,
      latency_threshold_ms: 7000,
      cooldown_minutes: 10
    });
    const latencyTask = await agent
      .post(`/api/owned-sites/${created.body.id}/tasks`)
      .send({
        type: 'group_first_token_latency',
        target_type: 'group',
        target_group_id: '9',
        target_group_name: 'vip',
        interval_minutes: 1,
        lookback_minutes: 15,
        sample_size: 12,
        breach_count: 4,
        latency_threshold_ms: 6500,
        cooldown_minutes: 20
      })
      .expect(201);
    expect(latencyTask.body).toMatchObject({
      type: 'group_first_token_latency',
      target_type: 'group',
      target_group_id: '9',
      lookback_minutes: 15,
      sample_size: 12,
      breach_count: 4,
      latency_threshold_ms: 6500
    });
    await agent
      .post(`/api/owned-sites/${created.body.id}/tasks`)
      .send({ type: 'group_first_token_latency', target_type: 'account', target_account_id: '22' })
      .expect(400);
    await agent
      .post(`/api/owned-sites/${created.body.id}/tasks`)
      .send({ type: 'group_first_token_latency', target_type: 'group', target_group_id: '9', sample_size: 2, breach_count: 3 })
      .expect(400);
    await agent.delete(`/api/owned-sites/${created.body.id}`).expect(204);
    const taskCount = db.prepare('SELECT COUNT(*) AS count FROM owned_site_automation_tasks').get() as { count: number };
    expect(taskCount.count).toBe(0);
    db.close();
  });

  it('manages owned-site upstream monitor configs and run history', async () => {
    const testBodies: unknown[] = [];
    const attemptsByModel = new Map<string, number>();
    const baseUrl = await startOwnedSub2apiMock((req, res, url) => {
      if (req.headers['x-api-key'] !== 'admin-key') {
        res.writeHead(401);
        res.end(JSON.stringify({ code: 401, message: 'bad admin key' }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/groups/all') {
        res.end(JSON.stringify({ code: 0, data: [{ id: 9, name: 'vip', platform: 'openai', status: 'active' }] }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/accounts') {
        res.end(JSON.stringify({
          code: 0,
          data: {
            items: [
              { id: 22, name: 'openai-key', platform: 'openai', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] },
              { id: 23, name: 'claude-key', platform: 'anthropic', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] },
              { id: 24, name: 'oauth', platform: 'openai', type: 'oauth', status: 'active', group_ids: [url.searchParams.get('group')] },
              { id: 25, name: 'inactive', platform: 'openai', type: 'apikey', status: 'inactive', group_ids: [url.searchParams.get('group')] },
              { id: 26, name: 'gemini-key', platform: 'gemini', type: 'apikey', status: 'active', group_ids: [url.searchParams.get('group')] }
            ],
            total: 5,
            page: 1,
            page_size: 1000,
            pages: 1
          }
        }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/accounts/22') {
        res.end(JSON.stringify({ code: 0, data: { id: 22, name: 'openai-key', platform: 'openai', type: 'apikey', status: 'active', group_ids: ['9'] } }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/accounts/22/models') {
        res.end(JSON.stringify({ code: 0, data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1-mini' }, { id: 'gpt-image-1' }, { id: 'codex-auto-review' }] }));
        return true;
      }
      if (url.pathname === '/api/v1/admin/accounts/22/test') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const parsedBody = JSON.parse(body || '{}') as { model_id?: string };
          testBodies.push(parsedBody);
          const modelId = parsedBody.model_id || '';
          const attempt = (attemptsByModel.get(modelId) || 0) + 1;
          attemptsByModel.set(modelId, attempt);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (modelId === 'gpt-4.1-mini' && attempt === 1) {
            res.end('data: {"type":"error","success":false,"message":"first failed"}\n\n');
            return;
          }
          res.end('data: {"type":"test_complete","success":true,"message":"ok"}\n\n');
        });
        return true;
      }
      return false;
    });
    const db = createDatabase(':memory:');
    const app = createApp(db, testConfig);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ password: 'test-password' }).expect(200);
    const created = await agent
      .post('/api/owned-sites')
      .send({ type: 'sub2api', base_url: baseUrl, name: 'owned', admin_api_key: 'admin-key' })
      .expect(201);

    const list = await agent.get(`/api/owned-sites/${created.body.id}/upstream/accounts?group=9`).expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.map((item: { account: { id: string } }) => item.account.id)).toEqual(['22', '23']);
    expect(list.body[0].group_monitor.enabled).toBe(false);
    expect(list.body[0].monitor.interval_minutes).toBe(10);
    expect(list.body[0].monitor.pause_start_time).toBe('01:00');
    expect(list.body[0].monitor.pause_end_time).toBe('08:00');
    expect(list.body[0].monitor.skip_model_patterns).toEqual(['gpt-image-*', 'codex-auto-review']);
    const openaiBeforeRun = list.body.find((item: { account: { id: string } }) => item.account.id === '22');
    expect(openaiBeforeRun.model_timelines.map((item: { model: string }) => item.model)).toEqual(['gpt-4o', 'gpt-4.1-mini']);
    expect(openaiBeforeRun.model_timelines[0].timeline).toHaveLength(12);
    expect(openaiBeforeRun.model_timelines[0].timeline[0].bucket_minutes).toBe(10);

    const groupSaved = await agent
      .put(`/api/owned-sites/${created.body.id}/upstream/groups/9/monitor`)
      .send({ enabled: true })
      .expect(200);
    expect(groupSaved.body).toMatchObject({ group_id: '9', group_name: 'vip', enabled: true });

    const alertSetting = await agent.get(`/api/owned-sites/${created.body.id}/upstream/alert-setting`).expect(200);
    expect(alertSetting.body).toMatchObject({ site_id: created.body.id, enabled: false });
    const savedAlertSetting = await agent
      .put(`/api/owned-sites/${created.body.id}/upstream/alert-setting`)
      .send({ enabled: true })
      .expect(200);
    expect(savedAlertSetting.body).toMatchObject({ site_id: created.body.id, enabled: true });

    const saved = await agent
      .put(`/api/owned-sites/${created.body.id}/upstream/accounts/22/monitor`)
      .send({ interval_minutes: 5, retry_count: 2, pause_start_time: '23:30', pause_end_time: '6:05', skip_model_patterns: 'gpt-image-*' })
      .expect(200);
    expect(saved.body).toMatchObject({
      interval_minutes: 5,
      retry_count: 2,
      pause_start_time: '23:30',
      pause_end_time: '06:05',
      skip_model_patterns: ['gpt-image-*']
    });

    const run = await agent.post(`/api/owned-sites/${created.body.id}/upstream/accounts/22/monitor/run`).expect(200);
    expect(run.body.status).toBe('partial');
    expect(run.body.tested_models).toEqual(['gpt-4o', 'gpt-4.1-mini']);
    expect(run.body.skipped_models).toEqual(['gpt-image-1', 'codex-auto-review']);
    expect(testBodies).toEqual([{ model_id: 'gpt-4o' }, { model_id: 'gpt-4.1-mini' }, { model_id: 'gpt-4.1-mini' }]);
    expect(run.body.results.find((item: { model: string }) => item.model === 'gpt-4.1-mini')).toMatchObject({
      status: 'partial',
      attempt_count: 2,
      success_count: 1,
      failure_count: 1
    });

    const afterRun = await agent.get(`/api/owned-sites/${created.body.id}/upstream/accounts?group=9`).expect(200);
    const openai = afterRun.body.find((item: { account: { id: string } }) => item.account.id === '22');
    expect(openai.monitor.last_status).toBe('partial');
    expect(openai.latest_result.status).toBe('partial');
    expect(openai.model_timelines).toHaveLength(2);
    expect(openai.model_timelines[0].model).toBe('gpt-4o');
    expect(openai.model_timelines[0].timeline).toHaveLength(24);
    expect(openai.model_timelines[0].timeline[0].bucket_minutes).toBe(5);
    expect(openai.model_timelines[0].timeline.some((point: { status: string }) => point.status === 'success')).toBe(true);
    expect(openai.model_timelines[1].model).toBe('gpt-4.1-mini');
    const partialPoint = openai.model_timelines[1].timeline.find((point: { status: string }) => point.status === 'partial');
    expect(partialPoint).toMatchObject({ attempt_count: 2, success_count: 1, failure_count: 1 });
    db.close();
  });
});
