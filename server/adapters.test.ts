import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { syncChannel } from './adapters.js';
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
      if (url.pathname === '/api/v1/groups/available') return json(res, 200, { code: 0, data: [{ name: 'default' }] });
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
    const tokens = db.prepare("SELECT normalized_json FROM channel_cache WHERE cache_key = 'tokens'").get() as { normalized_json: string };
    expect(snapshot.balance).toBe(12.5);
    expect(JSON.parse(tokens.normalized_json)).toHaveLength(1);
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
      if (url.pathname === '/api/user/self') return json(res, 200, { success: true, data: { id: 42, quota: 99, used_quota: 8, request_count: 3 } });
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
    expect(snapshot.balance).toBe(99);
    expect(snapshot.used_balance).toBe(8);
    db.close();
  });
});

