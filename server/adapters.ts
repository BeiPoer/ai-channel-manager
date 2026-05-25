import { DatabaseSync } from 'node:sqlite';
import { getChannel, nowIso, parseJson, setChannelSyncStatus } from './db.js';
import { extractMessage, requestJson, UpstreamError } from './http.js';
import type { CacheKey, ChannelRecord, SyncResult } from './types.js';

interface PageResult {
  items: unknown[];
  total: number | null;
}

export type TokenGroupUpdatePayload = {
  group?: unknown;
  group_id?: unknown;
};

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('站点链接不能为空');
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

function sub2apiUrl(channel: ChannelRecord, path: string): string {
  return `${channel.base_url}/api/v1${path}`;
}

function newApiUrl(channel: ChannelRecord, path: string): string {
  return `${channel.base_url}/api${path}`;
}

function unwrapSub2api(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if ('code' in record) {
    if (record.code === 0 || record.code === '0') return record.data;
    throw new UpstreamError(extractMessage(record) || 'sub2api 返回业务错误', 502, payload);
  }
  return payload;
}

function unwrapNewApi(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (record.success === false) {
    throw new UpstreamError(extractMessage(record) || 'new-api 返回业务错误', 502, payload);
  }
  if (record.success === true && 'data' in record) return record.data;
  return payload;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function tokenIdOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const parsed = Number(value.id ?? value.ID);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function extractPage(payload: unknown): PageResult {
  if (Array.isArray(payload)) return { items: payload, total: payload.length };
  if (!payload || typeof payload !== 'object') return { items: [], total: 0 };
  const record = payload as Record<string, unknown>;
  const candidates = [record.items, record.data, record.rows, record.list, record.tokens, record.keys];
  const items = candidates.find(Array.isArray) as unknown[] | undefined;
  const total = asNumber(record.total ?? record.count ?? items?.length ?? 0, items?.length ?? 0);
  return { items: items || [], total: Number.isFinite(total) ? total : null };
}

async function sub2apiLogin(db: DatabaseSync, channel: ChannelRecord): Promise<ChannelRecord> {
  if (!channel.username || !channel.password) {
    throw new UpstreamError('sub2api 渠道需要账号和密码', 400);
  }
  const response = await requestJson(sub2apiUrl(channel, '/auth/login'), {
    method: 'POST',
    body: JSON.stringify({ email: channel.username, password: channel.password })
  });
  const data = unwrapSub2api(response.data) as Record<string, unknown>;
  if (data?.requires_2fa) {
    throw new UpstreamError('该 sub2api 账号启用了 2FA，当前版本不支持交互式验证码登录', 400, data);
  }
  if (data?.turnstile_required || data?.requires_turnstile) {
    throw new UpstreamError('该 sub2api 站点需要 Turnstile 验证，当前版本不支持交互式验证码登录', 400, data);
  }
  const accessToken = String(data?.access_token || '');
  if (!accessToken) throw new UpstreamError('sub2api 登录成功但未返回 access_token', 502, data);
  const refreshToken = data?.refresh_token ? String(data.refresh_token) : null;
  const expiresIn = asNumber(data?.expires_in, 0);
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : null;
  db.prepare(`
    UPDATE channels
    SET sub2api_access_token = ?, sub2api_refresh_token = ?, sub2api_token_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, nowIso(), channel.id);
  return { ...channel, sub2api_access_token: accessToken, sub2api_refresh_token: refreshToken, sub2api_token_expires_at: expiresAt };
}

async function sub2apiRefresh(db: DatabaseSync, channel: ChannelRecord): Promise<ChannelRecord> {
  if (!channel.sub2api_refresh_token) return sub2apiLogin(db, channel);
  const response = await requestJson(sub2apiUrl(channel, '/auth/refresh'), {
    method: 'POST',
    body: JSON.stringify({ refresh_token: channel.sub2api_refresh_token })
  });
  const data = unwrapSub2api(response.data) as Record<string, unknown>;
  const accessToken = String(data?.access_token || '');
  if (!accessToken) return sub2apiLogin(db, channel);
  const refreshToken = data?.refresh_token ? String(data.refresh_token) : channel.sub2api_refresh_token;
  const expiresIn = asNumber(data?.expires_in, 0);
  const expiresAt = expiresIn > 0 ? Math.floor(Date.now() / 1000) + expiresIn : null;
  db.prepare(`
    UPDATE channels
    SET sub2api_access_token = ?, sub2api_refresh_token = ?, sub2api_token_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(accessToken, refreshToken, expiresAt, nowIso(), channel.id);
  return { ...channel, sub2api_access_token: accessToken, sub2api_refresh_token: refreshToken, sub2api_token_expires_at: expiresAt };
}

async function sub2apiRequest(db: DatabaseSync, channel: ChannelRecord, path: string, init: RequestInit = {}, retry = true): Promise<unknown> {
  const authed = channel.sub2api_access_token ? channel : await sub2apiLogin(db, channel);
  try {
    const response = await requestJson(sub2apiUrl(authed, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${authed.sub2api_access_token}`,
        ...(init.headers || {})
      }
    });
    return unwrapSub2api(response.data);
  } catch (error) {
    if (retry && error instanceof UpstreamError && error.status === 401) {
      const refreshed = await sub2apiRefresh(db, authed);
      return sub2apiRequest(db, refreshed, path, init, false);
    }
    throw error;
  }
}

async function fetchSub2apiTokens(db: DatabaseSync, channel: ChannelRecord): Promise<{ items: unknown[]; raw: unknown[] }> {
  const paths = ['/keys', '/api-keys'];
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const allItems: unknown[] = [];
      const rawPages: unknown[] = [];
      for (let page = 1; page <= 50; page += 1) {
        const payload = await sub2apiRequest(db, channel, `${path}?page=${page}&page_size=100`);
        rawPages.push(payload);
        const pageData = extractPage(payload);
        allItems.push(...pageData.items);
        if (pageData.items.length < 100 || (pageData.total !== null && allItems.length >= pageData.total)) break;
      }
      return { items: allItems, raw: rawPages };
    } catch (error) {
      lastError = error;
      if (!(error instanceof UpstreamError) || error.status !== 404) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError('无法读取 sub2api 令牌列表', 502);
}

async function syncSub2api(db: DatabaseSync, channel: ChannelRecord): Promise<SyncResult> {
  const profile = await sub2apiRequest(db, channel, '/auth/me');
  const groups = await sub2apiRequest(db, channel, '/groups/available');
  const tokens = await fetchSub2apiTokens(db, channel);
  const subscriptions = {
    active: await sub2apiRequest(db, channel, '/subscriptions/active').catch((error) => ({ error: (error as Error).message })),
    summary: await sub2apiRequest(db, channel, '/subscriptions/summary').catch((error) => ({ error: (error as Error).message }))
  };
  const profileRecord = (profile || {}) as Record<string, unknown>;
  const balance = asNumber(profileRecord.balance, 0);
  return {
    profile,
    balanceSnapshot: { balance, used_balance: null, unit: 'sub2api-balance', raw: profile },
    groups: Array.isArray(groups) ? groups : extractPage(groups).items,
    tokens: tokens.items,
    subscriptions,
    raw: { profile, groups, tokens: tokens.raw, subscriptions }
  };
}

async function newApiRequest(channel: ChannelRecord, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!channel.newapi_access_token || !channel.newapi_user_id) {
    throw new UpstreamError('new-api 渠道需要系统访问令牌和 userId', 400);
  }
  const response = await requestJson(newApiUrl(channel, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${channel.newapi_access_token}`,
      'New-Api-User': channel.newapi_user_id,
      ...(init.headers || {})
    }
  });
  return unwrapNewApi(response.data);
}

async function fetchNewApiTokens(channel: ChannelRecord): Promise<{ items: unknown[]; raw: unknown[] }> {
  const allItems: unknown[] = [];
  const rawPages: unknown[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const payload = await newApiRequest(channel, `/token/?p=${page}&size=100`);
    rawPages.push(payload);
    const pageData = extractPage(payload);
    allItems.push(...pageData.items);
    if (pageData.items.length < 100 || (pageData.total !== null && allItems.length >= pageData.total)) break;
  }
  return { items: allItems, raw: rawPages };
}

async function syncNewApi(channel: ChannelRecord): Promise<SyncResult> {
  const profile = await newApiRequest(channel, '/user/self');
  const profileRecord = (profile || {}) as Record<string, unknown>;
  if (String(profileRecord.id ?? channel.newapi_user_id) !== String(channel.newapi_user_id)) {
    throw new UpstreamError('new-api userId 与访问令牌所属用户不一致', 400, profile);
  }
  const groupsPayload = await newApiRequest(channel, '/user/self/groups');
  const tokens = await fetchNewApiTokens(channel);
  const groups = Array.isArray(groupsPayload)
    ? groupsPayload
    : Object.entries((groupsPayload || {}) as Record<string, unknown>).map(([name, value]) => ({ name, ...(value && typeof value === 'object' ? value : { value }) }));
  return {
    profile,
    balanceSnapshot: {
      balance: asNumber(profileRecord.quota, 0),
      used_balance: asNumber(profileRecord.used_quota, 0),
      unit: 'new-api-quota',
      raw: profile
    },
    groups,
    tokens: tokens.items,
    raw: { profile, groups: groupsPayload, tokens: tokens.raw }
  };
}

function upsertCache(db: DatabaseSync, channelId: number, key: CacheKey, raw: unknown, normalized: unknown): void {
  db.prepare(`
    INSERT INTO channel_cache (channel_id, cache_key, raw_json, normalized_json, synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, cache_key)
    DO UPDATE SET raw_json = excluded.raw_json, normalized_json = excluded.normalized_json, synced_at = excluded.synced_at
  `).run(channelId, key, JSON.stringify(raw ?? null), JSON.stringify(normalized ?? null), nowIso());
}

function cachedTokens(db: DatabaseSync, channelId: number): unknown[] {
  const row = db.prepare('SELECT normalized_json FROM channel_cache WHERE channel_id = ? AND cache_key = ?').get(channelId, 'tokens') as
    | { normalized_json: string }
    | undefined;
  return parseJson<unknown[]>(row?.normalized_json, []);
}

function updateTokenCache(db: DatabaseSync, channelId: number, updatedToken: unknown): unknown[] {
  const currentRows = cachedTokens(db, channelId);
  const updatedId = tokenIdOf(updatedToken);
  const nextRows =
    updatedId === null
      ? currentRows
      : currentRows.some((item) => tokenIdOf(item) === updatedId)
        ? currentRows.map((item) => (tokenIdOf(item) === updatedId ? updatedToken : item))
        : [updatedToken, ...currentRows];
  upsertCache(db, channelId, 'tokens', nextRows, nextRows);
  return nextRows;
}

async function refreshTokenCache(db: DatabaseSync, channel: ChannelRecord): Promise<unknown[]> {
  const latestChannel = getChannel(db, channel.id) || channel;
  const tokens = latestChannel.type === 'sub2api' ? await fetchSub2apiTokens(db, latestChannel) : await fetchNewApiTokens(latestChannel);
  upsertCache(db, channel.id, 'tokens', tokens.raw, tokens.items);
  return tokens.items;
}

async function sub2apiTokenDetail(db: DatabaseSync, channel: ChannelRecord, tokenId: number): Promise<{ path: string; token: Record<string, unknown> }> {
  const paths = ['/keys', '/api-keys'];
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const token = await sub2apiRequest(db, channel, `${path}/${tokenId}`);
      if (!isRecord(token)) throw new UpstreamError('sub2api 令牌详情格式异常', 502, token);
      return { path, token };
    } catch (error) {
      lastError = error;
      if (!(error instanceof UpstreamError) || error.status !== 404) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError('无法读取 sub2api 令牌详情', 502);
}

async function updateSub2apiTokenGroup(db: DatabaseSync, channel: ChannelRecord, tokenId: number, payload: TokenGroupUpdatePayload): Promise<unknown> {
  const groupId = Number(payload.group_id);
  if (!Number.isInteger(groupId) || groupId <= 0) throw new UpstreamError('sub2api 分组 ID 无效', 400);

  const { path, token } = await sub2apiTokenDetail(db, channel, tokenId);
  const updated = await sub2apiRequest(db, channel, `${path}/${tokenId}`, {
    method: 'PUT',
    body: JSON.stringify({
      group_id: groupId,
      ip_whitelist: stringArray(token.ip_whitelist),
      ip_blacklist: stringArray(token.ip_blacklist)
    })
  });
  return updated;
}

function requireNewApiTokenField(token: Record<string, unknown>, key: string): unknown {
  if (!(key in token)) throw new UpstreamError(`new-api 令牌详情缺少 ${key}，无法安全更新分组`, 502, token);
  return token[key];
}

async function updateNewApiTokenGroup(channel: ChannelRecord, tokenId: number, payload: TokenGroupUpdatePayload): Promise<unknown> {
  const group = payload.group === undefined || payload.group === null ? '' : String(payload.group);
  const token = await newApiRequest(channel, `/token/${tokenId}`);
  if (!isRecord(token)) throw new UpstreamError('new-api 令牌详情格式异常', 502, token);

  const updated = await newApiRequest(channel, '/token/', {
    method: 'PUT',
    body: JSON.stringify({
      id: asNumber(token.id, tokenId),
      name: requireNewApiTokenField(token, 'name'),
      expired_time: requireNewApiTokenField(token, 'expired_time'),
      remain_quota: requireNewApiTokenField(token, 'remain_quota'),
      unlimited_quota: Boolean(requireNewApiTokenField(token, 'unlimited_quota')),
      model_limits_enabled: Boolean(requireNewApiTokenField(token, 'model_limits_enabled')),
      model_limits: requireNewApiTokenField(token, 'model_limits'),
      allow_ips: requireNewApiTokenField(token, 'allow_ips'),
      group,
      cross_group_retry: Boolean(requireNewApiTokenField(token, 'cross_group_retry'))
    })
  });
  return updated;
}

function persistSyncResult(db: DatabaseSync, channel: ChannelRecord, result: SyncResult): void {
  upsertCache(db, channel.id, 'profile', result.raw.profile ?? result.profile, result.profile);
  upsertCache(db, channel.id, 'groups', result.raw.groups ?? result.groups, result.groups);
  upsertCache(db, channel.id, 'tokens', result.raw.tokens ?? result.tokens, result.tokens);
  if (channel.type === 'sub2api') {
    upsertCache(db, channel.id, 'subscriptions', result.raw.subscriptions ?? result.subscriptions ?? null, result.subscriptions ?? null);
  }
  db.prepare(`
    INSERT INTO balance_snapshots (channel_id, balance, used_balance, unit, raw_json, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    channel.id,
    result.balanceSnapshot.balance,
    result.balanceSnapshot.used_balance ?? null,
    result.balanceSnapshot.unit,
    JSON.stringify(result.balanceSnapshot.raw ?? null),
    nowIso()
  );
  db.prepare(`
    UPDATE channels
    SET status = 'active', last_sync_at = ?, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), channel.id);
}

export async function syncChannel(db: DatabaseSync, channelId: number): Promise<SyncResult> {
  const channel = getChannel(db, channelId);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run('syncing', nowIso(), channel.id);
  try {
    const result = channel.type === 'sub2api' ? await syncSub2api(db, channel) : await syncNewApi(channel);
    persistSyncResult(db, channel, result);
    return result;
  } catch (error) {
    setChannelSyncStatus(db, channel.id, 'error', (error as Error).message);
    throw error;
  }
}

export async function updateTokenGroup(
  db: DatabaseSync,
  channelId: number,
  tokenId: number,
  payload: TokenGroupUpdatePayload
): Promise<{ token: unknown; tokens: unknown[] }> {
  const channel = getChannel(db, channelId);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  const token = channel.type === 'sub2api' ? await updateSub2apiTokenGroup(db, channel, tokenId, payload) : await updateNewApiTokenGroup(channel, tokenId, payload);
  const cached = updateTokenCache(db, channel.id, token);
  const tokens = await refreshTokenCache(db, channel).catch(() => cached);
  return { token, tokens };
}

export const adapterInternals = {
  unwrapSub2api,
  unwrapNewApi,
  extractPage,
  syncSub2api,
  syncNewApi
};
