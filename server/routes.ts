import path from 'node:path';
import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createUpstreamLoginUrl, getTokenModels, normalizeBaseUrl, syncChannel, updateTokenGroup } from './adapters.js';
import { clearSessionCookie, isAuthenticated, requireAuth, setSessionCookie, verifyAccessPassword } from './auth.js';
import type { AppConfig } from './config.js';
import {
  getChannel,
  getOwnedSite,
  getSetting,
  nowIso,
  parseOwnedSiteTask,
  parseTask,
  readChannelCache,
  sanitizeChannel,
  sanitizeOwnedSite,
  splitRecipients,
  upsertTaskState
} from './db.js';
import { getEmailSettings, saveEmailSettings, sendEmail } from './email.js';
import { UpstreamError } from './http.js';
import {
  checkOwnedSite,
  fetchOwnedSiteAccounts,
  fetchOwnedSiteGroups,
  getOwnedSiteUpstreamAlertSetting,
  getOwnedSiteUpstreamGroupMonitor,
  getOwnedSiteUpstreamMonitor,
  listOwnedSiteUpstreamAccounts,
  normalizeOwnedSiteBaseUrl,
  normalizeOwnedSiteTaskPayload,
  runOwnedSiteUpstreamMonitor,
  saveOwnedSiteUpstreamGroupMonitor,
  saveOwnedSiteUpstreamAlertSetting,
  saveOwnedSiteUpstreamMonitor
} from './ownedSites.js';
import { filterGroupsByTokenUsage } from './groupMonitoring.js';
import type { AutomationTaskRecord, AutomationTaskType, ChannelRecord, ChannelType, OwnedSiteAutomationTaskRecord, OwnedSiteRecord, OwnedSiteType } from './types.js';

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

function textParam(value: string | string[] | undefined, label: string): string {
  const text = Array.isArray(value) ? value[0] : value;
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new UpstreamError(`${label}无效`, 400);
  return trimmed;
}

function ensureChannel(db: DatabaseSync, id: number): ChannelRecord {
  const channel = getChannel(db, id);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  return channel;
}

function ensureOwnedSite(db: DatabaseSync, id: number): OwnedSiteRecord {
  const site = getOwnedSite(db, id);
  if (!site) throw new UpstreamError('自有站点不存在', 404);
  return site;
}

function listCache(db: DatabaseSync, channelId: number, key: string, fallback: unknown) {
  return readChannelCache(db, channelId, key, fallback).value;
}

function positiveQueryInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const taskTypes: AutomationTaskType[] = ['low_balance', 'burn_rate', 'group_added', 'group_removed', 'group_ratio_changed'];
const groupTaskStateKey = 'groups';
const taskTimingDefaults: Record<AutomationTaskType, { interval_minutes: number; cooldown_minutes: number }> = {
  low_balance: { interval_minutes: 5, cooldown_minutes: 30 },
  burn_rate: { interval_minutes: 30, cooldown_minutes: 60 },
  group_added: { interval_minutes: 30, cooldown_minutes: 60 },
  group_removed: { interval_minutes: 30, cooldown_minutes: 60 },
  group_ratio_changed: { interval_minutes: 30, cooldown_minutes: 60 }
};

function isTaskType(value: unknown): value is AutomationTaskType {
  return typeof value === 'string' && taskTypes.includes(value as AutomationTaskType);
}

function isGroupTaskType(value: unknown): boolean {
  return value === 'group_added' || value === 'group_removed' || value === 'group_ratio_changed';
}

function seedGroupTaskState(db: DatabaseSync, taskId: number, channelId: number, taskType: AutomationTaskType): void {
  const groups = readChannelCache(db, channelId, 'groups', []);
  if (!groups.exists) return;
  if (taskType !== 'group_ratio_changed') {
    upsertTaskState(db, taskId, groupTaskStateKey, groups.value);
    return;
  }
  const channel = getChannel(db, channelId);
  const tokens = readChannelCache(db, channelId, 'tokens', []);
  upsertTaskState(db, taskId, groupTaskStateKey, channel ? filterGroupsByTokenUsage(groups.value, tokens.value, channel.type) : groups.value);
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
  if (type !== 'sub2api' && type !== 'newapi' && type !== 'other') throw new UpstreamError('渠道类型无效', 400);
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

function ensureActionableChannel(channel: ChannelRecord, action: string): void {
  if (channel.type === 'other') throw new UpstreamError(`其它渠道仅用于记录，不支持${action}`, 400);
}

function normalizeOwnedSiteInput(body: Record<string, unknown>, existing?: OwnedSiteRecord) {
  const type = (body.type || existing?.type || 'sub2api') as OwnedSiteType;
  if (type !== 'sub2api') throw new UpstreamError('自有站点类型无效，当前仅支持 sub2api', 400);
  const baseUrl = body.base_url !== undefined ? normalizeOwnedSiteBaseUrl(String(body.base_url)) : existing?.base_url;
  if (!baseUrl) throw new UpstreamError('站点链接不能为空', 400);
  let host = 'sub2api';
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new UpstreamError('站点链接格式无效', 400);
  }
  return {
    name: String(body.name || existing?.name || '').trim() || `sub2api ${host}`,
    type,
    base_url: baseUrl,
    admin_api_key:
      body.admin_api_key !== undefined && String(body.admin_api_key).trim() !== ''
        ? String(body.admin_api_key).trim()
        : existing?.admin_api_key || null
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
    if ((input.type === 'sub2api' || input.type === 'other') && (!input.username || !input.password)) {
      throw new UpstreamError(`${input.type === 'sub2api' ? 'sub2api' : '其它'}渠道需要账号和密码`, 400);
    }
    if (input.type === 'newapi' && (!input.newapi_access_token || !input.newapi_user_id)) {
      throw new UpstreamError('new-api 渠道需要系统访问令牌和 userId', 400);
    }
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO channels (
        name, type, base_url, username, password, newapi_access_token, newapi_user_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.type,
      input.base_url,
      input.username,
      input.password,
      input.newapi_access_token,
      input.newapi_user_id,
      input.type === 'other' ? 'active' : 'syncing',
      now,
      now
    );
    const id = Number(result.lastInsertRowid);
    if (input.type === 'other') {
      res.status(201).json(sanitizeChannel(ensureChannel(db, id)));
      return;
    }
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

  app.get('/api/channels/:id/tokens/:tokenId/models', asyncRoute(async (req, res) => {
    const id = idParam(req);
    ensureActionableChannel(ensureChannel(db, id), '查询令牌模型');
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0) throw new UpstreamError('无效的令牌 ID', 400);
    res.json(await getTokenModels(db, id, tokenId));
  }));

  app.put('/api/channels/:id/tokens/:tokenId/group', asyncRoute(async (req, res) => {
    const id = idParam(req);
    ensureActionableChannel(ensureChannel(db, id), '修改令牌分组');
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

  app.get('/api/channels/:id/balance-query-logs', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const pageSize = 10;
    const page = positiveQueryInteger(req.query.page, 1);
    const total = (db.prepare('SELECT COUNT(*) AS count FROM balance_query_logs WHERE channel_id = ?').get(id) as { count: number }).count;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, pages);
    const items = db.prepare(`
      SELECT *
      FROM balance_query_logs
      WHERE channel_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(id, pageSize, (currentPage - 1) * pageSize);
    res.json({ items, total, page: currentPage, page_size: pageSize, pages });
  });

  app.get('/api/channels/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureChannel(db, id);
    const rows = db.prepare('SELECT * FROM automation_tasks WHERE channel_id = ? ORDER BY id DESC').all(id) as unknown as AutomationTaskRecord[];
    res.json(rows.map(parseTask));
  });

  app.post('/api/channels/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureActionableChannel(ensureChannel(db, id), '配置自动化告警');
    const payload = taskPayload(req.body || {});
    if (!isGroupTaskType(payload.type) && payload.threshold === undefined) throw new UpstreamError('预警阈值无效', 400);
    const now = nowIso();
    const taskType = payload.type || 'low_balance';
    const timingDefaults = taskTimingDefaults[taskType];
    const result = db.prepare(`
      INSERT INTO automation_tasks (
        channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes, recipients_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskType,
      payload.enabled ?? 1,
      payload.interval_minutes ?? (taskType === 'low_balance' ? timingDefaults.interval_minutes : Number(getSetting(db, 'default_interval_minutes', '30')) || timingDefaults.interval_minutes),
      payload.threshold ?? 0,
      payload.lookback_minutes ?? 60,
      payload.cooldown_minutes ?? timingDefaults.cooldown_minutes,
      payload.recipients_json ?? JSON.stringify([]),
      now,
      now
    );
    const row = db.prepare('SELECT * FROM automation_tasks WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as AutomationTaskRecord;
    if (isGroupTaskType(row.type)) {
      seedGroupTaskState(db, row.id, id, row.type);
    }
    res.status(201).json(parseTask(row));
  });

  app.put('/api/channels/:id/tasks/:taskId', (req, res) => {
    const id = idParam(req);
    ensureActionableChannel(ensureChannel(db, id), '配置自动化告警');
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
    const changedToGroupTask = payload.type !== undefined && isGroupTaskType(row.type) && !isGroupTaskType(existing.type);
    const reenabledGroupTask = isGroupTaskType(row.type) && existing.enabled === 0 && payload.enabled === 1;
    if (changedToGroupTask || reenabledGroupTask) {
      seedGroupTaskState(db, row.id, id, row.type);
    }
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

  app.get('/api/owned-sites', (_req, res) => {
    const rows = db.prepare('SELECT * FROM owned_sites ORDER BY updated_at DESC, id DESC').all() as unknown as OwnedSiteRecord[];
    res.json(rows.map(sanitizeOwnedSite));
  });

  app.post('/api/owned-sites', asyncRoute(async (req, res) => {
    const input = normalizeOwnedSiteInput(req.body || {});
    if (!input.admin_api_key) throw new UpstreamError('自有站点需要 Admin API Key', 400);
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO owned_sites (name, type, base_url, admin_api_key, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'syncing', ?, ?)
    `).run(input.name, input.type, input.base_url, input.admin_api_key, now, now);
    const id = Number(result.lastInsertRowid);
    try {
      const site = await checkOwnedSite(db, id);
      res.status(201).json(site);
    } catch (error) {
      db.prepare('DELETE FROM owned_sites WHERE id = ?').run(id);
      throw error;
    }
  }));

  app.put('/api/owned-sites/:id', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const existing = ensureOwnedSite(db, id);
    const input = normalizeOwnedSiteInput(req.body || {}, existing);
    db.prepare(`
      UPDATE owned_sites
      SET name = ?, base_url = ?, admin_api_key = ?, updated_at = ?
      WHERE id = ?
    `).run(input.name, input.base_url, input.admin_api_key, nowIso(), id);
    if (req.body?.check === true) {
      res.json(await checkOwnedSite(db, id));
      return;
    }
    res.json(sanitizeOwnedSite(ensureOwnedSite(db, id)));
  }));

  app.delete('/api/owned-sites/:id', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    db.prepare('DELETE FROM owned_sites WHERE id = ?').run(id);
    res.status(204).end();
  });

  app.post('/api/owned-sites/:id/check', asyncRoute(async (req, res) => {
    const id = idParam(req);
    res.json(await checkOwnedSite(db, id));
  }));

  app.get('/api/owned-sites/:id/groups', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await fetchOwnedSiteGroups(site));
  }));

  app.get('/api/owned-sites/:id/accounts', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await fetchOwnedSiteAccounts(site, req.query as Record<string, unknown>));
  }));

  app.get('/api/owned-sites/:id/upstream/accounts', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await listOwnedSiteUpstreamAccounts(db, site, String(req.query.group || '')));
  }));

  app.get('/api/owned-sites/:id/upstream/alert-setting', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await getOwnedSiteUpstreamAlertSetting(db, site));
  }));

  app.put('/api/owned-sites/:id/upstream/alert-setting', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await saveOwnedSiteUpstreamAlertSetting(db, site, req.body || {}));
  }));

  app.get('/api/owned-sites/:id/upstream/groups/:groupId/monitor', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await getOwnedSiteUpstreamGroupMonitor(db, site, textParam(req.params.groupId, '分组 ID')));
  }));

  app.put('/api/owned-sites/:id/upstream/groups/:groupId/monitor', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await saveOwnedSiteUpstreamGroupMonitor(db, site, textParam(req.params.groupId, '分组 ID'), req.body || {}));
  }));

  app.get('/api/owned-sites/:id/upstream/accounts/:accountId/monitor', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await getOwnedSiteUpstreamMonitor(db, site, textParam(req.params.accountId, '账号 ID')));
  }));

  app.put('/api/owned-sites/:id/upstream/accounts/:accountId/monitor', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await saveOwnedSiteUpstreamMonitor(db, site, textParam(req.params.accountId, '账号 ID'), req.body || {}));
  }));

  app.post('/api/owned-sites/:id/upstream/accounts/:accountId/monitor/run', asyncRoute(async (req, res) => {
    const id = idParam(req);
    const site = ensureOwnedSite(db, id);
    res.json(await runOwnedSiteUpstreamMonitor(db, site, textParam(req.params.accountId, '账号 ID')));
  }));

  app.get('/api/owned-sites/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    const rows = db.prepare('SELECT * FROM owned_site_automation_tasks WHERE site_id = ? ORDER BY id DESC').all(id) as unknown as OwnedSiteAutomationTaskRecord[];
    res.json(rows.map(parseOwnedSiteTask));
  });

  app.post('/api/owned-sites/:id/tasks', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    const payload = normalizeOwnedSiteTaskPayload(req.body || {});
    const targetType = payload.target_type;
    if (!targetType) throw new UpstreamError('任务目标类型无效', 400);
    const now = nowIso();
    const result = db.prepare(`
      INSERT INTO owned_site_automation_tasks (
        site_id, type, enabled, target_type, target_account_id, target_account_name, target_group_id, target_group_name,
        interval_minutes, cooldown_minutes, recipients_json, created_at, updated_at
      ) VALUES (?, 'account_error', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      payload.enabled ?? 1,
      targetType,
      payload.target_account_id ?? null,
      payload.target_account_name ?? null,
      payload.target_group_id ?? null,
      payload.target_group_name ?? null,
      payload.interval_minutes ?? 1,
      payload.cooldown_minutes ?? 30,
      payload.recipients_json ?? JSON.stringify([]),
      now,
      now
    );
    const row = db.prepare('SELECT * FROM owned_site_automation_tasks WHERE id = ?').get(Number(result.lastInsertRowid)) as unknown as OwnedSiteAutomationTaskRecord;
    res.status(201).json(parseOwnedSiteTask(row));
  });

  app.put('/api/owned-sites/:id/tasks/:taskId', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    const taskId = Number(req.params.taskId);
    const existing = db.prepare('SELECT * FROM owned_site_automation_tasks WHERE id = ? AND site_id = ?').get(taskId, id) as
      | OwnedSiteAutomationTaskRecord
      | undefined;
    if (!existing) throw new UpstreamError('任务不存在', 404);
    const payload = normalizeOwnedSiteTaskPayload(req.body || {}, true);
    const nextTargetType = payload.target_type ?? existing.target_type;
    const nextAccountId = payload.target_account_id !== undefined ? payload.target_account_id : existing.target_account_id;
    const nextGroupId = payload.target_group_id !== undefined ? payload.target_group_id : existing.target_group_id;
    if (nextTargetType === 'account' && !nextAccountId) throw new UpstreamError('请选择要监控的账号', 400);
    if (nextTargetType === 'group' && !nextGroupId) throw new UpstreamError('请选择要监控的分组', 400);
    db.prepare(`
      UPDATE owned_site_automation_tasks
      SET enabled = ?, target_type = ?, target_account_id = ?, target_account_name = ?, target_group_id = ?, target_group_name = ?,
          interval_minutes = ?, cooldown_minutes = ?, recipients_json = ?, updated_at = ?
      WHERE id = ? AND site_id = ?
    `).run(
      payload.enabled ?? existing.enabled,
      nextTargetType,
      nextTargetType === 'account' ? nextAccountId : null,
      nextTargetType === 'account' ? (payload.target_account_name !== undefined ? payload.target_account_name : existing.target_account_name) : null,
      nextTargetType === 'group' ? nextGroupId : null,
      nextTargetType === 'group' ? (payload.target_group_name !== undefined ? payload.target_group_name : existing.target_group_name) : null,
      payload.interval_minutes ?? existing.interval_minutes,
      payload.cooldown_minutes ?? existing.cooldown_minutes,
      payload.recipients_json ?? existing.recipients_json,
      nowIso(),
      taskId,
      id
    );
    const row = db.prepare('SELECT * FROM owned_site_automation_tasks WHERE id = ?').get(taskId) as unknown as OwnedSiteAutomationTaskRecord;
    res.json(parseOwnedSiteTask(row));
  });

  app.delete('/api/owned-sites/:id/tasks/:taskId', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    db.prepare('DELETE FROM owned_site_automation_tasks WHERE id = ? AND site_id = ?').run(Number(req.params.taskId), id);
    res.status(204).end();
  });

  app.get('/api/owned-sites/:id/alerts', (req, res) => {
    const id = idParam(req);
    ensureOwnedSite(db, id);
    const rows = db.prepare(`
      SELECT *
      FROM owned_site_alert_events
      WHERE site_id = ?
      ORDER BY created_at DESC
      LIMIT 200
    `).all(id);
    res.json(rows);
  });

  app.get('/api/owned-site-alerts', (_req, res) => {
    const rows = db.prepare(`
      SELECT *
      FROM owned_site_alert_events
      ORDER BY created_at DESC
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
    // Upstream auth failures must not look like this app's session has expired.
    const status = error instanceof UpstreamError && error.origin === 'upstream' && error.status === 401
      ? 502
      : error instanceof UpstreamError
        ? error.status
        : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: error.message || '服务器内部错误'
    });
  });

  return app;
}
