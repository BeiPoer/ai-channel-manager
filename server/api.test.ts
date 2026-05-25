import http from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
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

    await agent
      .post(`/api/channels/${created.body.id}/tasks`)
      .send({ type: 'low_balance', threshold: 3 })
      .expect(201);

    const list = await agent.get('/api/channels').expect(200);
    expect(list.body[0].has_password).toBe(true);
    expect(list.body[0].password).toBe('p');

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
});
