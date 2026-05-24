export class UpstreamError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status = 502, details?: unknown) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.details = details;
  }
}

export interface JsonResponse<T = unknown> {
  status: number;
  data: T;
}

export async function requestJson<T = unknown>(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }
    if (!response.ok) {
      const message = extractMessage(data) || `上游请求失败：HTTP ${response.status}`;
      throw new UpstreamError(message, response.status, data);
    }
    return { status: response.status, data: data as T };
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new UpstreamError('上游请求超时', 504);
    }
    throw new UpstreamError((error as Error).message || '上游请求失败', 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function extractMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (typeof record.error === 'string' && record.error.trim()) return record.error;
  if (typeof record.msg === 'string' && record.msg.trim()) return record.msg;
  return null;
}

