import { DatabaseSync } from 'node:sqlite';
import { getChannel, nowIso, parseJson, setChannelSyncStatus } from './db.js';
import { extractMessage, requestJson, UpstreamError } from './http.js';
import type { CacheKey, ChannelRecord, SyncResult } from './types.js';

interface PageResult {
  items: unknown[];
  total: number | null;
}

interface NewApiQuotaConversion {
  displayType: 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM';
  quotaPerUnit: number;
  rate: number;
  unit: string;
}

export type TokenGroupUpdatePayload = {
  group?: unknown;
  group_id?: unknown;
};

export interface TokenModelsResult {
  token_id: number;
  token_name: string | null;
  source: 'token_limits' | 'upstream_models';
  models: string[];
}

const DEFAULT_NEW_API_QUOTA_PER_UNIT = 500000;

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

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireFiniteNumber(value: unknown, fieldName: string, raw: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new UpstreamError(`余额查询失败：${fieldName} 缺失或不是有效数字`, 502, raw);
  return parsed;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const parsed = asNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeNewApiDisplayType(value: unknown): NewApiQuotaConversion['displayType'] {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (normalized === 'CNY' || normalized === 'TOKENS' || normalized === 'CUSTOM') return normalized;
  return 'USD';
}

function newApiQuotaConversion(status: unknown): NewApiQuotaConversion {
  const record = isRecord(status) ? status : {};
  const displayType = normalizeNewApiDisplayType(record.quota_display_type);
  const quotaPerUnit = asPositiveNumber(record.quota_per_unit, DEFAULT_NEW_API_QUOTA_PER_UNIT);
  const rate =
    displayType === 'CNY'
      ? asPositiveNumber(record.usd_exchange_rate, 1)
      : displayType === 'CUSTOM'
        ? asPositiveNumber(record.custom_currency_exchange_rate, 1)
        : 1;
  return {
    displayType,
    quotaPerUnit,
    rate,
    unit: displayType === 'TOKENS' ? 'tokens' : displayType
  };
}

function convertNewApiQuota(value: number, conversion: NewApiQuotaConversion): number {
  const quota = value;
  if (conversion.displayType === 'TOKENS') return quota;
  return (quota / conversion.quotaPerUnit) * conversion.rate;
}

function convertOptionalNewApiQuota(value: unknown, conversion: NewApiQuotaConversion): number | null {
  const quota = finiteNumber(value);
  if (quota === null) return null;
  if (conversion.displayType === 'TOKENS') return quota;
  return (quota / conversion.quotaPerUnit) * conversion.rate;
}

function storedNewApiQuotaConversion(value: unknown): NewApiQuotaConversion | null {
  if (!isRecord(value)) return null;
  const displayType = normalizeNewApiDisplayType(value.displayType);
  const quotaPerUnit = asPositiveNumber(value.quotaPerUnit, DEFAULT_NEW_API_QUOTA_PER_UNIT);
  const rate = displayType === 'TOKENS' ? 1 : asPositiveNumber(value.rate, 1);
  return {
    displayType,
    quotaPerUnit,
    rate,
    unit: displayType === 'TOKENS' ? 'tokens' : displayType
  };
}

function tokenIdOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const parsed = Number(value.id ?? value.ID);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasUsableSub2apiAccessToken(channel: ChannelRecord): boolean {
  if (!channel.sub2api_access_token) return false;
  if (!channel.sub2api_token_expires_at) return true;
  return channel.sub2api_token_expires_at > Math.floor(Date.now() / 1000) + 60;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeModelName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text = String(value).trim();
  if (!text) return null;
  if (text.startsWith('models/')) text = text.slice('models/'.length);
  const marker = '/models/';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length);
  return text.trim() || null;
}

function uniqueModelNames(values: unknown[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const value of values) {
    const model = normalizeModelName(value);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function splitModelList(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueModelNames(value.flatMap((item) => splitModelList(item)));
  if (isRecord(value)) {
    return uniqueModelNames(
      Object.entries(value)
        .filter(([, enabled]) => enabled !== false && enabled !== null && enabled !== undefined)
        .map(([model]) => model)
    );
  }
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const parsedModels = splitModelList(parsed);
    if (parsedModels.length) return parsedModels;
  } catch {
    // Plain comma/newline separated model lists are the common format.
  }
  return uniqueModelNames(trimmed.split(/[\s,]+/));
}

function tokenNameOf(token: Record<string, unknown>): string | null {
  const value = token.name ?? token.Name ?? token.title;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function tokenKeyOf(token: Record<string, unknown>): string | null {
  const value = token.key ?? token.Key ?? token.api_key ?? token.apiKey ?? token.token;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.includes('*')) return null;
  return text;
}

function tokenKeyFromPayload(payload: unknown): string | null {
  if (isRecord(payload)) return tokenKeyOf(payload);
  if (payload === null || payload === undefined) return null;
  const text = String(payload).trim();
  if (!text || text.includes('*')) return null;
  return text;
}

function extractModelNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return uniqueModelNames(
      payload.flatMap((item) => {
        if (isRecord(item)) return [item.id, item.name, item.model, item.display_name, item.displayName];
        return [item];
      })
    );
  }
  if (!isRecord(payload)) return [];
  const directArrays = [payload.data, payload.models, payload.items, payload.list].filter(Array.isArray) as unknown[][];
  for (const arrayValue of directArrays) {
    const models = extractModelNames(arrayValue);
    if (models.length) return models;
  }
  if (isRecord(payload.models)) {
    return uniqueModelNames(Object.keys(payload.models));
  }
  if (isRecord(payload.data)) {
    const nested = extractModelNames(payload.data);
    if (nested.length) return nested;
  }
  const nestedArrays = Object.values(payload).filter(Array.isArray) as unknown[][];
  if (nestedArrays.length) {
    return uniqueModelNames(nestedArrays.flatMap((arrayValue) => extractModelNames(arrayValue)));
  }
  return uniqueModelNames([payload.id, payload.name, payload.model]);
}

function tokenRecordFromCache(db: DatabaseSync, channelId: number, tokenId: number): Record<string, unknown> | null {
  const row = cachedTokens(db, channelId).find((item) => tokenIdOf(item) === tokenId);
  return isRecord(row) ? row : null;
}

function groupPlatformOf(token: Record<string, unknown>): string {
  const group = isRecord(token.group) ? token.group : isRecord(token.Group) ? token.Group : null;
  const raw = token.platform ?? token.group_platform ?? token.groupPlatform ?? group?.platform ?? group?.Platform;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function sub2apiModelEndpointCandidates(token: Record<string, unknown>): string[] {
  const platform = groupPlatformOf(token);
  if (platform === 'gemini' || platform === 'google') return ['/v1beta/models', '/v1/models'];
  if (platform === 'antigravity') return ['/antigravity/models', '/antigravity/v1/models', '/antigravity/v1beta/models', '/v1/models'];
  if (platform === 'openai' || platform === 'anthropic' || platform === 'claude') return ['/v1/models'];
  return ['/v1/models', '/v1beta/models', '/antigravity/models'];
}

function isOptionalUpstreamMiss(error: unknown): boolean {
  return error instanceof UpstreamError && [400, 401, 403, 404, 405, 502].includes(error.status);
}

async function fetchModelsWithBearer(channel: ChannelRecord, key: string, paths: string[]): Promise<string[]> {
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      const response = await requestJson(`${channel.base_url}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`
        }
      });
      return extractModelNames(response.data);
    } catch (error) {
      lastError = error;
      if (!(error instanceof UpstreamError) || ![400, 401, 403, 404].includes(error.status)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError('无法读取令牌模型列表', 502);
}

async function tryFetchModelsWithBearer(channel: ChannelRecord, key: string, paths: string[]): Promise<string[] | null> {
  try {
    return await fetchModelsWithBearer(channel, key, paths);
  } catch (error) {
    if (isOptionalUpstreamMiss(error)) return null;
    throw error;
  }
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

async function ensureSub2apiAccess(db: DatabaseSync, channel: ChannelRecord, forceRefresh = false): Promise<ChannelRecord> {
  if (forceRefresh && channel.sub2api_refresh_token) {
    try {
      return await sub2apiRefresh(db, channel);
    } catch {
      return sub2apiLogin(db, channel);
    }
  }
  if (hasUsableSub2apiAccessToken(channel)) return channel;
  if (channel.sub2api_refresh_token) {
    try {
      return await sub2apiRefresh(db, channel);
    } catch {
      return sub2apiLogin(db, channel);
    }
  }
  return sub2apiLogin(db, channel);
}

async function sub2apiRequest(db: DatabaseSync, channel: ChannelRecord, path: string, init: RequestInit = {}, retry = true): Promise<unknown> {
  const authed = await ensureSub2apiAccess(db, channel);
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

export async function createUpstreamLoginUrl(db: DatabaseSync, channelId: number): Promise<string> {
  const channel = getChannel(db, channelId);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  if (channel.type !== 'sub2api') throw new UpstreamError('当前仅支持 sub2api 渠道自动登录', 400);

  const authed = await ensureSub2apiAccess(db, channel, true);
  if (!authed.sub2api_access_token) throw new UpstreamError('sub2api 登录成功但未返回 access_token', 502);

  const fragment = new URLSearchParams({
    access_token: authed.sub2api_access_token,
    token_type: 'Bearer',
    redirect: '/dashboard'
  });
  if (authed.sub2api_refresh_token) {
    fragment.set('refresh_token', authed.sub2api_refresh_token);
  }
  if (authed.sub2api_token_expires_at) {
    const expiresIn = Math.max(1, authed.sub2api_token_expires_at - Math.floor(Date.now() / 1000));
    fragment.set('expires_in', String(expiresIn));
  }

  return `${authed.base_url}/auth/oauth/callback#${fragment.toString()}`;
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
  let profile: unknown;
  let balance: number;
  try {
    profile = await sub2apiRequest(db, channel, '/auth/me');
    const profileRecord = (profile || {}) as Record<string, unknown>;
    balance = requireFiniteNumber(profileRecord.balance, 'profile.balance', profile);
  } catch (error) {
    recordBalanceQueryFailure(db, channel.id, error);
    throw error;
  }
  const balanceSnapshot: SyncResult['balanceSnapshot'] = { balance, used_balance: null, unit: 'sub2api-balance', raw: profile };
  recordBalanceQuerySuccess(db, channel.id, balanceSnapshot);
  const groups = await sub2apiRequest(db, channel, '/groups/available');
  const tokens = await fetchSub2apiTokens(db, channel);
  const subscriptions = {
    active: await sub2apiRequest(db, channel, '/subscriptions/active').catch((error) => ({ error: (error as Error).message })),
    summary: await sub2apiRequest(db, channel, '/subscriptions/summary').catch((error) => ({ error: (error as Error).message }))
  };
  return {
    profile,
    balanceSnapshot,
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

async function syncNewApi(db: DatabaseSync, channel: ChannelRecord): Promise<SyncResult> {
  let profile: unknown;
  let quota: number;
  try {
    profile = await newApiRequest(channel, '/user/self');
    const profileRecord = (profile || {}) as Record<string, unknown>;
    if (String(profileRecord.id ?? channel.newapi_user_id) !== String(channel.newapi_user_id)) {
      throw new UpstreamError('new-api userId 与访问令牌所属用户不一致', 400, profile);
    }
    quota = requireFiniteNumber(profileRecord.quota, 'profile.quota', profile);
  } catch (error) {
    recordBalanceQueryFailure(db, channel.id, error);
    throw error;
  }
  const profileRecord = (profile || {}) as Record<string, unknown>;
  const status = await newApiRequest(channel, '/status').catch(() => null);
  const conversion = newApiQuotaConversion(status);
  const balanceSnapshot: SyncResult['balanceSnapshot'] = {
    balance: convertNewApiQuota(quota, conversion),
    used_balance: convertOptionalNewApiQuota(profileRecord.used_quota, conversion),
    unit: `new-api-${conversion.unit}`,
    raw: { profile, status, conversion }
  };
  recordBalanceQuerySuccess(db, channel.id, balanceSnapshot);
  const groupsPayload = await newApiRequest(channel, '/user/self/groups');
  const tokens = await fetchNewApiTokens(channel);
  const groups = Array.isArray(groupsPayload)
    ? groupsPayload
    : Object.entries((groupsPayload || {}) as Record<string, unknown>).map(([name, value]) => ({ name, ...(value && typeof value === 'object' ? value : { value }) }));
  return {
    profile,
    balanceSnapshot,
    groups,
    tokens: tokens.items,
    raw: { profile, status, groups: groupsPayload, tokens: tokens.raw }
  };
}

function migrateNewApiRawQuotaSnapshots(db: DatabaseSync, channelId: number, result: SyncResult): void {
  const snapshot = result.balanceSnapshot;
  if (!String(snapshot.unit).startsWith('new-api-')) return;
  const raw = isRecord(snapshot.raw) ? snapshot.raw : {};
  const conversion = storedNewApiQuotaConversion(raw.conversion);
  if (!conversion || conversion.displayType === 'TOKENS') return;
  db.prepare(`
    UPDATE balance_snapshots
    SET balance = balance / ? * ?,
        used_balance = CASE WHEN used_balance IS NULL THEN NULL ELSE used_balance / ? * ? END,
        unit = ?
    WHERE channel_id = ?
      AND unit = 'new-api-quota'
  `).run(conversion.quotaPerUnit, conversion.rate, conversion.quotaPerUnit, conversion.rate, snapshot.unit, channelId);
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

function recordBalanceQuerySuccess(db: DatabaseSync, channelId: number, snapshot: SyncResult['balanceSnapshot']): void {
  db.prepare(`
    INSERT INTO balance_query_logs (channel_id, status, balance, used_balance, unit, message, error, raw_json, created_at)
    VALUES (?, 'success', ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    channelId,
    snapshot.balance,
    snapshot.used_balance ?? null,
    snapshot.unit,
    '余额查询成功',
    JSON.stringify(snapshot.raw ?? null),
    nowIso()
  );
}

function recordBalanceQueryFailure(db: DatabaseSync, channelId: number, error: unknown, raw: unknown = null): void {
  db.prepare(`
    INSERT INTO balance_query_logs (channel_id, status, balance, used_balance, unit, message, error, raw_json, created_at)
    VALUES (?, 'error', NULL, NULL, NULL, ?, ?, ?, ?)
  `).run(
    channelId,
    '余额查询失败',
    error instanceof Error ? error.message : String(error || '余额查询失败'),
    JSON.stringify(raw ?? (error instanceof UpstreamError ? error.details ?? null : null)),
    nowIso()
  );
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

async function getSub2apiTokenModels(db: DatabaseSync, channel: ChannelRecord, tokenId: number): Promise<TokenModelsResult> {
  const cachedToken = tokenRecordFromCache(db, channel.id, tokenId);
  const { token } = await sub2apiTokenDetail(db, channel, tokenId).catch((error) => {
    if (cachedToken) return { path: '', token: cachedToken };
    throw error;
  });
  const key = tokenKeyOf(token);
  if (!key) throw new UpstreamError('sub2api 令牌详情未返回可用密钥，无法查询模型列表', 502, token);

  const models = await fetchModelsWithBearer(channel, key, sub2apiModelEndpointCandidates(token));
  return {
    token_id: tokenId,
    token_name: tokenNameOf(token),
    source: 'upstream_models',
    models
  };
}

async function getNewApiTokenModels(db: DatabaseSync, channel: ChannelRecord, tokenId: number): Promise<TokenModelsResult> {
  const cachedToken = tokenRecordFromCache(db, channel.id, tokenId);
  const tokenPayload = await newApiRequest(channel, `/token/${tokenId}`).catch((error) => {
    if (cachedToken && isOptionalUpstreamMiss(error)) return cachedToken;
    throw error;
  });
  if (!isRecord(tokenPayload)) throw new UpstreamError('new-api 令牌详情格式异常', 502, tokenPayload);
  const token = { ...(cachedToken || {}), ...tokenPayload };

  const limited = Boolean(token.model_limits_enabled);
  const limitedModels = limited ? splitModelList(token.model_limits) : [];
  if (limited) {
    return {
      token_id: tokenId,
      token_name: tokenNameOf(token),
      source: 'token_limits',
      models: limitedModels
    };
  }

  const fullKey = await newApiRequest(channel, `/token/${tokenId}/key`, { method: 'POST' })
    .then(tokenKeyFromPayload)
    .catch((error) => {
      if (isOptionalUpstreamMiss(error)) return null;
      throw error;
    });
  const key = fullKey || tokenKeyOf(token);
  if (key) {
    const models = await tryFetchModelsWithBearer(channel, key.startsWith('sk-') ? key : `sk-${key}`, ['/v1/models', '/v1beta/models']);
    if (models) {
      return {
        token_id: tokenId,
        token_name: tokenNameOf(token),
        source: 'upstream_models',
        models
      };
    }
  }

  const fallbackPayloads = await Promise.all(
    ['/user/self/models', '/channel/models_enabled', '/channel/models'].map((path) =>
      newApiRequest(channel, path).catch((error) => {
        if (isOptionalUpstreamMiss(error)) return null;
        throw error;
      })
    )
  );
  const models = uniqueModelNames(fallbackPayloads.flatMap((payload) => extractModelNames(payload)));
  return {
    token_id: tokenId,
    token_name: tokenNameOf(token),
    source: 'upstream_models',
    models
  };
}

function persistSyncResult(db: DatabaseSync, channel: ChannelRecord, result: SyncResult): void {
  migrateNewApiRawQuotaSnapshots(db, channel.id, result);
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
  if (channel.type === 'other') throw new UpstreamError('其它渠道仅用于记录，不支持同步', 400);
  db.prepare('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?').run('syncing', nowIso(), channel.id);
  try {
    const result = channel.type === 'sub2api' ? await syncSub2api(db, channel) : await syncNewApi(db, channel);
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
  if (channel.type === 'other') throw new UpstreamError('其它渠道仅用于记录，不支持修改令牌分组', 400);
  const token = channel.type === 'sub2api' ? await updateSub2apiTokenGroup(db, channel, tokenId, payload) : await updateNewApiTokenGroup(channel, tokenId, payload);
  const cached = updateTokenCache(db, channel.id, token);
  const tokens = await refreshTokenCache(db, channel).catch(() => cached);
  return { token, tokens };
}

export async function getTokenModels(db: DatabaseSync, channelId: number, tokenId: number): Promise<TokenModelsResult> {
  const channel = getChannel(db, channelId);
  if (!channel) throw new UpstreamError('渠道不存在', 404);
  if (channel.type === 'other') throw new UpstreamError('其它渠道仅用于记录，不支持查询令牌模型', 400);
  return channel.type === 'sub2api' ? getSub2apiTokenModels(db, channel, tokenId) : getNewApiTokenModels(db, channel, tokenId);
}

export const adapterInternals = {
  unwrapSub2api,
  unwrapNewApi,
  extractPage,
  syncSub2api,
  syncNewApi
};
