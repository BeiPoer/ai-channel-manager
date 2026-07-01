import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type {
  AutomationTask,
  AutomationTaskRecord,
  ChannelRecord,
  OwnedSiteAutomationTask,
  OwnedSiteAutomationTaskRecord,
  OwnedSiteRecord,
  SafeChannel,
  SafeOwnedSite
} from './types.js';

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
      type TEXT NOT NULL CHECK (type IN ('sub2api', 'newapi', 'other')),
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

    CREATE TABLE IF NOT EXISTS balance_query_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('success', 'error')),
      balance REAL,
      used_balance REAL,
      unit TEXT,
      message TEXT NOT NULL,
      error TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS owned_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'sub2api' CHECK (type IN ('sub2api')),
      base_url TEXT NOT NULL,
      admin_api_key TEXT,
      status TEXT NOT NULL DEFAULT 'syncing' CHECK (status IN ('active', 'error', 'syncing')),
      last_check_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owned_site_account_state (
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      account_name TEXT,
      status TEXT,
      error_message TEXT,
      group_ids_json TEXT,
      raw_json TEXT,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (site_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS owned_site_automation_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'account_error' CHECK (type IN ('account_error', 'group_first_token_latency')),
      enabled INTEGER NOT NULL DEFAULT 1,
      target_type TEXT NOT NULL CHECK (target_type IN ('account', 'group')),
      target_account_id TEXT,
      target_account_name TEXT,
      target_group_id TEXT,
      target_group_name TEXT,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      lookback_minutes INTEGER NOT NULL DEFAULT 10,
      sample_size INTEGER NOT NULL DEFAULT 20,
      breach_count INTEGER NOT NULL DEFAULT 5,
      latency_threshold_ms INTEGER NOT NULL DEFAULT 7000,
      cooldown_minutes INTEGER NOT NULL DEFAULT 10,
      recipients_json TEXT,
      last_run_at TEXT,
      last_alert_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owned_site_alert_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES owned_site_automation_tasks(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      account_id TEXT,
      account_name TEXT,
      site_name TEXT NOT NULL,
      message TEXT NOT NULL,
      before_status TEXT,
      after_status TEXT,
      snapshot_json TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      email_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owned_site_upstream_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      account_name TEXT,
      account_platform TEXT,
      account_type TEXT,
      group_ids_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_minutes INTEGER NOT NULL DEFAULT 10,
      retry_count INTEGER NOT NULL DEFAULT 2,
      pause_start_time TEXT NOT NULL DEFAULT '01:00',
      pause_end_time TEXT NOT NULL DEFAULT '08:00',
      skip_model_patterns_json TEXT NOT NULL DEFAULT '["gpt-image-*","codex-auto-review"]',
      last_run_at TEXT,
      last_status TEXT CHECK (last_status IN ('success', 'failed', 'partial', 'skipped')),
      last_error TEXT,
      last_latency_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(site_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS owned_site_upstream_group_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      group_id TEXT NOT NULL,
      group_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(site_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS owned_site_upstream_alert_settings (
      site_id INTEGER PRIMARY KEY REFERENCES owned_sites(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owned_site_upstream_monitor_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      monitor_id INTEGER REFERENCES owned_site_upstream_monitors(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      account_name TEXT,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial', 'skipped')),
      attempt_count INTEGER,
      success_count INTEGER,
      failure_count INTEGER,
      latency_ms INTEGER,
      message TEXT NOT NULL DEFAULT '',
      raw_json TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_monitors_site
      ON owned_site_upstream_monitors(site_id);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_group_monitors_site
      ON owned_site_upstream_group_monitors(site_id);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_alert_settings_site
      ON owned_site_upstream_alert_settings(site_id);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_results_account_time
      ON owned_site_upstream_monitor_results(site_id, account_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_results_monitor_time
      ON owned_site_upstream_monitor_results(monitor_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_owned_site_alert_events_upstream_dedupe
      ON owned_site_alert_events(site_id, type, account_id, after_status, created_at);
  `);
  migrateChannelTypes(db);
  migrateAutomationTaskTypes(db);
  migrateOwnedSiteAutomationTaskLatencySchema(db);
  migrateOwnedSiteUpstreamMonitorSchema(db);
  migrateOwnedSiteUpstreamMonitorDefaults(db);
  seedExistingGroupTaskState(db);
}

function migrateChannelTypes(db: DatabaseSync): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get() as { sql: string } | undefined;
  if (!table?.sql || table.sql.includes("'other'")) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE channels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('sub2api', 'newapi', 'other')),
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
    INSERT INTO channels_new (
      id, name, type, base_url, username, password, newapi_access_token, newapi_user_id,
      sub2api_access_token, sub2api_refresh_token, sub2api_token_expires_at,
      status, last_sync_at, last_error, created_at, updated_at
    )
    SELECT
      id, name, type, base_url, username, password, newapi_access_token, newapi_user_id,
      sub2api_access_token, sub2api_refresh_token, sub2api_token_expires_at,
      status, last_sync_at, last_error, created_at, updated_at
    FROM channels;
    DROP TABLE channels;
    ALTER TABLE channels_new RENAME TO channels;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
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

function tableSql(db: DatabaseSync, tableName: string): string {
  const table = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName) as { sql: string } | undefined;
  return table?.sql || '';
}

function columnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).some((column) => column.name === columnName);
}

function migrateOwnedSiteAutomationTaskLatencySchema(db: DatabaseSync): void {
  const sql = tableSql(db, 'owned_site_automation_tasks');
  const hasLatencyType = sql.includes('group_first_token_latency');
  const hasLatencyColumns = ['lookback_minutes', 'sample_size', 'breach_count', 'latency_threshold_ms'].every((column) =>
    columnExists(db, 'owned_site_automation_tasks', column)
  );
  if (hasLatencyType && hasLatencyColumns) return;

  const selectLookback = columnExists(db, 'owned_site_automation_tasks', 'lookback_minutes') ? 'lookback_minutes' : '10';
  const selectSampleSize = columnExists(db, 'owned_site_automation_tasks', 'sample_size') ? 'sample_size' : '20';
  const selectBreachCount = columnExists(db, 'owned_site_automation_tasks', 'breach_count') ? 'breach_count' : '5';
  const selectLatencyThreshold = columnExists(db, 'owned_site_automation_tasks', 'latency_threshold_ms') ? 'latency_threshold_ms' : '7000';

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE owned_site_automation_tasks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'account_error' CHECK (type IN ('account_error', 'group_first_token_latency')),
      enabled INTEGER NOT NULL DEFAULT 1,
      target_type TEXT NOT NULL CHECK (target_type IN ('account', 'group')),
      target_account_id TEXT,
      target_account_name TEXT,
      target_group_id TEXT,
      target_group_name TEXT,
      interval_minutes INTEGER NOT NULL DEFAULT 30,
      lookback_minutes INTEGER NOT NULL DEFAULT 10,
      sample_size INTEGER NOT NULL DEFAULT 20,
      breach_count INTEGER NOT NULL DEFAULT 5,
      latency_threshold_ms INTEGER NOT NULL DEFAULT 7000,
      cooldown_minutes INTEGER NOT NULL DEFAULT 10,
      recipients_json TEXT,
      last_run_at TEXT,
      last_alert_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO owned_site_automation_tasks_new (
      id, site_id, type, enabled, target_type, target_account_id, target_account_name, target_group_id, target_group_name,
      interval_minutes, lookback_minutes, sample_size, breach_count, latency_threshold_ms, cooldown_minutes,
      recipients_json, last_run_at, last_alert_at, created_at, updated_at
    )
    SELECT
      id, site_id, type, enabled, target_type, target_account_id, target_account_name, target_group_id, target_group_name,
      interval_minutes, ${selectLookback}, ${selectSampleSize}, ${selectBreachCount}, ${selectLatencyThreshold}, cooldown_minutes,
      recipients_json, last_run_at, last_alert_at, created_at, updated_at
    FROM owned_site_automation_tasks;
    DROP TABLE owned_site_automation_tasks;
    ALTER TABLE owned_site_automation_tasks_new RENAME TO owned_site_automation_tasks;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function migrateOwnedSiteUpstreamMonitorSchema(db: DatabaseSync): void {
  if (!columnExists(db, 'owned_site_upstream_monitors', 'retry_count')) {
    db.prepare('ALTER TABLE owned_site_upstream_monitors ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 2').run();
  }
  if (!columnExists(db, 'owned_site_upstream_monitors', 'pause_start_time')) {
    db.prepare("ALTER TABLE owned_site_upstream_monitors ADD COLUMN pause_start_time TEXT NOT NULL DEFAULT '01:00'").run();
  }
  if (!columnExists(db, 'owned_site_upstream_monitors', 'pause_end_time')) {
    db.prepare("ALTER TABLE owned_site_upstream_monitors ADD COLUMN pause_end_time TEXT NOT NULL DEFAULT '08:00'").run();
  }
  for (const column of ['attempt_count', 'success_count', 'failure_count']) {
    if (!columnExists(db, 'owned_site_upstream_monitor_results', column)) {
      db.prepare(`ALTER TABLE owned_site_upstream_monitor_results ADD COLUMN ${column} INTEGER`).run();
    }
  }

  if (!tableSql(db, 'owned_site_upstream_monitors').includes("'partial'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE owned_site_upstream_monitors_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        account_name TEXT,
        account_platform TEXT,
        account_type TEXT,
        group_ids_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 10,
        retry_count INTEGER NOT NULL DEFAULT 2,
        pause_start_time TEXT NOT NULL DEFAULT '01:00',
        pause_end_time TEXT NOT NULL DEFAULT '08:00',
        skip_model_patterns_json TEXT NOT NULL DEFAULT '["gpt-image-*","codex-auto-review"]',
        last_run_at TEXT,
        last_status TEXT CHECK (last_status IN ('success', 'failed', 'partial', 'skipped')),
        last_error TEXT,
        last_latency_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(site_id, account_id)
      );
      INSERT INTO owned_site_upstream_monitors_new (
        id, site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json,
        last_run_at, last_status, last_error, last_latency_ms, created_at, updated_at
      )
      SELECT
        id, site_id, account_id, account_name, account_platform, account_type, group_ids_json,
        enabled, interval_minutes, retry_count, pause_start_time, pause_end_time, skip_model_patterns_json,
        last_run_at, last_status, last_error, last_latency_ms, created_at, updated_at
      FROM owned_site_upstream_monitors;
      DROP TABLE owned_site_upstream_monitors;
      ALTER TABLE owned_site_upstream_monitors_new RENAME TO owned_site_upstream_monitors;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  if (!tableSql(db, 'owned_site_upstream_monitor_results').includes("'partial'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE owned_site_upstream_monitor_results_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id INTEGER NOT NULL REFERENCES owned_sites(id) ON DELETE CASCADE,
        monitor_id INTEGER REFERENCES owned_site_upstream_monitors(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        account_name TEXT,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial', 'skipped')),
        attempt_count INTEGER,
        success_count INTEGER,
        failure_count INTEGER,
        latency_ms INTEGER,
        message TEXT NOT NULL DEFAULT '',
        raw_json TEXT,
        checked_at TEXT NOT NULL
      );
      INSERT INTO owned_site_upstream_monitor_results_new (
        id, site_id, monitor_id, account_id, account_name, model, status,
        attempt_count, success_count, failure_count, latency_ms, message, raw_json, checked_at
      )
      SELECT
        id, site_id, monitor_id, account_id, account_name, model, status,
        attempt_count, success_count, failure_count, latency_ms, message, raw_json, checked_at
      FROM owned_site_upstream_monitor_results;
      DROP TABLE owned_site_upstream_monitor_results;
      ALTER TABLE owned_site_upstream_monitor_results_new RENAME TO owned_site_upstream_monitor_results;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_monitors_site
      ON owned_site_upstream_monitors(site_id);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_results_account_time
      ON owned_site_upstream_monitor_results(site_id, account_id, checked_at);

    CREATE INDEX IF NOT EXISTS idx_owned_site_upstream_results_monitor_time
      ON owned_site_upstream_monitor_results(monitor_id, checked_at);
  `);
}

function migrateOwnedSiteUpstreamMonitorDefaults(db: DatabaseSync): void {
  db.prepare(`
    UPDATE owned_site_upstream_monitors
    SET interval_minutes = 10,
        skip_model_patterns_json = '["gpt-image-*","codex-auto-review"]'
    WHERE interval_minutes = 30
      AND skip_model_patterns_json = '[]'
      AND last_run_at IS NULL
      AND last_status IS NULL
  `).run();
  db.prepare(`
    UPDATE owned_site_upstream_monitors
    SET skip_model_patterns_json = '["gpt-image-*","codex-auto-review"]'
    WHERE skip_model_patterns_json = '["gpt-image-*"]'
      AND last_run_at IS NULL
      AND last_status IS NULL
  `).run();
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

export function getOwnedSite(db: DatabaseSync, id: number): OwnedSiteRecord | null {
  return (db.prepare('SELECT * FROM owned_sites WHERE id = ?').get(id) as OwnedSiteRecord | undefined) || null;
}

export function sanitizeOwnedSite(site: OwnedSiteRecord): SafeOwnedSite {
  return {
    id: site.id,
    name: site.name,
    type: site.type,
    base_url: site.base_url,
    status: site.status,
    last_check_at: site.last_check_at,
    last_error: site.last_error,
    created_at: site.created_at,
    updated_at: site.updated_at,
    has_admin_api_key: Boolean(site.admin_api_key)
  };
}

export function parseTask(row: AutomationTaskRecord): AutomationTask {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    recipients: parseJson<string[]>(row.recipients_json, [])
  };
}

export function parseOwnedSiteTask(row: OwnedSiteAutomationTaskRecord): OwnedSiteAutomationTask {
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
