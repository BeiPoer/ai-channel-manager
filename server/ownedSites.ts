import { DatabaseSync } from 'node:sqlite';
import { getEmailSettings, sendEmail } from './email.js';
import { extractMessage, requestJson, UpstreamError } from './http.js';
import { getOwnedSite, nowIso, parseJson, sanitizeOwnedSite, splitRecipients } from './db.js';
import type {
  OwnedSiteAccountStateRecord,
  OwnedSiteAutomationTaskRecord,
  OwnedSiteRecord,
  OwnedSiteTaskTargetType,
  PaginatedResult,
  SafeOwnedSite
} from './types.js';

export interface OwnedSiteAccount {
  id: string;
  name: string;
  platform: string;
  type: string;
  status: string;
  schedulable: boolean | null;
  error_message: string;
  group_ids: string[];
  groups: Array<Record<string, unknown>>;
  last_used_at: string | null;
  updated_at: string | null;
  raw: Record<string, unknown>;
}

export interface OwnedSiteGroup {
  id: string;
  name: string;
  platform: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface OwnedSiteAccountQuery {
  page?: number;
  page_size?: number;
  search?: string;
  group?: string;
  status?: string;
  platform?: string;
  type?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

interface AccountTransition {
  account: OwnedSiteAccount;
  previous: OwnedSiteAccountStateRecord | null;
}

interface OwnedSiteTaskRunCache {
  accountsByQuery: Map<string, Promise<PaginatedResult<OwnedSiteAccount>>>;
  accountById: Map<string, Promise<OwnedSiteAccount | null>>;
}

export interface OwnedSiteAlertEvaluation {
  triggered: boolean;
  message: string;
  transitions: AccountTransition[];
  snapshot: unknown;
}

type Sub2apiEnvelope = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 1000;

export function normalizeOwnedSiteBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new UpstreamError('站点链接不能为空', 400);
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, '');
}

function siteUrl(site: OwnedSiteRecord, path: string): string {
  return `${site.base_url}/api/v1${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function unwrapSub2apiAdmin(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const envelope = payload as Sub2apiEnvelope;
  if ('code' in envelope) {
    if (envelope.code === 0 || envelope.code === '0') return envelope.data;
    throw new UpstreamError(extractMessage(payload) || 'sub2api 返回业务错误', 502, payload);
  }
  if ('data' in envelope && ('message' in envelope || 'success' in envelope)) return envelope.data;
  return payload;
}

async function ownedSiteRequest(site: OwnedSiteRecord, path: string, init: RequestInit = {}): Promise<unknown> {
  if (!site.admin_api_key) throw new UpstreamError('自有站点需要 Admin API Key', 400);
  const response = await requestJson(siteUrl(site, path), {
    ...init,
    headers: {
      'x-api-key': site.admin_api_key,
      ...(init.headers || {})
    }
  });
  return unwrapSub2apiAdmin(response.data);
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function optionalString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function asPage(value: unknown, fallbackPage: number, fallbackPageSize: number): PaginatedResult<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return {
      items: value.filter(isRecord),
      total: value.length,
      page: fallbackPage,
      page_size: fallbackPageSize,
      pages: Math.max(1, Math.ceil(value.length / fallbackPageSize))
    };
  }
  if (!isRecord(value)) {
    return { items: [], total: 0, page: fallbackPage, page_size: fallbackPageSize, pages: 1 };
  }
  const itemsValue = [value.items, value.data, value.rows, value.list, value.accounts, value.groups].find(Array.isArray) as unknown[] | undefined;
  const items = (itemsValue || []).filter(isRecord);
  const total = numberValue(value.total ?? value.count ?? items.length, items.length);
  const page = Math.max(1, numberValue(value.page, fallbackPage));
  const pageSize = Math.max(1, numberValue(value.page_size ?? value.pageSize ?? value.limit, fallbackPageSize));
  return {
    items,
    total,
    page,
    page_size: pageSize,
    pages: Math.max(1, numberValue(value.pages, Math.ceil(total / pageSize)))
  };
}

function normalizePage(value: unknown, fallback = 1): number {
  return Math.max(1, Math.floor(numberValue(value, fallback)));
}

function normalizePageSize(value: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(numberValue(value, fallback))));
}

export function normalizeAccountQuery(query: Record<string, unknown>): Required<Pick<OwnedSiteAccountQuery, 'page' | 'page_size'>> & Omit<OwnedSiteAccountQuery, 'page' | 'page_size'> {
  const sortOrder = stringValue(query.sort_order).toLowerCase();
  return {
    page: normalizePage(query.page),
    page_size: normalizePageSize(query.page_size),
    search: stringValue(query.search),
    group: stringValue(query.group),
    status: stringValue(query.status),
    platform: stringValue(query.platform),
    type: stringValue(query.type),
    sort_by: stringValue(query.sort_by),
    sort_order: sortOrder === 'desc' || sortOrder === 'asc' ? sortOrder : undefined
  };
}

function queryString(query: OwnedSiteAccountQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page || 1));
  params.set('page_size', String(query.page_size || DEFAULT_PAGE_SIZE));
  for (const key of ['search', 'group', 'status', 'platform', 'type', 'sort_by', 'sort_order'] as const) {
    const value = query[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') params.set(key, String(value));
  }
  return params.toString();
}

function groupIdsFromAccount(record: Record<string, unknown>): string[] {
  const direct = record.group_ids ?? record.groupIds;
  if (Array.isArray(direct)) return direct.map(String).map((item) => item.trim()).filter(Boolean);
  const groups = record.groups ?? record.Groups;
  if (Array.isArray(groups)) {
    return groups
      .flatMap((item) => {
        if (isRecord(item)) return [item.id, item.ID, item.group_id];
        return [item];
      })
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const accountGroups = record.account_groups ?? record.AccountGroups;
  if (Array.isArray(accountGroups)) {
    return accountGroups
      .flatMap((item) => (isRecord(item) ? [item.group_id, item.groupId, item.id] : []))
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const groupId = record.group_id ?? record.groupId;
  const text = stringValue(groupId);
  return text ? [text] : [];
}

function groupsFromAccount(record: Record<string, unknown>): Array<Record<string, unknown>> {
  const groups = record.groups ?? record.Groups;
  if (Array.isArray(groups)) return groups.filter(isRecord);
  const accountGroups = record.account_groups ?? record.AccountGroups;
  if (Array.isArray(accountGroups)) {
    return accountGroups
      .filter(isRecord)
      .map((item) => (isRecord(item.group) ? item.group : item));
  }
  return [];
}

export function normalizeOwnedSiteAccount(record: Record<string, unknown>): OwnedSiteAccount {
  const id = stringValue(record.id ?? record.ID);
  const name = stringValue(record.name ?? record.email ?? id);
  return {
    id,
    name,
    platform: stringValue(record.platform),
    type: stringValue(record.type),
    status: stringValue(record.status),
    schedulable: typeof record.schedulable === 'boolean' ? record.schedulable : null,
    error_message: stringValue(record.error_message ?? record.errorMessage ?? record.error),
    group_ids: groupIdsFromAccount(record),
    groups: groupsFromAccount(record),
    last_used_at: optionalString(record.last_used_at ?? record.lastUsedAt),
    updated_at: optionalString(record.updated_at ?? record.updatedAt),
    raw: record
  };
}

export function normalizeOwnedSiteGroup(record: Record<string, unknown>): OwnedSiteGroup {
  const id = stringValue(record.id ?? record.ID);
  return {
    id,
    name: stringValue(record.name ?? record.display_name ?? record.title ?? id),
    platform: stringValue(record.platform),
    status: stringValue(record.status),
    raw: record
  };
}

export async function fetchOwnedSiteGroups(site: OwnedSiteRecord): Promise<OwnedSiteGroup[]> {
  const payload = await ownedSiteRequest(site, '/admin/groups/all').catch(async (error) => {
    if (error instanceof UpstreamError && [404, 405].includes(error.status)) return ownedSiteRequest(site, '/admin/groups?page=1&page_size=1000');
    throw error;
  });
  const page = asPage(payload, 1, 1000);
  return page.items.map(normalizeOwnedSiteGroup);
}

export async function fetchOwnedSiteAccounts(site: OwnedSiteRecord, query: OwnedSiteAccountQuery = {}): Promise<PaginatedResult<OwnedSiteAccount>> {
  const normalized = normalizeAccountQuery(query as Record<string, unknown>);
  const payload = await ownedSiteRequest(site, `/admin/accounts?${queryString(normalized)}`);
  const page = asPage(payload, normalized.page, normalized.page_size);
  return {
    ...page,
    items: page.items.map(normalizeOwnedSiteAccount).filter((account) => account.id)
  };
}

export async function fetchOwnedSiteAccount(site: OwnedSiteRecord, accountId: string): Promise<OwnedSiteAccount | null> {
  const id = stringValue(accountId);
  if (!id) return null;
  try {
    const payload = await ownedSiteRequest(site, `/admin/accounts/${encodeURIComponent(id)}`);
    return isRecord(payload) ? normalizeOwnedSiteAccount(payload) : null;
  } catch (error) {
    if (!(error instanceof UpstreamError) || ![404, 405].includes(error.status)) throw error;
    const page = await fetchOwnedSiteAccounts(site, { page: 1, page_size: 1000, search: id });
    return page.items.find((account) => account.id === id) || null;
  }
}

function cachedAccountQueryKey(siteId: number, query: OwnedSiteAccountQuery): string {
  const normalized = normalizeAccountQuery(query as Record<string, unknown>);
  return `${siteId}:${queryString(normalized)}`;
}

function cachedAccountIdKey(siteId: number, accountId: string): string {
  return `${siteId}:${accountId}`;
}

function fetchOwnedSiteAccountsCached(site: OwnedSiteRecord, query: OwnedSiteAccountQuery, cache?: OwnedSiteTaskRunCache): Promise<PaginatedResult<OwnedSiteAccount>> {
  if (!cache) return fetchOwnedSiteAccounts(site, query);
  const key = cachedAccountQueryKey(site.id, query);
  const existing = cache.accountsByQuery.get(key);
  if (existing) return existing;
  const pending = fetchOwnedSiteAccounts(site, query);
  cache.accountsByQuery.set(key, pending);
  return pending;
}

function fetchOwnedSiteAccountCached(site: OwnedSiteRecord, accountId: string, cache?: OwnedSiteTaskRunCache): Promise<OwnedSiteAccount | null> {
  if (!cache) return fetchOwnedSiteAccount(site, accountId);
  const key = cachedAccountIdKey(site.id, accountId);
  const existing = cache.accountById.get(key);
  if (existing) return existing;
  const pending = fetchOwnedSiteAccount(site, accountId);
  cache.accountById.set(key, pending);
  return pending;
}

export async function checkOwnedSite(db: DatabaseSync, siteId: number): Promise<SafeOwnedSite> {
  const site = getOwnedSite(db, siteId);
  if (!site) throw new UpstreamError('自有站点不存在', 404);
  db.prepare('UPDATE owned_sites SET status = ?, updated_at = ? WHERE id = ?').run('syncing', nowIso(), site.id);
  try {
    await fetchOwnedSiteGroups(site);
    db.prepare(`
      UPDATE owned_sites
      SET status = 'active', last_check_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), site.id);
  } catch (error) {
    db.prepare(`
      UPDATE owned_sites
      SET status = 'error', last_error = ?, updated_at = ?
      WHERE id = ?
    `).run((error as Error).message, nowIso(), site.id);
    throw error;
  }
  const updated = getOwnedSite(db, site.id);
  if (!updated) throw new UpstreamError('自有站点不存在', 404);
  return sanitizeOwnedSite(updated);
}

export function upsertOwnedSiteAccountState(db: DatabaseSync, siteId: number, account: OwnedSiteAccount, checkedAt = nowIso()): void {
  db.prepare(`
    INSERT INTO owned_site_account_state (
      site_id, account_id, account_name, status, error_message, group_ids_json, raw_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, account_id)
    DO UPDATE SET
      account_name = excluded.account_name,
      status = excluded.status,
      error_message = excluded.error_message,
      group_ids_json = excluded.group_ids_json,
      raw_json = excluded.raw_json,
      checked_at = excluded.checked_at
  `).run(
    siteId,
    account.id,
    account.name || null,
    account.status || null,
    account.error_message || null,
    JSON.stringify(account.group_ids),
    JSON.stringify(account.raw),
    checkedAt
  );
}

function previousState(db: DatabaseSync, siteId: number, accountId: string): OwnedSiteAccountStateRecord | null {
  return (
    (db.prepare('SELECT * FROM owned_site_account_state WHERE site_id = ? AND account_id = ?').get(siteId, accountId) as
      | OwnedSiteAccountStateRecord
      | undefined) || null
  );
}

function taskTargetLabel(task: OwnedSiteAutomationTaskRecord): string {
  if (task.target_type === 'account') return `账号 ${task.target_account_name || task.target_account_id}`;
  return `分组 ${task.target_group_name || task.target_group_id}`;
}

export async function evaluateOwnedSiteTask(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  task: OwnedSiteAutomationTaskRecord,
  cache?: OwnedSiteTaskRunCache
): Promise<OwnedSiteAlertEvaluation> {
  const checkedAt = nowIso();
  let accounts: OwnedSiteAccount[] = [];
  if (task.target_type === 'account') {
    if (!task.target_account_id) {
      throw new UpstreamError('账号错误告警任务缺少账号 ID', 400);
    }
    const account = await fetchOwnedSiteAccountCached(site, task.target_account_id, cache);
    accounts = account ? [account] : [];
  } else {
    if (!task.target_group_id) throw new UpstreamError('账号错误告警任务缺少分组 ID', 400);
    const firstPage = await fetchOwnedSiteAccountsCached(site, { page: 1, page_size: 1000, group: task.target_group_id }, cache);
    accounts = [...firstPage.items];
    const maxPages = Math.min(firstPage.pages, 50);
    for (let page = 2; page <= maxPages; page += 1) {
      const next = await fetchOwnedSiteAccountsCached(site, { page, page_size: 1000, group: task.target_group_id }, cache);
      accounts.push(...next.items);
    }
  }

  const transitions: AccountTransition[] = [];
  let hasAnyBaseline = false;
  for (const account of accounts) {
    const previous = previousState(db, site.id, account.id);
    if (previous) hasAnyBaseline = true;
    if (
      account.status === 'error' &&
      ((!previous && task.last_run_at === null) || (previous && previous.status !== 'error'))
    ) {
      transitions.push({ account, previous });
    }
    upsertOwnedSiteAccountState(db, site.id, account, checkedAt);
  }

  if (!hasAnyBaseline) {
    if (transitions.length) {
      return {
        triggered: true,
        message: `${site.name} ${taskTargetLabel(task)} 首次检查发现 ${transitions.length} 个账号已异常：${transitions
          .map((item) => `${item.account.name || item.account.id}(首次 -> error${item.account.error_message ? `：${item.account.error_message}` : ''})`)
          .join('；')}`,
        transitions,
        snapshot: { accounts, transitions, baseline: false }
      };
    }
    return {
      triggered: false,
      message: `${site.name} ${taskTargetLabel(task)} 首次检查，仅建立账号状态基线`,
      transitions: [],
      snapshot: { accounts, baseline: false }
    };
  }

  const message = transitions.length
    ? `${site.name} ${taskTargetLabel(task)} 发现 ${transitions.length} 个账号变为异常：${transitions
        .map((item) => `${item.account.name || item.account.id}(${item.previous?.status || '-'} -> error${item.account.error_message ? `：${item.account.error_message}` : ''})`)
        .join('；')}`
    : `${site.name} ${taskTargetLabel(task)} 未发现账号状态变为异常`;
  return {
    triggered: transitions.length > 0,
    message,
    transitions,
    snapshot: { accounts, transitions, baseline: true }
  };
}

function minutesSince(value: string | null, now = new Date()): number {
  if (!value) return Infinity;
  return (now.getTime() - new Date(value).getTime()) / 60000;
}

function alertTargetId(task: OwnedSiteAutomationTaskRecord): string | null {
  return task.target_type === 'account' ? task.target_account_id : task.target_group_id;
}

export async function recordOwnedSiteAlert(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  task: OwnedSiteAutomationTaskRecord,
  evaluation: OwnedSiteAlertEvaluation,
  now: Date,
  mailer: typeof sendEmail = sendEmail
): Promise<void> {
  if (!evaluation.triggered) return;
  if (minutesSince(task.last_alert_at, now) < task.cooldown_minutes) return;
  const recipients = parseJson<string[]>(task.recipients_json, []);
  const fallbackRecipients = getEmailSettings(db).default_recipients;
  let emailSent = 0;
  let emailError: string | null = null;
  try {
    await mailer(db, recipients.length ? recipients : fallbackRecipients, 'AI 自有站点账号预警', evaluation.message);
    emailSent = 1;
  } catch (error) {
    emailError = (error as Error).message;
  }

  for (const transition of evaluation.transitions) {
    db.prepare(`
      INSERT INTO owned_site_alert_events (
        site_id, task_id, type, target_type, target_id, account_id, account_name, site_name, message,
        before_status, after_status, snapshot_json, email_sent, email_error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      site.id,
      task.id,
      task.type,
      task.target_type,
      alertTargetId(task),
      transition.account.id,
      transition.account.name || null,
      site.name,
      evaluation.message,
      transition.previous?.status || null,
      transition.account.status || null,
      JSON.stringify({ transition, task, site: sanitizeOwnedSite(site) }),
      emailSent,
      emailError,
      nowIso(now)
    );
  }
  db.prepare('UPDATE owned_site_automation_tasks SET last_alert_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), task.id);
}

export async function runDueOwnedSiteTasks(db: DatabaseSync, mailer: typeof sendEmail = sendEmail): Promise<void> {
  const rows = db.prepare(`
    SELECT t.*, s.name AS site_name
    FROM owned_site_automation_tasks t
    JOIN owned_sites s ON s.id = t.site_id
    WHERE t.enabled = 1
  `).all() as unknown as Array<OwnedSiteAutomationTaskRecord & { site_name: string }>;
  const now = new Date();
  const dueRows = rows.filter((row) => minutesSince(row.last_run_at, now) >= row.interval_minutes);
  const cacheBySite = new Map<number, OwnedSiteTaskRunCache>();
  for (const row of dueRows) {
    db.prepare('UPDATE owned_site_automation_tasks SET last_run_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), row.id);
    const site = getOwnedSite(db, row.site_id);
    if (!site) continue;
    let cache = cacheBySite.get(site.id);
    if (!cache) {
      cache = { accountsByQuery: new Map(), accountById: new Map() };
      cacheBySite.set(site.id, cache);
    }
    try {
      const evaluation = await evaluateOwnedSiteTask(db, site, row, cache);
      db.prepare(`
        UPDATE owned_sites
        SET status = 'active', last_check_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(now), nowIso(now), site.id);
      await recordOwnedSiteAlert(db, site, row, evaluation, now, mailer);
    } catch (error) {
      db.prepare(`
        UPDATE owned_sites
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run((error as Error).message, nowIso(now), site.id);
    }
  }
}

export function normalizeOwnedSiteTaskPayload(
  body: Record<string, unknown>,
  partial = false
): {
  enabled?: number;
  target_type?: OwnedSiteTaskTargetType;
  target_account_id?: string | null;
  target_account_name?: string | null;
  target_group_id?: string | null;
  target_group_name?: string | null;
  interval_minutes?: number;
  cooldown_minutes?: number;
  recipients_json?: string;
} {
  const type = stringValue(body.type || 'account_error');
  if (type !== 'account_error') throw new UpstreamError('任务类型无效', 400);
  const targetType = body.target_type === undefined ? undefined : stringValue(body.target_type);
  if (!partial && targetType !== 'account' && targetType !== 'group') throw new UpstreamError('任务目标类型无效', 400);
  if (partial && targetType !== undefined && targetType !== 'account' && targetType !== 'group') throw new UpstreamError('任务目标类型无效', 400);

  const payload = {
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled) ? 1 : 0,
    target_type: targetType as OwnedSiteTaskTargetType | undefined,
    target_account_id: body.target_account_id === undefined ? undefined : stringValue(body.target_account_id) || null,
    target_account_name: body.target_account_name === undefined ? undefined : stringValue(body.target_account_name) || null,
    target_group_id: body.target_group_id === undefined ? undefined : stringValue(body.target_group_id) || null,
    target_group_name: body.target_group_name === undefined ? undefined : stringValue(body.target_group_name) || null,
    interval_minutes: body.interval_minutes === undefined ? undefined : Math.max(1, numberValue(body.interval_minutes, 1)),
    cooldown_minutes: body.cooldown_minutes === undefined ? undefined : Math.max(0, numberValue(body.cooldown_minutes, 30)),
    recipients_json: body.recipients === undefined ? undefined : JSON.stringify(splitRecipients(body.recipients))
  };

  const resolvedTarget = payload.target_type;
  if (!partial && resolvedTarget === 'account' && !payload.target_account_id) throw new UpstreamError('请选择要监控的账号', 400);
  if (!partial && resolvedTarget === 'group' && !payload.target_group_id) throw new UpstreamError('请选择要监控的分组', 400);
  return payload;
}
