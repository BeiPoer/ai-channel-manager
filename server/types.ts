export type ChannelType = 'sub2api' | 'newapi' | 'other';
export type ChannelStatus = 'active' | 'error' | 'syncing';
export type CacheKey = 'profile' | 'groups' | 'tokens' | 'subscriptions';
export type AutomationTaskType = 'low_balance' | 'burn_rate' | 'group_added' | 'group_removed' | 'group_ratio_changed';
export type OwnedSiteType = 'sub2api';
export type OwnedSiteStatus = 'active' | 'error' | 'syncing';
export type OwnedSiteTaskType = 'account_error' | 'group_first_token_latency' | 'upstream_monitor_failed';
export type OwnedSiteTaskTargetType = 'account' | 'group';

export interface ChannelRecord {
  id: number;
  name: string;
  type: ChannelType;
  base_url: string;
  username: string | null;
  password: string | null;
  newapi_access_token: string | null;
  newapi_user_id: string | null;
  sub2api_access_token: string | null;
  sub2api_refresh_token: string | null;
  sub2api_token_expires_at: number | null;
  ignored: number;
  status: ChannelStatus;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafeChannel {
  id: number;
  name: string;
  type: ChannelType;
  base_url: string;
  username: string | null;
  password: string | null;
  newapi_access_token: string | null;
  newapi_user_id: string | null;
  ignored: boolean;
  status: ChannelStatus;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  has_password: boolean;
  has_newapi_access_token: boolean;
}

export interface BalanceSnapshot {
  id: number;
  channel_id: number;
  balance: number;
  used_balance: number | null;
  unit: string;
  raw_json: string | null;
  captured_at: string;
}

export type BalanceQueryStatus = 'success' | 'error';

export interface BalanceQueryLogRecord {
  id: number;
  channel_id: number;
  status: BalanceQueryStatus;
  balance: number | null;
  used_balance: number | null;
  unit: string | null;
  message: string;
  error: string | null;
  raw_json: string | null;
  created_at: string;
}

export interface SyncResult {
  profile: unknown;
  balanceSnapshot: {
    balance: number;
    used_balance?: number | null;
    unit: string;
    raw: unknown;
  };
  groups: unknown[];
  tokens: unknown[];
  subscriptions?: unknown;
  raw: Record<string, unknown>;
}

export interface AutomationTaskRecord {
  id: number;
  channel_id: number;
  type: AutomationTaskType;
  enabled: number;
  interval_minutes: number;
  threshold: number;
  lookback_minutes: number;
  cooldown_minutes: number;
  recipients_json: string | null;
  last_run_at: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationTask extends Omit<AutomationTaskRecord, 'enabled' | 'recipients_json'> {
  enabled: boolean;
  recipients: string[];
}

export interface OwnedSiteRecord {
  id: number;
  name: string;
  type: OwnedSiteType;
  base_url: string;
  admin_api_key: string | null;
  status: OwnedSiteStatus;
  last_check_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SafeOwnedSite {
  id: number;
  name: string;
  type: OwnedSiteType;
  base_url: string;
  status: OwnedSiteStatus;
  last_check_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  has_admin_api_key: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

export interface OwnedSiteAutomationTaskRecord {
  id: number;
  site_id: number;
  type: OwnedSiteTaskType;
  enabled: number;
  target_type: OwnedSiteTaskTargetType;
  target_account_id: string | null;
  target_account_name: string | null;
  target_group_id: string | null;
  target_group_name: string | null;
  interval_minutes: number;
  lookback_minutes: number;
  sample_size: number;
  breach_count: number;
  latency_threshold_ms: number;
  cooldown_minutes: number;
  recipients_json: string | null;
  last_run_at: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnedSiteAutomationTask extends Omit<OwnedSiteAutomationTaskRecord, 'enabled' | 'recipients_json'> {
  enabled: boolean;
  recipients: string[];
}

export interface OwnedSiteAccountStateRecord {
  site_id: number;
  account_id: string;
  account_name: string | null;
  status: string | null;
  error_message: string | null;
  group_ids_json: string | null;
  raw_json: string | null;
  checked_at: string;
}

export type OwnedSiteUpstreamMonitorStatus = 'success' | 'failed' | 'partial' | 'skipped';
export type OwnedSiteUpstreamTimelineStatus = OwnedSiteUpstreamMonitorStatus | 'empty';

export interface OwnedSiteUpstreamGroupMonitorRecord {
  id: number;
  site_id: number;
  group_id: string;
  group_name: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface OwnedSiteUpstreamAlertSettingRecord {
  site_id: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface OwnedSiteUpstreamMonitorRecord {
  id: number;
  site_id: number;
  account_id: string;
  account_name: string | null;
  account_platform: string | null;
  account_type: string | null;
  group_ids_json: string;
  enabled: number;
  interval_minutes: number;
  retry_count: number;
  pause_start_time: string;
  pause_end_time: string;
  skip_model_patterns_json: string;
  last_run_at: string | null;
  last_status: OwnedSiteUpstreamMonitorStatus | null;
  last_error: string | null;
  last_latency_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface OwnedSiteUpstreamMonitorResultRecord {
  id: number;
  site_id: number;
  monitor_id: number | null;
  account_id: string;
  account_name: string | null;
  model: string | null;
  status: OwnedSiteUpstreamMonitorStatus;
  attempt_count: number | null;
  success_count: number | null;
  failure_count: number | null;
  latency_ms: number | null;
  message: string;
  raw_json: string | null;
  checked_at: string;
}

export interface EmailSettings {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password?: string;
  smtp_from: string;
  subject_prefix: string;
  default_recipients: string[];
  default_interval_minutes: number;
  has_smtp_password?: boolean;
}
