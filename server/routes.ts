import path from 'node:path';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createUpstreamLoginUrl, normalizeBaseUrl, syncChannel, updateTokenGroup } from './adapters.js';
import { clearSessionCookie, isAuthenticated, requireAuth, setSessionCookie, verifyAccessPassword } from './auth.js';
import type { AppConfig } from './config.js';
import { getChannel, getSetting, nowIso, parseJson, parseTask, sanitizeChannel, splitRecipients } from './db.js';
import { getEmailSettings, saveEmailSettings, sendEmail } from './email.js';
import { UpstreamError } from './http.js';
import type { AutomationTaskRecord, AutomationTaskType, ChannelRecord, ChannelType } from './types.js';

type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;

function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new UpstreamError('无效的 ID', 400);
  return id;
}

function ensureChannel(db: DatabaseSync, id: number): ChannelRecord {
  const channel = getChannel(db, id);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  return channel;
}

function listCache(db: DatabaseSync, channelId: number, key: string, fallback: unknown) {
  const row = db.prepare('SELECT normalized_json FROM channel_cache WHERE channel_id = ? AND cache_key = ?').get(channelId, key) as
    | { normalized_json: string }
    | undefined;
  return parseJson(row?.normalized_json, fallback);
}

const taskTypes: AutomationTaskType[] = ['low_balance', 'burn_rate', 'group_added', 'group_removed', 'group_ratio_changed'];

function isTaskType(value: unknown): value is AutomationTaskType {
  return typeof value === 'string' && taskTypes.includes(value as AutomationTaskType);
}

function isGroupTaskType(value: unknown): boolean {
  return value === 'group_added' || value === 'group_removed' || value === 'group_ratio_changed';
}

function taskPayload(body: Record<string, unknown>, partial = false) {
  const type = body.type;
  if (!partial && !isTaskType(type)) throw new UpstreamError('任务类型无效', 400);
  if (partial && type !== undefined && !isTaskType(type)) throw new UpstreamError('任务类型无效', 400);
  const threshold = body.threshold === undefined ? undefined : Number(body.threshold);
  if (!partial && !isGroupTaskType(type) && (threshold === undefined || !Number.isFinite(threshold))) throw new UpstreamError('预警阈值无效', 400);
  if (threshold !== undefined && !Number.isFinite(threshold)) throw new UpstreamError('预警阈值无效', 400);
  return {
    type: type as AutomationTaskType | undefined,
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled) ? 1 : 0,
    interval_minutes: body.interval_minutes === undefined ? undefined : Math.max(1, Number(body.interval_minutes) || 30),
    threshold,
    lookback_minutes: body.lookback_minutes === undefined ? undefined : Math.max(1, Number(body.lookback_minutes) || 60),
    cooldown_minutes: body.cooldown_minutes === undefined ? undefined : Math.max(0, Number(body.cooldown_minutes) || 0),
    recipients_json: body.recipients === undefined ? undefined : JSON.stringify(splitRecipients(body.recipients))
  };
}

function normalizeChannelInput(body: Record<string, unknown>, existing?: ChannelRecord) {
  const type = (body.type || existing?.type) as ChannelType;
  if (type !== 'sub2api' && type !== 'newapi') throw new UpstreamError('渠道类型无效', 400);
  const baseUrl = body.base_url !== undefined ? normalizeBaseUrl(String(body.base_url)) : existing?.base_url;
  if (!baseUrl) throw new UpstreamError('站点链接不能为空', 400);
  return {
    name: String(body.name || existing?.name || '').trim() || `${type} ${new URL(baseUrl).host}`,
    type,
    base_url: baseUrl,
    username: body.username !== undefined ? String(body.username || '').trim() || null : existing?.username || null,
    password: body.password !== undefined && String(body.password) !== '' ? String(body.password) : existing?.password || null,
    newapi_access_token:
      body.newapi_access_token !== undefined && String(body.newapi_access_token) !== ''
        ? String(body.newapi_access_token)
        : existing?.newapi_access_token || null,
    newapi_user_id: body.newapi_user_id !== undefined ? String(body.newapi_user_id || '').trim() || null : existing?.newapi_user_id || null
  };
}

export function createApp(db: DatabaseSync, config: AppConfig): express.Express {
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({ authenticated: isAuthenticated(req, config) });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!verifyAccessPassword(config, req.body?.password)) {
      res.status(401).json({ error: '密码错误' });
      return;
    }
    setSessionCookie(res, config);
    res.json({ authenticated: true });
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res, config);
    res.json({ authenticated: false });
  });

  app.use(requireAuth(config));

  app.get('/api/channels', (_req, res) => {
    const rows = db.prepare('SELECT * FROM channels ORDER BY updated_at DESC, id DESC').all() as unknown as ChannelRecord[];
    res.json(rows.map(sanitizeChannel));
  });

  app.post('/api/channels', asyncRoute(async (req, res) => {
    const input = normalizeChannelInput(req.body || {});
    if (input.type === 'sub2api' && (!input.username || !input.password)) {
      throw new UpstreamError('sub2api 渠道需要账号和密码', 400);
    }
    if (input.type === 'newapi' && (!input.newapi_access_token || !input.newapi_user_id)) {
      throw new UpstreamError('new-api 渠道需要系统访问令牌和 userId', 400);
    }
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'syncing', ?, ?)
    `).run(input.name, input.type, input.base_url, input.username, input.password, input.newapi_access_token, input.newapi_user_id, now, now);
    const id = Number(result.lastInsertRowid);
    try {
      await syncChannel(db, id);
      res.status(201).json(sanitizeChannel(ensureChannel(db, id)));
    } catch (error) {
      db.prepare('DELETE FROM channels WHERE id = ?').run(id);
      throw error;
    }
  }));

  app.put('/api/channels/:id', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const existing = ensureChannel(db, id);
    const input = normalizeChannelInput(req.body || {}, existing);
    db.prepare(`
      UPDATE channels
      SET name = ?, base_url = ?, username = ?, password = ?, newapi_access_token = ?, newapi_user_id = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name, input.base_url, input.username, input.password, input.newapi_access_token, input.newapi_user_id, nowIso(), id);
    if (req.body?.sync === true) await syncChannel(db, id);
    res.json(sanitizeChannel(ensureChannel(db, id)));
  }));

  app.delete('/api/channels/:id', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    res.status(204).end();
  });

  app.post('/api/channels/:id/sync', asyncRoute(async (req, res) => {
    const id = idParam(req);
    await syncChannel(db, id);
    res.json({ channel: sanitizeChannel(ensureChannel(db, id)) });
  }));

  app.get('/api/channels/:id/upstream-login', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const loginUrl = await createUpstreamLoginUrl(db, id);
    res.redirect(302, loginUrl);
  }));

  app.get('/api/channels/:id/overview', (req, res) => {
    const id = idParam(req);
    const channel = ensureChannel(db, id);
    const latest = db.prepare('SELECT * FROM balance_snapshots WHERE channel_id = ? ORDER BY captured_at DESC LIMIT 1').get(id);
    const history = db.prepare('SELECT * FROM balance_snapshots WHERE channel_id = ? ORDER BY captured_at DESC LIMIT 30').all(id).reverse();
    res.json({
      channel: sanitizeChannel(channel),
      profile: listCache(db, id, 'profile', null),
      groups: listCache(db, id, 'groups', []),
      tokens: listCache(db, id, 'tokens', []),
      subscriptions: channel.type === 'sub2api' ? listCache(db, id, 'subscriptions', null) : null,
      latest_snapshot: latest || null,
      history
    });
  });

  app.get('/api/channels/:id/groups', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    res.json(listCache(db, id, 'groups', []));
  });

  app.get('/api/channels/:id/tokens', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    res.json(listCache(db, id, 'tokens', []));
  });

  app.put('/api/channels/:id/tokens/:tokenId/group', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0) throw new UpstreamError('无效的令牌 ID', 400);
    const result = await updateTokenGroup(db, id, tokenId, req.body || {});
    res.json({
      channel: sanitizeChannel(ensureChannel(db, id)),
      token: result.token,
      tokens: result.tokens
    });
  }));

  app.get('/api/channels/:id/subscriptions', (req, res) => {
    const id = idParam(req);
    const channel = ensureChannel(db, id);
    res.json(channel.type === 'sub2api' ? listCache(db, id, 'subscriptions', null) : null);
  });

  app.get('/api/channels/:id/balance-history', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const rows = db.prepare('SELECT * FROM balance_snapshots WHERE channel_id = ? ORDER BY captured_at ASC LIMIT 200').all(id);
    res.json(rows);
  });

  app.get('/api/channels/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const rows = db.prepare('SELECT * FROM automation_tasks WHERE channel_id = ? ORDER BY id DESC').all(id) as unknown as AutomationTaskRecord[];
    res.json(rows.map(parseTask));
  });

  app.post('/api/channels/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const payload = taskPayload(req.body || {});
    if (!isGroupTaskType(payload.type) && payload.threshold === undefined) throw new UpstreamError('预警阈值无效', 400);
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO automation_tasks (
        channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, recipients_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      payload.type || 'low_balance',
      payload.enabled ?? 1,
      payload.interval_minutes ?? (Number(getSetting(db, 'default_interval_minutes', '30')) || 30),
      payload.threshold ?? 0,
      payload.lookback_minutes ?? 60,
      payload.cooldown_minutes ?? 60,
      payload.recipients_json ?? JSON.stringify([]),
      now,
      now
    );
    const row = db.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as AutomationTaskRecord;
    res.status(201).json(parseTask(row));
  });

  app.put('/api/channels/:id/tasks/:taskId', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const taskId = Number(req.params.taskId);
    const existing = db.prepare('SELECT * FROM automation_tasks WHERE id = ? AND channel_id = ?').get(taskId, id) as unknown as AutomationTaskRecord | undefined;
    if (!existing) throw new UpstreamError('任务不存在', 404);
    const payload = taskPayload(req.body || {}, true);
    db.prepare(`
      UPDATE automation_tasks
      SET type = ?, enabled = ?, interval_minutes = ?, threshold = ?, lookback_minutes = ?, cooldown_minutes = ?, recipients_json = ?, updated_at = ?
      WHERE id = ? AND channel_id = ?
    `).run(
      payload.type ?? existing.type,
      payload.enabled ?? existing.enabled,
      payload.interval_minutes ?? existing.interval_minutes,
      payload.threshold ?? existing.threshold,
      payload.lookback_minutes ?? existing.lookback_minutes,
      payload.cooldown_minutes ?? existing.cooldown_minutes,
      payload.recipients_json ?? existing.recipients_json,
      nowIso(),
      taskId,
      id
    );
    const row = db.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(taskId) as unknown as AutomationTaskRecord;
    res.json(parseTask(row));
  });

  app.delete('/api/channels/:id/tasks/:taskId', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    db.prepare('DELETE FROM automation_tasks WHERE id = ? AND channel_id = ?').run(Number(req.params.taskId), id);
    res.status(204).end();
  });

  app.get('/api/alerts', (req, res) => {
    const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
    const rows = channelId
      ? db.prepare(`
          SELECT a.*, c.name AS channel_name
          FROM alert_events a
          JOIN channels c ON c.id = a.channel_id
          WHERE a.channel_id = ?
          ORDER BY a.created_at DESC
          LIMIT 200
        `).all(channelId)
      : db.prepare(`
          SELECT a.*, c.name AS channel_name
          FROM alert_events a
          JOIN channels c ON c.id = a.channel_id
          ORDER BY a.created_at DESC
          LIMIT 200
        `).all();
    res.json(rows);
  });

  app.get('/api/settings/email', (_req, res) => {
    res.json(getEmailSettings(db));
  });

  app.put('/api/settings/email', (req, res) => {
    res.json(saveEmailSettings(db, req.body || {}));
  });

  app.post('/api/settings/email/test', asyncRoute(async (req, res) => {
    const recipient = splitRecipients(req.body?.recipient || req.body?.recipients);
    const recipients = recipient.length ? recipient : getEmailSettings(db).default_recipients;
    const messageId = await sendEmail(db, recipients, 'AI 渠道管理台测试邮件', '这是一封测试邮件。');
    res.json({ ok: true, message_id: messageId });
  }));

  const clientDir = path.join(process.cwd(), 'dist', 'client');
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res, next) => {
    res.sendFile(path.join(clientDir, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof UpstreamError ? error.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: error.message || '服务器内部错误'
    });
  });

  return app;
}
