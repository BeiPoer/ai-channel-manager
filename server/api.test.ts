import http from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { createApp } from './routes.js';

const servers: http.Server[] = [];

async function startSub2apiMock() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/v1/auth/login') return res.end(JSON.stringify({ code: 0, data: { access_token: 'a', refresh_token: 'r' } }));
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
  it('creates a channel, exposes channel password and cascades delete', async () => {
    const baseUrl = await startSub2apiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db);

    const created = await request(app)
      .post('/api/channels')
      .send({ type: 'sub2api', base_url: baseUrl, username: 'u', password: 'p', name: 'mock' })
      .expect(201);

    expect(created.body.has_password).toBe(true);
    expect(created.body.password).toBe('p');

    await request(app)
      .post(`/api/channels/${created.body.id}/tasks`)
      .send({ type: 'low_balance', threshold: 3 })
      .expect(201);

    const list = await request(app).get('/api/channels').expect(200);
    expect(list.body[0].has_password).toBe(true);
    expect(list.body[0].password).toBe('p');

    await request(app).delete(`/api/channels/${created.body.id}`).expect(204);
    const taskCount = db.prepare('SELECT COUNT(*) AS count FROM automation_tasks').get() as { count: number };
    const cacheCount = db.prepare('SELECT COUNT(*) AS count FROM channel_cache').get() as { count: number };
    expect(taskCount.count).toBe(0);
    expect(cacheCount.count).toBe(0);
    db.close();
  });

  it('keeps existing sensitive values when update sends blank fields', async () => {
    const baseUrl = await startSub2apiMock();
    const db = createDatabase(':memory:');
    const app = createApp(db);
    const created = await request(app)
      .post('/api/channels')
      .send({ type: 'sub2api', base_url: baseUrl, username: 'u', password: 'p', name: 'mock' })
      .expect(201);

    await request(app).put(`/api/channels/${created.body.id}`).send({ name: 'renamed', password: '' }).expect(200);

    const row = db.prepare('SELECT name, password FROM channels WHERE id = ?').get(created.body.id) as { name: string; password: string };
    expect(row.name).toBe('renamed');
    expect(row.password).toBe('p');
    db.close();
  });
});
