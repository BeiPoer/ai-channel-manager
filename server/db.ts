import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AutomationTask, AutomationTaskRecord, ChannelRecord, SafeChannel } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function createDatabase(filename = process.env.DB_PATH || path.join(projectRoot, 'data', 'app.sqlite')): DatabaseSync {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('sub2api', 'newapi')),
      base_url TEXT NOT NULL,
      username TEXT,
      password TEXT,
      newapi_access_token TEXT,
      newapi_user_id TEXT,
      sub2api_access_token TEXT,
      sub2api_refresh_token TEXT,
      sub2api_token_expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'syncing',
      last_sync_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL CHECK (cache_key IN ('profile', 'groups', 'tokens', 'subscriptions')),
      raw_json TEXT NOT NULL,
      normalized_json TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      UNIQUE(channel_id, cache_key)
    );

    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      balance REAL NOT NULL,
      used_balance REAL,
      unit TEXT NOT NULL,
      raw_json TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('low_balance', 'burn_rate', 'group_added', 'group_removed', 'group_ratio_changed')),
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      threshold REAL NOT NULL,
      lookback_minutes INTEGER NOT NULL DEFAULT 60,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      recipients_json TEXT,
      last_run_at TEXT,
      last_alert_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES automation_tasks(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      snapshot_json TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      email_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_task_state (
      task_id INTEGER NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, state_key)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migrateAutomationTaskTypes(db);
  seedExistingGroupTaskState(db);
}

function migrateAutomationTaskTypes(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_tasks'").get() as { sql: string } | undefined;
  if (!table?.sql || table.sql.includes('group_ratio_changed')) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE automation_tasks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('low_balance', 'burn_rate', 'group_added', 'group_removed', 'group_ratio_changed')),
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      threshold REAL NOT NULL,
      lookback_minutes INTEGER NOT NULL DEFAULT 60,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      recipients_json TEXT,
      last_run_at TEXT,
      last_alert_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO automation_tasks_new (
      id, channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes,
      recipients_json, last_run_at, last_alert_at, created_at, updated_at
    )
    SELECT
      id, channel_id, type, enabled, interval_minutes, threshold, lookback_minutes, cooldown_minutes,
      recipients_json, last_run_at, last_alert_at, created_at, updated_at
    FROM automation_tasks;
    DROP TABLE automation_tasks;
    ALTER TABLE automation_tasks_new RENAME TO automation_tasks;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function seedExistingGroupTaskState(db: DatabaseSync): void {
  db.prepare(`
    INSERT OR IGNORE INTO automation_task_state (task_id, state_key, value_json, updated_at)
    SELECT t.id, 'groups', c.normalized_json, ?
    FROM automation_tasks t
    JOIN channel_cache c ON c.channel_id = t.channel_id AND c.cache_key = 'groups'
    WHERE t.type IN ('group_added', 'group_removed', 'group_ratio_changed')
  `).run(nowIso());
}

export function getChannel(db: DatabaseSync, id: number): ChannelRecord | null {
  return (db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelRecord | undefined) || null;
}

export function sanitizeChannel(channel: ChannelRecord): SafeChannel {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    base_url: channel.base_url,
    username: channel.username,
    password: channel.password,
    newapi_access_token: channel.newapi_access_token,
    newapi_user_id: channel.newapi_user_id,
    status: channel.status,
    last_sync_at: channel.last_sync_at,
    last_error: channel.last_error,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
    has_password: Boolean(channel.password),
    has_newapi_access_token: Boolean(channel.newapi_access_token)
  };
}

export function parseTask(row: AutomationTaskRecord): AutomationTask {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    recipients: parseJson<string[]>(row.recipients_json, [])
  };
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function readChannelCache<T>(db: DatabaseSync, channelId: number, key: string, fallback: T): { exists: boolean; value: T } {
  const row = db.prepare('SELECT normalized_json FROM channel_cache WHERE channel_id = ? AND cache_key = ?').get(channelId, key) as
    | { normalized_json: string }
    | undefined;
  return {
    exists: Boolean(row),
    value: parseJson(row?.normalized_json, fallback)
  };
}

export function readTaskState<T>(db: DatabaseSync, taskId: number, key: string, fallback: T): { exists: boolean; value: T } {
  const row = db.prepare('SELECT value_json FROM automation_task_state WHERE task_id = ? AND state_key = ?').get(taskId, key) as
    | { value_json: string }
    | undefined;
  return {
    exists: Boolean(row),
    value: parseJson(row?.value_json, fallback)
  };
}

export function upsertTaskState(db: DatabaseSync, taskId: number, key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO automation_task_state (task_id, state_key, value_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, state_key)
    DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(taskId, key, JSON.stringify(value ?? null), nowIso());
}

export function splitRecipients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function getSetting(db: DatabaseSync, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

export function setChannelSyncStatus(db: DatabaseSync, channelId: number, status: string, error: string | null): void {
  db.prepare(`
    UPDATE channels
    SET status = ?, last_error = ?, last_sync_at = CASE WHEN ? IS NULL THEN ? ELSE last_sync_at END, updated_at = ?
    WHERE id = ?
  `).run(status, error, error, nowIso(), nowIso(), channelId);
}
