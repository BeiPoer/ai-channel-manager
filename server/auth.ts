import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config.js';

const sessionCookieName = 'ai_channel_session';

interface SessionPayload {
  exp: number;
  nonce: string;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function cookieOptions(config: AppConfig, maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: config.secureCookies,
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge })
  };
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const index = part.indexOf('=');
      if (index === -1) return [];
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!key) return [];
      try {
        return [[key, decodeURIComponent(value)]];
      } catch {
        return [];
      }
    })
  );
}

function sessionMaxAge(config: AppConfig): number {
  return Math.max(1, config.sessionTtlHours) * 60 * 60 * 1000;
}

export function verifyAccessPassword(config: AppConfig, password: unknown): boolean {
  if (typeof password !== 'string') return false;
  const left = crypto.createHash('sha256').update(password).digest('hex');
  const right = crypto.createHash('sha256').update(config.accessPassword).digest('hex');
  return safeEqual(left, right);
}

export function createSessionToken(config: AppConfig): string {
  const payload: SessionPayload = {
    exp: Date.now() + sessionMaxAge(config),
    nonce: crypto.randomBytes(18).toString('base64url')
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, config.sessionSecret)}`;
}

export function isAuthenticated(req: Request, config: AppConfig): boolean {
  const token = parseCookies(req)[sessionCookieName];
  if (!token) return false;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) return false;
  if (!safeEqual(sign(encoded, config.sessionSecret), signature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    return typeof payload.exp === 'number' && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function setSessionCookie(res: Response, config: AppConfig): void {
  res.cookie(sessionCookieName, createSessionToken(config), cookieOptions(config, sessionMaxAge(config)));
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(sessionCookieName, cookieOptions(config));
}

export function requireAuth(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api')) return next();
    if (req.path === '/api/health' || req.path.startsWith('/api/auth/')) return next();
    if (isAuthenticated(req, config)) return next();
    res.status(401).json({ error: '请先登录' });
  };
}
