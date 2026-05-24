import type { AlertEvent, AutomationTask, Channel, EmailSettings, Overview } from './types';

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
    throw new Error(data?.error || `请求失败：HTTP ${response.status}`);
  }
  return data as T;
}

export const api = {
  channels: () => request<Channel[]>('/api/channels'),
  createChannel: (payload: Record<string, unknown>) =>
    request<Channel>('/api/channels', { method: 'POST', body: JSON.stringify(payload) }),
  updateChannel: (id: number, payload: Record<string, unknown>) =>
    request<Channel>(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteChannel: (id: number) => request<void>(`/api/channels/${id}`, { method: 'DELETE' }),
  syncChannel: (id: number) => request<{ channel: Channel }>(`/api/channels/${id}/sync`, { method: 'POST' }),
  overview: (id: number) => request<Overview>(`/api/channels/${id}/overview`),
  groups: (id: number) => request<unknown[]>(`/api/channels/${id}/groups`),
  tokens: (id: number) => request<unknown[]>(`/api/channels/${id}/tokens`),
  subscriptions: (id: number) => request<unknown>(`/api/channels/${id}/subscriptions`),
  tasks: (id: number) => request<AutomationTask[]>(`/api/channels/${id}/tasks`),
  createTask: (id: number, payload: Record<string, unknown>) =>
    request<AutomationTask>(`/api/channels/${id}/tasks`, { method: 'POST', body: JSON.stringify(payload) }),
  updateTask: (channelId: number, taskId: number, payload: Record<string, unknown>) =>
    request<AutomationTask>(`/api/channels/${channelId}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteTask: (channelId: number, taskId: number) =>
    request<void>(`/api/channels/${channelId}/tasks/${taskId}`, { method: 'DELETE' }),
  alerts: (channelId?: number) => request<AlertEvent[]>(`/api/alerts${channelId ? `?channel_id=${channelId}` : ''}`),
  emailSettings: () => request<EmailSettings>('/api/settings/email'),
  saveEmailSettings: (payload: EmailSettings) =>
    request<EmailSettings>('/api/settings/email', { method: 'PUT', body: JSON.stringify(payload) }),
  testEmail: (recipient: string) =>
    request<{ ok: boolean }>('/api/settings/email/test', { method: 'POST', body: JSON.stringify({ recipient }) })
};

