import type {
  AlertEvent,
  AutomationTask,
  BalanceQueryLog,
  Channel,
  EmailSettings,
  Overview,
  OwnedSite,
  OwnedSiteAccount,
  OwnedSiteAlertEvent,
  OwnedSiteAutomationTask,
  OwnedSiteGroup,
  OwnedSiteUpstreamAccount,
  OwnedSiteUpstreamAlertSetting,
  OwnedSiteUpstreamGroupMonitor,
  OwnedSiteUpstreamMonitor,
  OwnedSiteUpstreamRunResult,
  PaginatedResult,
  TokenModelsResult
} from './types';

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      unauthorizedHandler?.();
    }
    throw new Error(data?.error || `请求失败：HTTP ${response.status}`);
  }
  return data as T;
}

function queryString(params?: Record<string, string | number | boolean | null | undefined>) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : '';
}

export const api = {
  authStatus: () => request<{ authenticated: boolean }>('/api/auth/status'),
  login: (password: string) =>
    request<{ authenticated: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>('/api/auth/logout', { method: 'POST' }),
  channels: () => request<Channel[]>('/api/channels'),
  createChannel: (payload: Record<string, unknown>) =>
    request<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id: number, payload: Record<string, unknown>) =>
    request<Channel>(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteChannel: (id: number) => request<void>(`/api/channels/${id}`, { method: 'DELETE' }),
  syncChannel: (id: number) => request<{ channel: Channel }>(`/api/channels/${id}/sync`, { method: 'POST' }),
  upstreamLoginUrl: (id: number) => `/api/channels/${id}/upstream-login`,
  overview: (id: number) => request<Overview>(`/api/channels/${id}/overview`),
  balanceQueryLogs: (id: number, page = 1) =>
    request<PaginatedResult<BalanceQueryLog>>(`/api/channels/${id}/balance-query-logs${queryString({ page })}`),
  groups: (id: number) => request<unknown[]>(`/api/channels/${id}/groups`),
  tokens: (id: number) => request<unknown[]>(`/api/channels/${id}/tokens`),
  tokenModels: (channelId: number, tokenId: number) => request<TokenModelsResult>(`/api/channels/${channelId}/tokens/${tokenId}/models`),
  updateTokenGroup: (channelId: number, tokenId: number, payload: { group?: string; group_id?: number }) =>
    request<{ channel: Channel; token: unknown; tokens: unknown[] }>(`/api/channels/${channelId}/tokens/${tokenId}/group`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  subscriptions: (id: number) => request<unknown>(`/api/channels/${id}/subscriptions`),
  tasks: (id: number) => request<AutomationTask[]>(`/api/channels/${id}/tasks`),
  createTask: (id: number, payload: Record<string, unknown>) =>
    request<AutomationTask>(`/api/channels/${id}/tasks`, { method: 'POST', body: JSON.stringify(payload) }),
  updateTask: (channelId: number, taskId: number, payload: Record<string, unknown>) =>
    request<AutomationTask>(`/api/channels/${channelId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteTask: (channelId: number, taskId: number) =>
    request<void>(`/api/channels/${channelId}/tasks/${taskId}`, { method: 'DELETE' }),
  alerts: (channelId?: number) => request<AlertEvent[]>(`/api/alerts${channelId ? `?channel_id=${channelId}` : ''}`),
  ownedSites: () => request<OwnedSite[]>('/api/owned-sites'),
  createOwnedSite: (payload: Record<string, unknown>) =>
    request<OwnedSite>('/api/owned-sites', { method: 'POST', body: JSON.stringify(payload) }),
  updateOwnedSite: (id: number, payload: Record<string, unknown>) =>
    request<OwnedSite>(`/api/owned-sites/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteOwnedSite: (id: number) => request<void>(`/api/owned-sites/${id}`, { method: 'DELETE' }),
  checkOwnedSite: (id: number) => request<OwnedSite>(`/api/owned-sites/${id}/check`, { method: 'POST' }),
  ownedSiteGroups: (id: number) => request<OwnedSiteGroup[]>(`/api/owned-sites/${id}/groups`),
  ownedSiteAccounts: (id: number, params?: Record<string, string | number | boolean | null | undefined>) =>
    request<PaginatedResult<OwnedSiteAccount>>(`/api/owned-sites/${id}/accounts${queryString(params)}`),
  ownedSiteUpstreamAccounts: (id: number, group?: string) =>
    request<OwnedSiteUpstreamAccount[]>(`/api/owned-sites/${id}/upstream/accounts${queryString({ group })}`),
  ownedSiteUpstreamAlertSetting: (id: number) =>
    request<OwnedSiteUpstreamAlertSetting>(`/api/owned-sites/${id}/upstream/alert-setting`),
  updateOwnedSiteUpstreamAlertSetting: (id: number, payload: Record<string, unknown>) =>
    request<OwnedSiteUpstreamAlertSetting>(`/api/owned-sites/${id}/upstream/alert-setting`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  ownedSiteUpstreamGroupMonitor: (siteId: number, groupId: string) =>
    request<OwnedSiteUpstreamGroupMonitor>(`/api/owned-sites/${siteId}/upstream/groups/${encodeURIComponent(groupId)}/monitor`),
  updateOwnedSiteUpstreamGroupMonitor: (siteId: number, groupId: string, payload: Record<string, unknown>) =>
    request<OwnedSiteUpstreamGroupMonitor>(`/api/owned-sites/${siteId}/upstream/groups/${encodeURIComponent(groupId)}/monitor`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  ownedSiteUpstreamMonitor: (siteId: number, accountId: string) =>
    request<OwnedSiteUpstreamMonitor>(`/api/owned-sites/${siteId}/upstream/accounts/${accountId}/monitor`),
  updateOwnedSiteUpstreamMonitor: (siteId: number, accountId: string, payload: Record<string, unknown>) =>
    request<OwnedSiteUpstreamMonitor>(`/api/owned-sites/${siteId}/upstream/accounts/${accountId}/monitor`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  runOwnedSiteUpstreamMonitor: (siteId: number, accountId: string) =>
    request<OwnedSiteUpstreamRunResult>(`/api/owned-sites/${siteId}/upstream/accounts/${accountId}/monitor/run`, { method: 'POST' }),
  ownedSiteTasks: (id: number) => request<OwnedSiteAutomationTask[]>(`/api/owned-sites/${id}/tasks`),
  createOwnedSiteTask: (id: number, payload: Record<string, unknown>) =>
    request<OwnedSiteAutomationTask>(`/api/owned-sites/${id}/tasks`, { method: 'POST', body: JSON.stringify(payload) }),
  updateOwnedSiteTask: (siteId: number, taskId: number, payload: Record<string, unknown>) =>
    request<OwnedSiteAutomationTask>(`/api/owned-sites/${siteId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteOwnedSiteTask: (siteId: number, taskId: number) =>
    request<void>(`/api/owned-sites/${siteId}/tasks/${taskId}`, { method: 'DELETE' }),
  ownedSiteAlerts: (id: number) => request<OwnedSiteAlertEvent[]>(`/api/owned-sites/${id}/alerts`),
  allOwnedSiteAlerts: () => request<OwnedSiteAlertEvent[]>('/api/owned-site-alerts'),
  emailSettings: () => request<EmailSettings>('/api/settings/email'),
  saveEmailSettings: (payload: EmailSettings) =>
    request<EmailSettings>('/api/settings/email', { method: 'PUT', body: JSON.stringify(payload) }),
  testEmail: (recipient: string) =>
    request<{ ok: boolean }>('/api/settings/email/test', { method: 'POST', body: JSON.stringify({ recipient }) })
};
