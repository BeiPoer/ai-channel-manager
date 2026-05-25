export type ChannelType = 'sub2api' | 'newapi';
export type ChannelStatus = 'active' | 'error' | 'syncing';
export type CacheKey = 'profile' | 'groups' | 'tokens' | 'subscriptions';
export type AutomationTaskType = 'low_balance' | 'burn_rate' | 'group_added' | 'group_removed' | 'group_ratio_changed';

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

export interface EmailSettings {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password?: string;
  smtp_from: string;
  default_recipients: string[];
  default_interval_minutes: number;
  has_smtp_password?: boolean;
}
