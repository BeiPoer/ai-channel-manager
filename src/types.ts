export type ChannelType = 'sub2api' | 'newapi';
export type ChannelStatus = 'active' | 'error' | 'syncing';
export type TaskType = 'low_balance' | 'burn_rate' | 'group_added' | 'group_removed' | 'group_ratio_changed';
export type OwnedSiteType = 'sub2api';
export type OwnedSiteStatus = 'active' | 'error' | 'syncing';
export type OwnedSiteTaskType = 'account_error';
export type OwnedSiteTaskTargetType = 'account' | 'group';

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  base_url: string;
  username: string | null;
  password: string | null;
  newapi_access_token: string | null;
  newapi_user_id: string | null;
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
  captured_at: string;
}

export type BalanceQueryStatus = 'success' | 'error';

export interface BalanceQueryLog {
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

export interface Overview {
  channel: Channel;
  profile: Record<string, unknown> | null;
  groups: unknown[];
  tokens: unknown[];
  subscriptions: unknown;
  latest_snapshot: BalanceSnapshot | null;
  history: BalanceSnapshot[];
}

export interface TokenModelsResult {
  token_id: number;
  token_name: string | null;
  source: 'token_limits' | 'upstream_models';
  models: string[];
}

export interface AutomationTask {
  id: number;
  channel_id: number;
  type: TaskType;
  enabled: boolean;
  interval_minutes: number;
  threshold: number;
  lookback_minutes: number;
  cooldown_minutes: number;
  recipients: string[];
  last_run_at: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AlertEvent {
  id: number;
  channel_id: number;
  task_id: number | null;
  channel_name: string;
  type: TaskType;
  message: string;
  email_sent: number;
  email_error: string | null;
  created_at: string;
}

export interface OwnedSite {
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

export interface OwnedSiteGroup {
  id: string;
  name: string;
  platform: string;
  status: string;
  raw: Record<string, unknown>;
}

export interface OwnedSiteAccount {
  id: string;
  name: string;
  platform: string;
  type: string;
  status: string;
  group_ids: string[];
  groups: Record<string, unknown>[];
  schedulable: boolean | null;
  error_message: string;
  last_used_at: string | null;
  updated_at: string | null;
  raw: Record<string, unknown>;
}

export interface OwnedSiteAutomationTask {
  id: number;
  site_id: number;
  type: OwnedSiteTaskType;
  enabled: boolean;
  target_type: OwnedSiteTaskTargetType;
  target_account_id: string | null;
  target_account_name: string | null;
  target_group_id: string | null;
  target_group_name: string | null;
  interval_minutes: number;
  cooldown_minutes: number;
  recipients: string[];
  last_run_at: string | null;
  last_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnedSiteAlertEvent {
  id: number;
  site_id: number;
  task_id: number | null;
  type: OwnedSiteTaskType;
  target_type: OwnedSiteTaskTargetType | null;
  target_id: string | null;
  account_id: string | null;
  account_name: string | null;
  site_name: string;
  message: string;
  before_status: string | null;
  after_status: string | null;
  email_sent: number;
  email_error: string | null;
  created_at: string;
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

export type AuthState = 'checking' | 'authenticated' | 'anonymous';
