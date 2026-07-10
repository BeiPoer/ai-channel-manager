import { DatabaseSync } from 'node:sqlite';
import { getEmailSettings, sendEmail } from './email.js';
import { extractMessage, requestJson, UpstreamError } from './http.js';
import { getOwnedSite, nowIso, parseJson, sanitizeOwnedSite, splitRecipients } from './db.js';
import type {
  OwnedSiteAccountStateRecord,
  OwnedSiteAutomationTaskRecord,
  OwnedSiteRecord,
  OwnedSiteTaskType,
  OwnedSiteTaskTargetType,
  OwnedSiteUpstreamAlertSettingRecord,
  OwnedSiteUpstreamGroupMonitorRecord,
  OwnedSiteUpstreamMonitorRecord,
  OwnedSiteUpstreamMonitorResultRecord,
  OwnedSiteUpstreamMonitorStatus,
  OwnedSiteUpstreamTimelineStatus,
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

interface OwnedSiteUsageRecord {
  id: string;
  request_id: string | null;
  model: string | null;
  account_id: string | null;
  account_name: string | null;
  group_id: string | null;
  group_name: string | null;
  first_token_ms: number | null;
  created_at: string;
  raw: Record<string, unknown>;
}

interface OwnedSiteLatencySample {
  id: string;
  request_id: string | null;
  model: string | null;
  account_id: string | null;
  account_name: string | null;
  group_id: string | null;
  group_name: string | null;
  first_token_ms: number;
  created_at: string;
}

interface SlowSampleAccountCount {
  name: string;
  count: number;
}

export interface OwnedSiteAlertEvaluation {
  triggered: boolean;
  message: string;
  transitions: AccountTransition[];
  snapshot: unknown;
}

export interface OwnedSiteFirstTokenLatencyEvaluation {
  triggered: boolean;
  message: string;
  samples: OwnedSiteLatencySample[];
  slow_samples: OwnedSiteLatencySample[];
  scanned_pages: number;
  snapshot: unknown;
}

export interface OwnedSiteUpstreamMonitor {
  id: number | null;
  site_id: number;
  account_id: string;
  account_name: string | null;
  account_platform: string | null;
  account_type: string | null;
  group_ids: string[];
  enabled: boolean;
  interval_minutes: number;
  retry_count: number;
  pause_start_time: string;
  pause_end_time: string;
  skip_model_patterns: string[];
  last_run_at: string | null;
  last_status: OwnedSiteUpstreamMonitorStatus | null;
  last_error: string | null;
  last_latency_ms: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface OwnedSiteUpstreamGroupMonitor {
  id: number | null;
  site_id: number;
  group_id: string;
  group_name: string | null;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface OwnedSiteUpstreamAlertSetting {
  site_id: number;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface OwnedSiteUpstreamTimelinePoint {
  minute: string;
  bucket_minutes: number;
  status: OwnedSiteUpstreamTimelineStatus;
  model: string | null;
  attempt_count: number | null;
  success_count: number | null;
  failure_count: number | null;
  latency_ms: number | null;
  message: string;
  checked_at: string | null;
}

export interface OwnedSiteUpstreamModelTimeline {
  model: string;
  latest_result: OwnedSiteUpstreamMonitorResultRecord | null;
  timeline: OwnedSiteUpstreamTimelinePoint[];
}

export interface OwnedSiteUpstreamAccount {
  account: OwnedSiteAccount;
  monitor: OwnedSiteUpstreamMonitor;
  group_monitor: OwnedSiteUpstreamGroupMonitor;
  latest_result: OwnedSiteUpstreamMonitorResultRecord | null;
  timeline: OwnedSiteUpstreamTimelinePoint[];
  model_timelines: OwnedSiteUpstreamModelTimeline[];
  model_list_error: string | null;
}

export interface OwnedSiteUpstreamRunResult {
  monitor: OwnedSiteUpstreamMonitor;
  status: OwnedSiteUpstreamMonitorStatus;
  models: string[];
  tested_models: string[];
  skipped_models: string[];
  results: Array<{
    model: string | null;
    status: OwnedSiteUpstreamMonitorStatus;
    attempt_count: number | null;
    success_count: number | null;
    failure_count: number | null;
    latency_ms: number | null;
    message: string;
  }>;
}

type Sub2apiEnvelope = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_MONITOR_INTERVAL_MINUTES = 10;
const DEFAULT_SKIP_MODEL_PATTERNS = ['gpt-image-*', 'codex-auto-review'];
const DEFAULT_MONITOR_RETRY_COUNT = 2;
const DEFAULT_MONITOR_PAUSE_START_TIME = '01:00';
const DEFAULT_MONITOR_PAUSE_END_TIME = '08:00';
const MIN_MONITOR_RETRY_COUNT = 0;
const MAX_MONITOR_RETRY_COUNT = 5;
const MIN_MONITOR_INTERVAL_MINUTES = 1;
const MAX_MONITOR_INTERVAL_MINUTES = 1440;
const UPSTREAM_TIMELINE_LOOKBACK_MINUTES = 120;
const UPSTREAM_ALERT_FAILURE_ATTEMPTS = 3;
const UPSTREAM_ALERT_DEDUPE_MINUTES = 60;
export const FIRST_TOKEN_LATENCY_TASK_TYPE = 'group_first_token_latency';
export const FIRST_TOKEN_LATENCY_DEFAULT_LOOKBACK_MINUTES = 10;
export const FIRST_TOKEN_LATENCY_DEFAULT_SAMPLE_SIZE = 20;
export const FIRST_TOKEN_LATENCY_DEFAULT_BREACH_COUNT = 5;
export const FIRST_TOKEN_LATENCY_DEFAULT_THRESHOLD_MS = 7000;
export const FIRST_TOKEN_LATENCY_DEFAULT_COOLDOWN_MINUTES = 10;
const FIRST_TOKEN_LATENCY_MAX_SAMPLE_SIZE = 1000;
const FIRST_TOKEN_LATENCY_MAX_SCAN_PAGES = 5;
const FIRST_TOKEN_LATENCY_USAGE_PAGE_SIZE = 1000;

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

async function ownedSiteRawRequest(site: OwnedSiteRecord, path: string, init: RequestInit = {}, timeoutMs = 60000): Promise<{ status: number; text: string; contentType: string }> {
  if (!site.admin_api_key) throw new UpstreamError('自有站点需要 Admin API Key', 400);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(siteUrl(site, path), {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/event-stream, text/plain',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        'x-api-key': site.admin_api_key,
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { text };
      }
      throw new UpstreamError(extractMessage(payload) || `上游请求失败：HTTP ${response.status}`, response.status, payload, 'upstream');
    }
    return {
      status: response.status,
      text,
      contentType: response.headers.get('content-type') || ''
    };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if ((error as Error).name === 'AbortError') throw new UpstreamError('上游请求超时', 504, undefined, 'upstream');
    throw new UpstreamError((error as Error).message || '上游请求失败', 502, undefined, 'upstream');
  } finally {
    clearTimeout(timeout);
  }
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function lowerString(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function optionalString(value: unknown): string | null {
  const text = stringValue(value);
  return text || null;
}

function objectString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return optionalString(value);
  for (const key of keys) {
    const text = optionalString(value[key]);
    if (text) return text;
  }
  return null;
}

function usageAccountId(record: Record<string, unknown>): string | null {
  return (
    optionalString(
      record.account_id ??
        record.accountId ??
        record.upstream_account_id ??
        record.upstreamAccountId ??
        record.upstream_id ??
        record.upstreamId ??
        record.channel_id ??
        record.channelId
    ) ||
    objectString(record.account, ['id', 'account_id', 'accountId']) ||
    objectString(record.upstream_account ?? record.upstreamAccount, ['id', 'account_id', 'accountId']) ||
    objectString(record.upstream, ['id', 'account_id', 'accountId', 'upstream_id', 'upstreamId']) ||
    objectString(record.channel, ['id', 'account_id', 'accountId', 'channel_id', 'channelId'])
  );
}

function usageAccountName(record: Record<string, unknown>): string | null {
  return (
    optionalString(
      record.account_name ??
        record.accountName ??
        record.upstream_account_name ??
        record.upstreamAccountName ??
        record.upstream_name ??
        record.upstreamName ??
        record.channel_name ??
        record.channelName
    ) ||
    objectString(record.account, ['name', 'account_name', 'accountName', 'title', 'label', 'id']) ||
    objectString(record.upstream_account ?? record.upstreamAccount, ['name', 'account_name', 'accountName', 'title', 'label', 'id']) ||
    objectString(record.upstream, ['name', 'account_name', 'accountName', 'title', 'label', 'id']) ||
    objectString(record.channel, ['name', 'account_name', 'accountName', 'title', 'label', 'id'])
  );
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

function isSupportedUpstreamAccount(account: OwnedSiteAccount): boolean {
  const platform = lowerString(account.platform);
  return lowerString(account.type) === 'apikey' && lowerString(account.status) === 'active' && (platform === 'openai' || platform === 'anthropic' || platform === 'claude');
}

function normalizeMonitorInterval(value: unknown): number {
  const parsed = Math.floor(numberValue(value, DEFAULT_MONITOR_INTERVAL_MINUTES));
  if (parsed < MIN_MONITOR_INTERVAL_MINUTES || parsed > MAX_MONITOR_INTERVAL_MINUTES) {
    throw new UpstreamError(`测试间隔需在 ${MIN_MONITOR_INTERVAL_MINUTES} 到 ${MAX_MONITOR_INTERVAL_MINUTES} 分钟之间`, 400);
  }
  return parsed;
}

function normalizeMonitorRetryCount(value: unknown): number {
  const parsed = Math.floor(numberValue(value, DEFAULT_MONITOR_RETRY_COUNT));
  if (parsed < MIN_MONITOR_RETRY_COUNT || parsed > MAX_MONITOR_RETRY_COUNT) {
    throw new UpstreamError(`重试次数需在 ${MIN_MONITOR_RETRY_COUNT} 到 ${MAX_MONITOR_RETRY_COUNT} 次之间`, 400);
  }
  return parsed;
}

function normalizeMonitorPauseTime(value: unknown, fallback: string): string {
  const raw = stringValue(value) || fallback;
  const match = raw.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (!match) throw new UpstreamError('暂停时间段需使用 24 小时制 HH:mm 格式', 400);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new UpstreamError('暂停时间段需使用 24 小时制 HH:mm 格式', 400);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function monitorPauseTimeToMinutes(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function isWithinMonitorPauseWindow(startTime: string, endTime: string, now = new Date()): boolean {
  const start = monitorPauseTimeToMinutes(startTime);
  const end = monitorPauseTimeToMinutes(endTime);
  if (start === null || end === null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function normalizeSkipModelPatterns(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n;]/) : [];
  return Array.from(
    new Set(
      source
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function modelMatchesPattern(model: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return false;
  const regex = new RegExp(`^${normalizedPattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(model);
}

export function filterSkippedModels(models: string[], patterns: string[]): { tested: string[]; skipped: string[] } {
  const tested: string[] = [];
  const skipped: string[] = [];
  for (const model of models) {
    if (patterns.some((pattern) => modelMatchesPattern(model, pattern))) skipped.push(model);
    else tested.push(model);
  }
  return { tested, skipped };
}

function normalizeModelId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  return stringValue(value.id ?? value.name ?? value.model ?? value.value);
}

function normalizeModelList(payload: unknown): string[] {
  const source = isRecord(payload) && Array.isArray(payload.models) ? payload.models : payload;
  if (!Array.isArray(source)) return [];
  return Array.from(new Set(source.map(normalizeModelId).filter(Boolean)));
}

export async function fetchOwnedSiteAccountModels(site: OwnedSiteRecord, accountId: string): Promise<string[]> {
  const payload = await ownedSiteRequest(site, `/admin/accounts/${encodeURIComponent(accountId)}/models`);
  return normalizeModelList(payload);
}

function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  const chunks = text.split(/\r?\n\r?\n/);
  for (const chunk of chunks) {
    const dataLines = chunk
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== '[DONE]');
    for (const line of dataLines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ text: line });
      }
    }
  }
  return events;
}

function parseSub2apiTestResponse(text: string): { success: boolean; message: string; raw: unknown } {
  const trimmed = text.trim();
  if (!trimmed) return { success: true, message: '测试完成', raw: null };
  const events = parseSseEvents(trimmed);
  if (events.length) {
    let message = '';
    for (const event of events) {
      if (!isRecord(event)) continue;
      const type = stringValue(event.type);
      if (type === 'error' || event.success === false) {
        return { success: false, message: stringValue(event.error ?? event.message) || '测试失败', raw: events };
      }
      if (type === 'test_complete' || event.success === true) {
        message = stringValue(event.message) || message || '测试成功';
      } else if (stringValue(event.error)) {
        return { success: false, message: stringValue(event.error), raw: events };
      } else if (stringValue(event.message)) {
        message = stringValue(event.message);
      }
    }
    return { success: true, message: message || '测试成功', raw: events };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const payload = unwrapSub2apiAdmin(parsed);
    if (isRecord(payload)) {
      if (payload.success === false) return { success: false, message: extractMessage(payload) || '测试失败', raw: parsed };
      if (payload.ok === false) return { success: false, message: extractMessage(payload) || '测试失败', raw: parsed };
    }
    return { success: true, message: extractMessage(payload) || extractMessage(parsed) || '测试成功', raw: parsed };
  } catch {
    const failed = /error|failed|失败|异常/i.test(trimmed);
    return { success: !failed, message: trimmed.slice(0, 500) || (failed ? '测试失败' : '测试成功'), raw: { text: trimmed } };
  }
}

async function runSingleSub2apiAccountTest(site: OwnedSiteRecord, accountId: string, model: string): Promise<{ success: boolean; latency_ms: number; message: string; raw: unknown }> {
  const started = Date.now();
  try {
    const response = await ownedSiteRawRequest(
      site,
      `/admin/accounts/${encodeURIComponent(accountId)}/test`,
      {
        method: 'POST',
        body: JSON.stringify({ model_id: model })
      },
      120000
    );
    const parsed = parseSub2apiTestResponse(response.text);
    return {
      success: parsed.success,
      latency_ms: Date.now() - started,
      message: parsed.message,
      raw: parsed.raw
    };
  } catch (error) {
    return {
      success: false,
      latency_ms: Date.now() - started,
      message: (error as Error).message || '测试失败',
      raw: error instanceof UpstreamError ? error.details : { error: (error as Error).message }
    };
  }
}

async function runSub2apiAccountTest(
  site: OwnedSiteRecord,
  accountId: string,
  model: string,
  retryCount: number
): Promise<{
  status: OwnedSiteUpstreamMonitorStatus;
  latency_ms: number;
  message: string;
  raw: unknown;
  attempt_count: number;
  success_count: number;
  failure_count: number;
}> {
  const attempts: Array<{ success: boolean; latency_ms: number; message: string; raw: unknown }> = [];
  const maxAttempts = 1 + normalizeMonitorRetryCount(retryCount);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runSingleSub2apiAccountTest(site, accountId, model);
    attempts.push(result);
    if (result.success) break;
  }
  const successCount = attempts.filter((attempt) => attempt.success).length;
  const failureCount = attempts.length - successCount;
  const status: OwnedSiteUpstreamMonitorStatus = successCount > 0 && failureCount > 0 ? 'partial' : successCount > 0 ? 'success' : 'failed';
  const last = attempts[attempts.length - 1];
  return {
    status,
    latency_ms: attempts.reduce((sum, attempt) => sum + attempt.latency_ms, 0),
    message:
      status === 'partial'
        ? `部分成功：成功 ${successCount} 次，失败 ${failureCount} 次`
        : last?.message || (status === 'success' ? '测试成功' : '测试失败'),
    raw: { attempts },
    attempt_count: attempts.length,
    success_count: successCount,
    failure_count: failureCount
  };
}

function parseMonitor(row: OwnedSiteUpstreamMonitorRecord | null | undefined, siteId: number, account: OwnedSiteAccount): OwnedSiteUpstreamMonitor {
  if (!row) {
    return {
      id: null,
      site_id: siteId,
      account_id: account.id,
      account_name: account.name || null,
      account_platform: account.platform || null,
      account_type: account.type || null,
      group_ids: account.group_ids,
      enabled: false,
      interval_minutes: DEFAULT_MONITOR_INTERVAL_MINUTES,
      retry_count: DEFAULT_MONITOR_RETRY_COUNT,
      pause_start_time: DEFAULT_MONITOR_PAUSE_START_TIME,
      pause_end_time: DEFAULT_MONITOR_PAUSE_END_TIME,
      skip_model_patterns: DEFAULT_SKIP_MODEL_PATTERNS,
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_latency_ms: null,
      created_at: null,
      updated_at: null
    };
  }
  return {
    id: row.id,
    site_id: row.site_id,
    account_id: row.account_id,
    account_name: row.account_name,
    account_platform: row.account_platform,
    account_type: row.account_type,
    group_ids: parseJson<string[]>(row.group_ids_json, []),
    enabled: Boolean(row.enabled),
    interval_minutes: row.interval_minutes,
    retry_count: row.retry_count,
    pause_start_time: normalizeMonitorPauseTime(row.pause_start_time, DEFAULT_MONITOR_PAUSE_START_TIME),
    pause_end_time: normalizeMonitorPauseTime(row.pause_end_time, DEFAULT_MONITOR_PAUSE_END_TIME),
    skip_model_patterns: parseJson<string[]>(row.skip_model_patterns_json, []),
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    last_latency_ms: row.last_latency_ms,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getMonitorRow(db: DatabaseSync, siteId: number, accountId: string): OwnedSiteUpstreamMonitorRecord | null {
  return (
    (db.prepare('SELECT * FROM owned_site_upstream_monitors WHERE site_id = ? AND account_id = ?').get(siteId, accountId) as
      | OwnedSiteUpstreamMonitorRecord
      | undefined) || null
  );
}

function parseGroupMonitor(row: OwnedSiteUpstreamGroupMonitorRecord | null | undefined, siteId: number, groupId: string, groupName: string | null): OwnedSiteUpstreamGroupMonitor {
  if (!row) {
    return {
      id: null,
      site_id: siteId,
      group_id: groupId,
      group_name: groupName,
      enabled: false,
      created_at: null,
      updated_at: null
    };
  }
  return {
    id: row.id,
    site_id: row.site_id,
    group_id: row.group_id,
    group_name: row.group_name,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getGroupMonitorRow(db: DatabaseSync, siteId: number, groupId: string): OwnedSiteUpstreamGroupMonitorRecord | null {
  return (
    (db.prepare('SELECT * FROM owned_site_upstream_group_monitors WHERE site_id = ? AND group_id = ?').get(siteId, groupId) as
      | OwnedSiteUpstreamGroupMonitorRecord
      | undefined) || null
  );
}

function parseUpstreamAlertSetting(row: OwnedSiteUpstreamAlertSettingRecord | null | undefined, siteId: number): OwnedSiteUpstreamAlertSetting {
  if (!row) {
    return {
      site_id: siteId,
      enabled: false,
      created_at: null,
      updated_at: null
    };
  }
  return {
    site_id: row.site_id,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function getUpstreamAlertSettingRow(db: DatabaseSync, siteId: number): OwnedSiteUpstreamAlertSettingRecord | null {
  return (
    (db.prepare('SELECT * FROM owned_site_upstream_alert_settings WHERE site_id = ?').get(siteId) as
      | OwnedSiteUpstreamAlertSettingRecord
      | undefined) || null
  );
}

function upsertUpstreamAlertSettingSnapshot(
  db: DatabaseSync,
  siteId: number,
  existing?: OwnedSiteUpstreamAlertSettingRecord | null
): OwnedSiteUpstreamAlertSettingRecord {
  const now = nowIso();
  db.prepare(`
    INSERT INTO owned_site_upstream_alert_settings (site_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(site_id)
    DO UPDATE SET updated_at = owned_site_upstream_alert_settings.updated_at
  `).run(siteId, existing?.enabled ?? 0, now, now);
  const row = getUpstreamAlertSettingRow(db, siteId);
  if (!row) throw new UpstreamError('上游告警配置保存失败', 500);
  return row;
}

function upsertGroupMonitorSnapshot(
  db: DatabaseSync,
  siteId: number,
  groupId: string,
  groupName: string | null,
  existing?: OwnedSiteUpstreamGroupMonitorRecord | null
): OwnedSiteUpstreamGroupMonitorRecord {
  const now = nowIso();
  db.prepare(`
    INSERT INTO owned_site_upstream_group_monitors (
      site_id, group_id, group_name, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, group_id)
    DO UPDATE SET
      group_name = excluded.group_name,
      updated_at = excluded.updated_at
  `).run(siteId, groupId, groupName, existing?.enabled ?? 0, now, now);
  const row = getGroupMonitorRow(db, siteId, groupId);
  if (!row) throw new UpstreamError('分组监控配置保存失败', 500);
  return row;
}

function upsertMonitorSnapshot(db: DatabaseSync, siteId: number, account: OwnedSiteAccount, existing?: OwnedSiteUpstreamMonitorRecord | null): OwnedSiteUpstreamMonitorRecord {
  const now = nowIso();
  const shouldUpgradeLegacyDefault =
    existing && existing.interval_minutes === 30 && existing.skip_model_patterns_json === '[]' && !existing.last_run_at && !existing.last_status;
  const shouldUpgradeLegacySkipDefault = existing && existing.skip_model_patterns_json === '["gpt-image-*"]' && !existing.last_run_at && !existing.last_status;
  db.prepare(`
    INSERT INTO owned_site_upstream_monitors (
      site_id, account_id, account_name, account_platform, account_type, group_ids_json,
      enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, account_id)
    DO UPDATE SET
      account_name = excluded.account_name,
      account_platform = excluded.account_platform,
      account_type = excluded.account_type,
      group_ids_json = excluded.group_ids_json,
      interval_minutes = CASE
        WHEN owned_site_upstream_monitors.interval_minutes = 30
          AND owned_site_upstream_monitors.skip_model_patterns_json = '[]'
          AND owned_site_upstream_monitors.last_run_at IS NULL
          AND owned_site_upstream_monitors.last_status IS NULL
        THEN excluded.interval_minutes
        ELSE owned_site_upstream_monitors.interval_minutes
      END,
      skip_model_patterns_json = CASE
        WHEN owned_site_upstream_monitors.interval_minutes = 30
          AND owned_site_upstream_monitors.skip_model_patterns_json = '[]'
          AND owned_site_upstream_monitors.last_run_at IS NULL
          AND owned_site_upstream_monitors.last_status IS NULL
        THEN excluded.skip_model_patterns_json
        WHEN owned_site_upstream_monitors.skip_model_patterns_json = '["gpt-image-*"]'
          AND owned_site_upstream_monitors.last_run_at IS NULL
          AND owned_site_upstream_monitors.last_status IS NULL
        THEN excluded.skip_model_patterns_json
        ELSE owned_site_upstream_monitors.skip_model_patterns_json
      END,
      updated_at = excluded.updated_at
  `).run(
    siteId,
    account.id,
    account.name || null,
    account.platform || null,
    account.type || null,
    JSON.stringify(account.group_ids),
    existing?.enabled ?? 0,
    shouldUpgradeLegacyDefault || !existing ? DEFAULT_MONITOR_INTERVAL_MINUTES : existing.interval_minutes,
    existing?.retry_count ?? DEFAULT_MONITOR_RETRY_COUNT,
    existing?.pause_start_time ?? DEFAULT_MONITOR_PAUSE_START_TIME,
    existing?.pause_end_time ?? DEFAULT_MONITOR_PAUSE_END_TIME,
    shouldUpgradeLegacyDefault || shouldUpgradeLegacySkipDefault || !existing ? JSON.stringify(DEFAULT_SKIP_MODEL_PATTERNS) : existing.skip_model_patterns_json,
    now,
    now
  );
  const row = getMonitorRow(db, siteId, account.id);
  if (!row) throw new UpstreamError('监控配置保存失败', 500);
  return row;
}

function latestResult(db: DatabaseSync, siteId: number, accountId: string): OwnedSiteUpstreamMonitorResultRecord | null {
  return (
    (db.prepare(`
      SELECT *
      FROM owned_site_upstream_monitor_results
      WHERE site_id = ? AND account_id = ?
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    `).get(siteId, accountId) as OwnedSiteUpstreamMonitorResultRecord | undefined) || null
  );
}

function latestModelResult(db: DatabaseSync, siteId: number, accountId: string, model: string): OwnedSiteUpstreamMonitorResultRecord | null {
  return (
    (db.prepare(`
      SELECT *
      FROM owned_site_upstream_monitor_results
      WHERE site_id = ? AND account_id = ? AND model = ?
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    `).get(siteId, accountId, model) as OwnedSiteUpstreamMonitorResultRecord | undefined) || null
  );
}

function startOfMinute(date: Date): Date {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

function statusPriority(status: OwnedSiteUpstreamTimelineStatus): number {
  if (status === 'failed') return 4;
  if (status === 'partial') return 3;
  if (status === 'success') return 2;
  if (status === 'skipped') return 1;
  return 0;
}

function timelineStepMinutes(intervalMinutes: number): number {
  const parsed = Math.floor(Number(intervalMinutes) || DEFAULT_MONITOR_INTERVAL_MINUTES);
  return Math.max(MIN_MONITOR_INTERVAL_MINUTES, Math.min(MAX_MONITOR_INTERVAL_MINUTES, parsed));
}

function buildTimelineFromRows(rows: OwnedSiteUpstreamMonitorResultRecord[], start: Date, stepMinutes: number, bucketCount: number): OwnedSiteUpstreamTimelinePoint[] {
  const byMinute = new Map<string, OwnedSiteUpstreamTimelinePoint>();
  for (const row of rows) {
    const checkedAt = new Date(row.checked_at);
    const offsetMs = checkedAt.getTime() - start.getTime();
    const bucketIndex = Math.max(0, Math.min(bucketCount - 1, Math.floor(offsetMs / (stepMinutes * 60000))));
    const bucketStart = new Date(start.getTime() + bucketIndex * stepMinutes * 60000);
    const minute = nowIso(bucketStart);
    const current = byMinute.get(minute);
    if (current && statusPriority(current.status) >= statusPriority(row.status)) continue;
    byMinute.set(minute, {
      minute,
      bucket_minutes: stepMinutes,
      status: row.status,
      model: row.model,
      attempt_count: row.attempt_count,
      success_count: row.success_count,
      failure_count: row.failure_count,
      latency_ms: row.latency_ms,
      message: row.message,
      checked_at: row.checked_at
    });
  }
  const timeline: OwnedSiteUpstreamTimelinePoint[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const minute = nowIso(new Date(start.getTime() + index * stepMinutes * 60000));
    timeline.push(
      byMinute.get(minute) || {
        minute,
        bucket_minutes: stepMinutes,
        status: 'empty',
        model: null,
        attempt_count: null,
        success_count: null,
        failure_count: null,
        latency_ms: null,
        message: '',
        checked_at: null
      }
    );
  }
  return timeline;
}

function timelineWindow(intervalMinutes: number, now = new Date()): { start: Date; startIso: string; stepMinutes: number; bucketCount: number } {
  const stepMinutes = timelineStepMinutes(intervalMinutes);
  const bucketCount = Math.max(1, Math.ceil(UPSTREAM_TIMELINE_LOOKBACK_MINUTES / stepMinutes));
  const end = startOfMinute(now);
  const start = new Date(end.getTime() - (bucketCount - 1) * stepMinutes * 60000);
  return { start, startIso: nowIso(start), stepMinutes, bucketCount };
}

function buildTimeline(db: DatabaseSync, siteId: number, accountId: string, intervalMinutes: number, now = new Date()): OwnedSiteUpstreamTimelinePoint[] {
  const { start, startIso, stepMinutes, bucketCount } = timelineWindow(intervalMinutes, now);
  const rows = db.prepare(`
    SELECT *
    FROM owned_site_upstream_monitor_results
    WHERE site_id = ? AND account_id = ? AND checked_at >= ?
    ORDER BY checked_at ASC, id ASC
  `).all(siteId, accountId, startIso) as unknown as OwnedSiteUpstreamMonitorResultRecord[];
  return buildTimelineFromRows(rows, start, stepMinutes, bucketCount);
}

function buildModelTimeline(db: DatabaseSync, siteId: number, accountId: string, model: string, intervalMinutes: number, now = new Date()): OwnedSiteUpstreamTimelinePoint[] {
  const { start, startIso, stepMinutes, bucketCount } = timelineWindow(intervalMinutes, now);
  const rows = db.prepare(`
    SELECT *
    FROM owned_site_upstream_monitor_results
    WHERE site_id = ? AND account_id = ? AND model = ? AND checked_at >= ?
    ORDER BY checked_at ASC, id ASC
  `).all(siteId, accountId, model, startIso) as unknown as OwnedSiteUpstreamMonitorResultRecord[];
  return buildTimelineFromRows(rows, start, stepMinutes, bucketCount);
}

export function normalizeOwnedSiteUpstreamMonitorPayload(
  body: Record<string, unknown>,
  partial = false
): { interval_minutes?: number; retry_count?: number; pause_start_time?: string; pause_end_time?: string; skip_model_patterns?: string[] } {
  return {
    interval_minutes: body.interval_minutes === undefined ? (partial ? undefined : DEFAULT_MONITOR_INTERVAL_MINUTES) : normalizeMonitorInterval(body.interval_minutes),
    retry_count: body.retry_count === undefined ? (partial ? undefined : DEFAULT_MONITOR_RETRY_COUNT) : normalizeMonitorRetryCount(body.retry_count),
    pause_start_time:
      body.pause_start_time === undefined ? (partial ? undefined : DEFAULT_MONITOR_PAUSE_START_TIME) : normalizeMonitorPauseTime(body.pause_start_time, DEFAULT_MONITOR_PAUSE_START_TIME),
    pause_end_time:
      body.pause_end_time === undefined ? (partial ? undefined : DEFAULT_MONITOR_PAUSE_END_TIME) : normalizeMonitorPauseTime(body.pause_end_time, DEFAULT_MONITOR_PAUSE_END_TIME),
    skip_model_patterns: body.skip_model_patterns === undefined ? (partial ? undefined : DEFAULT_SKIP_MODEL_PATTERNS) : normalizeSkipModelPatterns(body.skip_model_patterns)
  };
}

export async function getOwnedSiteUpstreamGroupMonitor(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  groupId: string
): Promise<OwnedSiteUpstreamGroupMonitor> {
  const normalizedGroupId = stringValue(groupId);
  if (!normalizedGroupId) throw new UpstreamError('分组 ID 无效', 400);
  const groups = await fetchOwnedSiteGroups(site);
  const group = groups.find((item) => item.id === normalizedGroupId);
  const row = upsertGroupMonitorSnapshot(db, site.id, normalizedGroupId, group?.name || null, getGroupMonitorRow(db, site.id, normalizedGroupId));
  return parseGroupMonitor(row, site.id, normalizedGroupId, group?.name || null);
}

export async function saveOwnedSiteUpstreamGroupMonitor(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  groupId: string,
  body: Record<string, unknown>
): Promise<OwnedSiteUpstreamGroupMonitor> {
  const normalizedGroupId = stringValue(groupId);
  if (!normalizedGroupId) throw new UpstreamError('分组 ID 无效', 400);
  const groups = await fetchOwnedSiteGroups(site);
  const group = groups.find((item) => item.id === normalizedGroupId);
  const existing = upsertGroupMonitorSnapshot(db, site.id, normalizedGroupId, group?.name || null, getGroupMonitorRow(db, site.id, normalizedGroupId));
  const enabled = body.enabled === undefined ? existing.enabled : Boolean(body.enabled) ? 1 : 0;
  const now = nowIso();
  db.prepare(`
    UPDATE owned_site_upstream_group_monitors
    SET enabled = ?, group_name = ?, updated_at = ?
    WHERE id = ?
  `).run(enabled, group?.name || existing.group_name, now, existing.id);
  const row = getGroupMonitorRow(db, site.id, normalizedGroupId);
  return parseGroupMonitor(row, site.id, normalizedGroupId, group?.name || null);
}

export async function getOwnedSiteUpstreamAlertSetting(db: DatabaseSync, site: OwnedSiteRecord): Promise<OwnedSiteUpstreamAlertSetting> {
  const row = upsertUpstreamAlertSettingSnapshot(db, site.id, getUpstreamAlertSettingRow(db, site.id));
  return parseUpstreamAlertSetting(row, site.id);
}

export async function saveOwnedSiteUpstreamAlertSetting(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  body: Record<string, unknown>
): Promise<OwnedSiteUpstreamAlertSetting> {
  const existing = upsertUpstreamAlertSettingSnapshot(db, site.id, getUpstreamAlertSettingRow(db, site.id));
  const enabled = body.enabled === undefined ? existing.enabled : Boolean(body.enabled) ? 1 : 0;
  const now = nowIso();
  db.prepare(`
    UPDATE owned_site_upstream_alert_settings
    SET enabled = ?, updated_at = ?
    WHERE site_id = ?
  `).run(enabled, now, site.id);
  return parseUpstreamAlertSetting(getUpstreamAlertSettingRow(db, site.id), site.id);
}

export async function listOwnedSiteUpstreamAccounts(db: DatabaseSync, site: OwnedSiteRecord, groupId = ''): Promise<OwnedSiteUpstreamAccount[]> {
  const normalizedGroupId = stringValue(groupId);
  let groupMonitor = parseGroupMonitor(null, site.id, normalizedGroupId, null);
  if (normalizedGroupId) {
    const groups = await fetchOwnedSiteGroups(site);
    const group = groups.find((item) => item.id === normalizedGroupId);
    groupMonitor = parseGroupMonitor(
      upsertGroupMonitorSnapshot(db, site.id, normalizedGroupId, group?.name || null, getGroupMonitorRow(db, site.id, normalizedGroupId)),
      site.id,
      normalizedGroupId,
      group?.name || null
    );
  }
  const accounts: OwnedSiteAccount[] = [];
  const query: OwnedSiteAccountQuery = {
    page: 1,
    page_size: 1000,
    group: normalizedGroupId,
    status: 'active',
    type: 'apikey',
    sort_by: 'name',
    sort_order: 'asc'
  };
  const firstPage = await fetchOwnedSiteAccounts(site, query);
  accounts.push(...firstPage.items);
  const maxPages = Math.min(firstPage.pages, 50);
  for (let page = 2; page <= maxPages; page += 1) {
    const next = await fetchOwnedSiteAccounts(site, { ...query, page });
    accounts.push(...next.items);
  }

  const supported = accounts.filter(isSupportedUpstreamAccount);
  return Promise.all(supported.map(async (account) => {
    const existing = getMonitorRow(db, site.id, account.id);
    const row = upsertMonitorSnapshot(db, site.id, account, existing);
    const monitor = parseMonitor(row, site.id, account);
    let models: string[] = [];
    let modelListError: string | null = null;
    try {
      models = await fetchOwnedSiteAccountModels(site, account.id);
    } catch (error) {
      modelListError = (error as Error).message || '获取可测试模型失败';
    }
    const filtered = filterSkippedModels(models, monitor.skip_model_patterns);
    return {
      account,
      monitor,
      group_monitor: groupMonitor,
      latest_result: latestResult(db, site.id, account.id),
      timeline: buildTimeline(db, site.id, account.id, monitor.interval_minutes),
      model_timelines: filtered.tested.map((model) => ({
        model,
        latest_result: latestModelResult(db, site.id, account.id, model),
        timeline: buildModelTimeline(db, site.id, account.id, model, monitor.interval_minutes)
      })),
      model_list_error: modelListError
    };
  }));
}

async function fetchSupportedUpstreamAccountsForGroup(site: OwnedSiteRecord, groupId: string): Promise<OwnedSiteAccount[]> {
  const accounts: OwnedSiteAccount[] = [];
  const query: OwnedSiteAccountQuery = {
    page: 1,
    page_size: 1000,
    group: stringValue(groupId),
    status: 'active',
    type: 'apikey',
    sort_by: 'name',
    sort_order: 'asc'
  };
  const firstPage = await fetchOwnedSiteAccounts(site, query);
  accounts.push(...firstPage.items);
  const maxPages = Math.min(firstPage.pages, 50);
  for (let page = 2; page <= maxPages; page += 1) {
    const next = await fetchOwnedSiteAccounts(site, { ...query, page });
    accounts.push(...next.items);
  }
  return accounts.filter(isSupportedUpstreamAccount);
}

export async function getOwnedSiteUpstreamMonitor(db: DatabaseSync, site: OwnedSiteRecord, accountId: string): Promise<OwnedSiteUpstreamMonitor> {
  const account = await fetchOwnedSiteAccount(site, accountId);
  if (!account) throw new UpstreamError('账号不存在', 404);
  if (!isSupportedUpstreamAccount(account)) throw new UpstreamError('仅支持开启中的 OpenAI/Claude APIKEY 账号', 400);
  const row = upsertMonitorSnapshot(db, site.id, account, getMonitorRow(db, site.id, account.id));
  return parseMonitor(row, site.id, account);
}

export async function saveOwnedSiteUpstreamMonitor(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  accountId: string,
  body: Record<string, unknown>
): Promise<OwnedSiteUpstreamMonitor> {
  const account = await fetchOwnedSiteAccount(site, accountId);
  if (!account) throw new UpstreamError('账号不存在', 404);
  if (!isSupportedUpstreamAccount(account)) throw new UpstreamError('仅支持开启中的 OpenAI/Claude APIKEY 账号', 400);
  const existing = upsertMonitorSnapshot(db, site.id, account, getMonitorRow(db, site.id, account.id));
  const payload = normalizeOwnedSiteUpstreamMonitorPayload(body, true);
  const now = nowIso();
  db.prepare(`
    UPDATE owned_site_upstream_monitors
    SET interval_minutes = ?, retry_count = ?, pause_start_time = ?, pause_end_time = ?, skip_model_patterns_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    payload.interval_minutes ?? existing.interval_minutes,
    payload.retry_count ?? existing.retry_count,
    payload.pause_start_time ?? existing.pause_start_time,
    payload.pause_end_time ?? existing.pause_end_time,
    payload.skip_model_patterns === undefined ? existing.skip_model_patterns_json : JSON.stringify(payload.skip_model_patterns),
    now,
    existing.id
  );
  const row = getMonitorRow(db, site.id, account.id);
  return parseMonitor(row, site.id, account);
}

function insertMonitorResult(
  db: DatabaseSync,
  siteId: number,
  monitorId: number,
  account: OwnedSiteAccount,
  model: string | null,
  status: OwnedSiteUpstreamMonitorStatus,
  latencyMs: number | null,
  counts: { attempt_count?: number | null; success_count?: number | null; failure_count?: number | null } | null,
  message: string,
  raw: unknown,
  checkedAt: string
): void {
  db.prepare(`
    INSERT INTO owned_site_upstream_monitor_results (
      site_id, monitor_id, account_id, account_name, model, status,
      attempt_count, success_count, failure_count, latency_ms, message, raw_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    siteId,
    monitorId,
    account.id,
    account.name || null,
    model,
    status,
    counts?.attempt_count ?? null,
    counts?.success_count ?? null,
    counts?.failure_count ?? null,
    latencyMs,
    message,
    raw === undefined ? null : JSON.stringify(raw),
    checkedAt
  );
}

function aggregateRunStatus(results: Array<{ status: OwnedSiteUpstreamMonitorStatus }>): OwnedSiteUpstreamMonitorStatus {
  if (!results.length) return 'skipped';
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'partial')) return 'partial';
  if (results.every((result) => result.status === 'skipped')) return 'skipped';
  return 'success';
}

function upstreamAlertAlreadySent(db: DatabaseSync, siteId: number, accountId: string, model: string | null, now: Date): boolean {
  const cutoff = nowIso(new Date(now.getTime() - UPSTREAM_ALERT_DEDUPE_MINUTES * 60000));
  const rows = db.prepare(`
    SELECT snapshot_json
    FROM owned_site_alert_events
    WHERE site_id = ?
      AND type = 'upstream_monitor_failed'
      AND account_id = ?
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(siteId, accountId, cutoff) as Array<{ snapshot_json: string | null }>;
  return rows.some((row) => {
    const snapshot = parseJson<{ model?: string | null }>(row.snapshot_json, {});
    return (snapshot.model || null) === model;
  });
}

async function maybeSendOwnedSiteUpstreamAlerts(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  account: OwnedSiteAccount,
  results: OwnedSiteUpstreamRunResult['results'],
  checkedAtDate: Date,
  mailer: typeof sendEmail
): Promise<void> {
  const setting = getUpstreamAlertSettingRow(db, site.id);
  if (!setting?.enabled) return;
  const alertResults = results.filter(
    (item) =>
      item.model &&
      item.status === 'failed' &&
      (item.attempt_count ?? 0) >= UPSTREAM_ALERT_FAILURE_ATTEMPTS &&
      (item.success_count ?? 0) === 0 &&
      (item.failure_count ?? 0) >= UPSTREAM_ALERT_FAILURE_ATTEMPTS
  );
  if (!alertResults.length) return;
  const fallbackRecipients = getEmailSettings(db).default_recipients;
  for (const result of alertResults) {
    if (upstreamAlertAlreadySent(db, site.id, account.id, result.model, checkedAtDate)) continue;
    const message = `${site.name} 上游账号 ${account.name || account.id} 的模型 ${result.model} 连续 ${result.failure_count} 次测试失败：${result.message}`;
    let emailSent = 0;
    let emailError: string | null = null;
    try {
      await mailer(db, fallbackRecipients, 'AI 自有站点上游监控预警', message);
      emailSent = 1;
    } catch (error) {
      emailError = (error as Error).message;
    }
    db.prepare(`
      INSERT INTO owned_site_alert_events (
        site_id, task_id, type, target_type, target_id, account_id, account_name, site_name, message,
        before_status, after_status, snapshot_json, email_sent, email_error, created_at
      ) VALUES (?, NULL, 'upstream_monitor_failed', 'account', ?, ?, ?, ?, ?, NULL, 'failed', ?, ?, ?, ?)
    `).run(
      site.id,
      account.id,
      account.id,
      account.name || null,
      site.name,
      message,
      JSON.stringify({
        source: 'upstream_monitor',
        model: result.model,
        attempt_count: result.attempt_count,
        success_count: result.success_count,
        failure_count: result.failure_count,
        latency_ms: result.latency_ms,
        message: result.message,
        checked_at: nowIso(checkedAtDate)
      }),
      emailSent,
      emailError,
      nowIso(checkedAtDate)
    );
  }
}

export async function runOwnedSiteUpstreamMonitor(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  accountId: string,
  options: { updateLastRun?: boolean; alert?: boolean; mailer?: typeof sendEmail } = {}
): Promise<OwnedSiteUpstreamRunResult> {
  const checkedAtDate = new Date();
  const checkedAt = nowIso(checkedAtDate);
  const account = await fetchOwnedSiteAccount(site, accountId);
  if (!account) throw new UpstreamError('账号不存在', 404);
  const row = upsertMonitorSnapshot(db, site.id, account, getMonitorRow(db, site.id, account.id));
  const monitor = parseMonitor(row, site.id, account);
  const resultItems: OwnedSiteUpstreamRunResult['results'] = [];
  let models: string[] = [];
  let testedModels: string[] = [];
  let skippedModels: string[] = [];

  if (!isSupportedUpstreamAccount(account)) {
    const message = '账号不再是开启中的 OpenAI/Claude APIKEY 账号，已跳过';
    insertMonitorResult(db, site.id, row.id, account, null, 'skipped', null, { attempt_count: 0, success_count: 0, failure_count: 0 }, message, { reason: 'unsupported_account' }, checkedAt);
    resultItems.push({ model: null, status: 'skipped', attempt_count: 0, success_count: 0, failure_count: 0, latency_ms: null, message });
  } else {
    let modelListFailed = false;
    try {
      models = await fetchOwnedSiteAccountModels(site, account.id);
    } catch (error) {
      modelListFailed = true;
      const message = `获取可测试模型失败：${(error as Error).message}`;
      insertMonitorResult(db, site.id, row.id, account, null, 'failed', null, { attempt_count: 1, success_count: 0, failure_count: 1 }, message, error instanceof UpstreamError ? error.details : { error: (error as Error).message }, checkedAt);
      resultItems.push({ model: null, status: 'failed', attempt_count: 1, success_count: 0, failure_count: 1, latency_ms: null, message });
    }
    if (!modelListFailed) {
      const filtered = filterSkippedModels(models, monitor.skip_model_patterns);
      testedModels = filtered.tested;
      skippedModels = filtered.skipped;
      for (const model of skippedModels) {
        const message = '模型已按配置跳过';
        insertMonitorResult(db, site.id, row.id, account, model, 'skipped', null, { attempt_count: 0, success_count: 0, failure_count: 0 }, message, { pattern_matched: true }, checkedAt);
        resultItems.push({ model, status: 'skipped', attempt_count: 0, success_count: 0, failure_count: 0, latency_ms: null, message });
      }
      if (!testedModels.length) {
        const message = models.length ? '所有模型均已按配置跳过' : '未获取到可测试模型';
        insertMonitorResult(db, site.id, row.id, account, null, 'skipped', null, { attempt_count: 0, success_count: 0, failure_count: 0 }, message, { models }, checkedAt);
        resultItems.push({ model: null, status: 'skipped', attempt_count: 0, success_count: 0, failure_count: 0, latency_ms: null, message });
      } else {
        for (const model of testedModels) {
          const result = await runSub2apiAccountTest(site, account.id, model, monitor.retry_count);
          insertMonitorResult(db, site.id, row.id, account, model, result.status, result.latency_ms, {
            attempt_count: result.attempt_count,
            success_count: result.success_count,
            failure_count: result.failure_count
          }, result.message, result.raw, checkedAt);
          resultItems.push({
            model,
            status: result.status,
            attempt_count: result.attempt_count,
            success_count: result.success_count,
            failure_count: result.failure_count,
            latency_ms: result.latency_ms,
            message: result.message
          });
        }
      }
    }
  }

  const status = aggregateRunStatus(resultItems);
  const lastError = status === 'failed' ? resultItems.find((item) => item.status === 'failed')?.message || '测试失败' : null;
  const lastLatency = resultItems
    .map((item) => item.latency_ms)
    .filter((value): value is number => typeof value === 'number')
    .reduce<number | null>((max, value) => (max === null ? value : Math.max(max, value)), null);

  db.prepare(`
    UPDATE owned_site_upstream_monitors
    SET last_run_at = ?, last_status = ?, last_error = ?, last_latency_ms = ?, updated_at = ?
    WHERE id = ?
  `).run(checkedAt, status, lastError, lastLatency, checkedAt, row.id);
  if (options.alert) {
    await maybeSendOwnedSiteUpstreamAlerts(db, site, account, resultItems, checkedAtDate, options.mailer || sendEmail);
  }

  const nextRow = getMonitorRow(db, site.id, account.id);
  return {
    monitor: parseMonitor(nextRow, site.id, account),
    status,
    models,
    tested_models: testedModels,
    skipped_models: skippedModels,
    results: resultItems
  };
}

export async function runDueOwnedSiteUpstreamMonitors(db: DatabaseSync, mailer: typeof sendEmail = sendEmail): Promise<void> {
  const groupRows = db.prepare('SELECT site_id, group_id FROM owned_site_upstream_group_monitors WHERE enabled = 1').all() as Array<{
    site_id: number;
    group_id: string;
  }>;
  const now = new Date();
  const dueRowsByKey = new Map<string, OwnedSiteUpstreamMonitorRecord>();
  for (const groupRow of groupRows) {
    const site = getOwnedSite(db, groupRow.site_id);
    if (!site) continue;
    try {
      const accounts = await fetchSupportedUpstreamAccountsForGroup(site, groupRow.group_id);
      for (const account of accounts) {
        const row = upsertMonitorSnapshot(db, site.id, account, getMonitorRow(db, site.id, account.id));
        if (!isWithinMonitorPauseWindow(row.pause_start_time, row.pause_end_time, now) && minutesSince(row.last_run_at, now) >= row.interval_minutes) {
          dueRowsByKey.set(`${row.site_id}:${row.account_id}`, row);
        }
      }
    } catch (error) {
      const checkedAt = nowIso();
      db.prepare(`
        UPDATE owned_sites
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run((error as Error).message || '上游分组账号拉取失败', checkedAt, groupRow.site_id);
    }
  }
  const dueRows = Array.from(dueRowsByKey.values());
  for (const row of dueRows) {
    const site = getOwnedSite(db, row.site_id);
    if (!site) continue;
    try {
      await runOwnedSiteUpstreamMonitor(db, site, row.account_id, { updateLastRun: true, alert: true, mailer });
      db.prepare(`
        UPDATE owned_sites
        SET status = 'active', last_check_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(now), nowIso(now), site.id);
    } catch (error) {
      const checkedAt = nowIso();
      db.prepare(`
        UPDATE owned_site_upstream_monitors
        SET last_run_at = ?, last_status = 'failed', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(checkedAt, (error as Error).message || '监控测试失败', checkedAt, row.id);
      db.prepare(`
        UPDATE owned_sites
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = ?
      `).run((error as Error).message, checkedAt, site.id);
    }
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

function normalizeUsageRecord(record: Record<string, unknown>): OwnedSiteUsageRecord | null {
  const id = stringValue(record.id ?? record.ID);
  const createdAt = stringValue(record.created_at ?? record.createdAt);
  if (!createdAt) return null;
  const firstTokenValue = record.first_token_ms ?? record.firstTokenMs;
  const firstTokenNumber = firstTokenValue === null || firstTokenValue === undefined || firstTokenValue === '' ? null : Number(firstTokenValue);
  const groupName =
    optionalString(record.group_name ?? record.groupName) || objectString(record.group, ['name', 'title', 'label', 'id', 'group_id', 'groupId']);
  return {
    id,
    request_id: optionalString(record.request_id ?? record.requestId),
    model: optionalString(record.model),
    account_id: usageAccountId(record),
    account_name: usageAccountName(record),
    group_id: optionalString(record.group_id ?? record.groupId),
    group_name: groupName,
    first_token_ms: firstTokenNumber !== null && Number.isFinite(firstTokenNumber) ? firstTokenNumber : null,
    created_at: createdAt,
    raw: record
  };
}

function normalizeUsagePage(payload: unknown, fallbackPage: number, fallbackPageSize: number): PaginatedResult<OwnedSiteUsageRecord> {
  const page = asPage(payload, fallbackPage, fallbackPageSize);
  return {
    ...page,
    items: page.items.map(normalizeUsageRecord).filter((item): item is OwnedSiteUsageRecord => Boolean(item))
  };
}

async function fetchOwnedSiteUsagePage(
  site: OwnedSiteRecord,
  query: { page: number; page_size: number; group_id: string }
): Promise<PaginatedResult<OwnedSiteUsageRecord>> {
  const params = new URLSearchParams({
    page: String(query.page),
    page_size: String(query.page_size),
    sort_by: 'created_at',
    sort_order: 'desc',
    group_id: query.group_id
  });
  const payload = await ownedSiteRequest(site, `/admin/usage?${params.toString()}`);
  return normalizeUsagePage(payload, query.page, query.page_size);
}

function latencySample(record: OwnedSiteUsageRecord): OwnedSiteLatencySample {
  return {
    id: record.id,
    request_id: record.request_id,
    model: record.model,
    account_id: record.account_id,
    account_name: record.account_name,
    group_id: record.group_id,
    group_name: record.group_name,
    first_token_ms: record.first_token_ms || 0,
    created_at: record.created_at
  };
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function topLatencySamples(samples: OwnedSiteLatencySample[]): OwnedSiteLatencySample[] {
  return [...samples].sort((left, right) => right.first_token_ms - left.first_token_ms).slice(0, 10);
}

function slowSampleAccountLabel(sample: OwnedSiteLatencySample): string {
  return sample.account_name || sample.account_id || '未知账号';
}

function countSlowSampleAccounts(samples: OwnedSiteLatencySample[]): SlowSampleAccountCount[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    const label = slowSampleAccountLabel(sample);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function formatSlowSampleAccounts(accounts: SlowSampleAccountCount[]): string {
  return accounts.map((account) => `【${account.name} * ${account.count}】`).join('、');
}

export async function evaluateOwnedSiteFirstTokenLatencyTask(
  site: OwnedSiteRecord,
  task: OwnedSiteAutomationTaskRecord,
  now = new Date()
): Promise<OwnedSiteFirstTokenLatencyEvaluation> {
  if (!task.target_group_id) throw new UpstreamError('首 Token 耗时任务缺少分组 ID', 400);
  const lookbackMinutes = Math.max(1, Math.floor(numberValue(task.lookback_minutes, FIRST_TOKEN_LATENCY_DEFAULT_LOOKBACK_MINUTES)));
  const sampleSize = Math.min(FIRST_TOKEN_LATENCY_MAX_SAMPLE_SIZE, Math.max(1, Math.floor(numberValue(task.sample_size, FIRST_TOKEN_LATENCY_DEFAULT_SAMPLE_SIZE))));
  const breachCount = Math.min(sampleSize, Math.max(1, Math.floor(numberValue(task.breach_count, FIRST_TOKEN_LATENCY_DEFAULT_BREACH_COUNT))));
  const latencyThresholdMs = Math.max(1, Math.floor(numberValue(task.latency_threshold_ms, FIRST_TOKEN_LATENCY_DEFAULT_THRESHOLD_MS)));
  const cutoff = new Date(now.getTime() - lookbackMinutes * 60000);
  const samples: OwnedSiteLatencySample[] = [];
  let scannedPages = 0;
  let reachedCutoff = false;

  for (let page = 1; page <= FIRST_TOKEN_LATENCY_MAX_SCAN_PAGES && samples.length < sampleSize && !reachedCutoff; page += 1) {
    const result = await fetchOwnedSiteUsagePage(site, {
      page,
      page_size: FIRST_TOKEN_LATENCY_USAGE_PAGE_SIZE,
      group_id: task.target_group_id
    });
    scannedPages = page;
    if (!result.items.length) break;
    for (const record of result.items) {
      const createdAt = new Date(record.created_at);
      if (!Number.isFinite(createdAt.getTime())) continue;
      if (createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      if (record.first_token_ms === null) continue;
      samples.push(latencySample(record));
      if (samples.length >= sampleSize) break;
    }
    if (page >= result.pages) break;
  }

  const slowSamples = samples.filter((sample) => sample.first_token_ms > latencyThresholdMs);
  const slowSampleAccounts = countSlowSampleAccounts(slowSamples);
  const targetLabel = task.target_group_name || task.target_group_id;
  const snapshot = {
    site: sanitizeOwnedSite(site),
    task: {
      id: task.id,
      type: task.type,
      target_group_id: task.target_group_id,
      target_group_name: task.target_group_name,
      lookback_minutes: lookbackMinutes,
      sample_size: sampleSize,
      breach_count: breachCount,
      latency_threshold_ms: latencyThresholdMs
    },
    cutoff_at: nowIso(cutoff),
    checked_at: nowIso(now),
    scanned_pages: scannedPages,
    sample_count: samples.length,
    slow_count: slowSamples.length,
    slow_account_counts: slowSampleAccounts,
    samples: topLatencySamples(samples),
    slow_samples: topLatencySamples(slowSamples)
  };

  if (samples.length < sampleSize) {
    return {
      triggered: false,
      message: `${site.name} 分组 ${targetLabel} 最近 ${lookbackMinutes} 分钟内可用首 Token 样本不足：${samples.length}/${sampleSize}`,
      samples,
      slow_samples: slowSamples,
      scanned_pages: scannedPages,
      snapshot
    };
  }

  const triggered = slowSamples.length >= breachCount;
  const maxLatency = samples.reduce((max, sample) => Math.max(max, sample.first_token_ms), 0);
  const latestSlow = slowSamples[0] || null;
  const slowAccountSummary = formatSlowSampleAccounts(slowSampleAccounts);
  return {
    triggered,
    message: triggered
      ? `${site.name} ${targetLabel}分组${slowAccountSummary}最近 ${lookbackMinutes} 分钟内近 ${sampleSize} 次请求有 ${slowSamples.length} 次首 Token 耗时超过 ${formatSeconds(
          latencyThresholdMs
        )} 秒，最大 ${formatSeconds(maxLatency)} 秒${latestSlow ? `，最近慢请求 ${formatSeconds(latestSlow.first_token_ms)} 秒` : ''}`
      : `${site.name} 分组 ${targetLabel} 首 Token 耗时未超过阈值：近 ${sampleSize} 次中 ${slowSamples.length} 次超过 ${formatSeconds(latencyThresholdMs)} 秒`,
    samples,
    slow_samples: slowSamples,
    scanned_pages: scannedPages,
    snapshot
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

export async function recordOwnedSiteFirstTokenLatencyAlert(
  db: DatabaseSync,
  site: OwnedSiteRecord,
  task: OwnedSiteAutomationTaskRecord,
  evaluation: OwnedSiteFirstTokenLatencyEvaluation,
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
    await mailer(db, recipients.length ? recipients : fallbackRecipients, 'AI 自有站点首 Token 耗时预警', evaluation.message);
    emailSent = 1;
  } catch (error) {
    emailError = (error as Error).message;
  }

  db.prepare(`
    INSERT INTO owned_site_alert_events (
      site_id, task_id, type, target_type, target_id, account_id, account_name, site_name, message,
      before_status, after_status, snapshot_json, email_sent, email_error, created_at
    ) VALUES (?, ?, ?, 'group', ?, NULL, NULL, ?, ?, NULL, 'slow_first_token', ?, ?, ?, ?)
  `).run(
    site.id,
    task.id,
    task.type,
    task.target_group_id,
    site.name,
    evaluation.message,
    JSON.stringify(evaluation.snapshot),
    emailSent,
    emailError,
    nowIso(now)
  );
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
      if (row.type === FIRST_TOKEN_LATENCY_TASK_TYPE) {
        const evaluation = await evaluateOwnedSiteFirstTokenLatencyTask(site, row, now);
        db.prepare(`
          UPDATE owned_sites
          SET status = 'active', last_check_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(nowIso(now), nowIso(now), site.id);
        await recordOwnedSiteFirstTokenLatencyAlert(db, site, row, evaluation, now, mailer);
        continue;
      }
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
  type?: OwnedSiteTaskType;
  enabled?: number;
  target_type?: OwnedSiteTaskTargetType;
  target_account_id?: string | null;
  target_account_name?: string | null;
  target_group_id?: string | null;
  target_group_name?: string | null;
  interval_minutes?: number;
  lookback_minutes?: number;
  sample_size?: number;
  breach_count?: number;
  latency_threshold_ms?: number;
  cooldown_minutes?: number;
  recipients_json?: string;
} {
  const typeValue = body.type === undefined ? (partial ? undefined : 'account_error') : stringValue(body.type);
  if (typeValue !== undefined && typeValue !== 'account_error' && typeValue !== FIRST_TOKEN_LATENCY_TASK_TYPE) throw new UpstreamError('任务类型无效', 400);
  const targetType = body.target_type === undefined ? undefined : stringValue(body.target_type);
  if (!partial && targetType !== 'account' && targetType !== 'group') throw new UpstreamError('任务目标类型无效', 400);
  if (partial && targetType !== undefined && targetType !== 'account' && targetType !== 'group') throw new UpstreamError('任务目标类型无效', 400);

  const sampleSize =
    body.sample_size === undefined
      ? undefined
      : Math.min(FIRST_TOKEN_LATENCY_MAX_SAMPLE_SIZE, Math.max(1, Math.floor(numberValue(body.sample_size, FIRST_TOKEN_LATENCY_DEFAULT_SAMPLE_SIZE))));
  const breachCount =
    body.breach_count === undefined ? undefined : Math.max(1, Math.floor(numberValue(body.breach_count, FIRST_TOKEN_LATENCY_DEFAULT_BREACH_COUNT)));

  const payload = {
    type: typeValue as OwnedSiteTaskType | undefined,
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled) ? 1 : 0,
    target_type: targetType as OwnedSiteTaskTargetType | undefined,
    target_account_id: body.target_account_id === undefined ? undefined : stringValue(body.target_account_id) || null,
    target_account_name: body.target_account_name === undefined ? undefined : stringValue(body.target_account_name) || null,
    target_group_id: body.target_group_id === undefined ? undefined : stringValue(body.target_group_id) || null,
    target_group_name: body.target_group_name === undefined ? undefined : stringValue(body.target_group_name) || null,
    interval_minutes: body.interval_minutes === undefined ? undefined : Math.max(1, numberValue(body.interval_minutes, 1)),
    lookback_minutes:
      body.lookback_minutes === undefined ? undefined : Math.max(1, Math.floor(numberValue(body.lookback_minutes, FIRST_TOKEN_LATENCY_DEFAULT_LOOKBACK_MINUTES))),
    sample_size: sampleSize,
    breach_count: breachCount,
    latency_threshold_ms:
      body.latency_threshold_ms === undefined
        ? undefined
        : Math.max(1, Math.floor(numberValue(body.latency_threshold_ms, FIRST_TOKEN_LATENCY_DEFAULT_THRESHOLD_MS))),
    cooldown_minutes:
      body.cooldown_minutes === undefined ? undefined : Math.max(0, numberValue(body.cooldown_minutes, FIRST_TOKEN_LATENCY_DEFAULT_COOLDOWN_MINUTES)),
    recipients_json: body.recipients === undefined ? undefined : JSON.stringify(splitRecipients(body.recipients))
  };

  if (payload.breach_count !== undefined && payload.sample_size !== undefined && payload.breach_count > payload.sample_size) {
    throw new UpstreamError('慢请求次数不能大于最近请求数', 400);
  }
  const resolvedTarget = payload.target_type;
  if (!partial && payload.type === FIRST_TOKEN_LATENCY_TASK_TYPE && resolvedTarget !== 'group') throw new UpstreamError('首 Token 耗时任务只能监控指定分组', 400);
  if (!partial && payload.type === 'account_error' && resolvedTarget !== 'account' && resolvedTarget !== 'group') throw new UpstreamError('任务目标类型无效', 400);
  if (!partial && resolvedTarget === 'account' && !payload.target_account_id) throw new UpstreamError('请选择要监控的账号', 400);
  if (!partial && resolvedTarget === 'group' && !payload.target_group_id) throw new UpstreamError('请选择要监控的分组', 400);
  return payload;
}
