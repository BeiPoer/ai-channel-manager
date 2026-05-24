export type ChannelType = 'sub2api' | 'newapi';
export type ChannelStatus = 'active' | 'error' | 'syncing';
export type TaskType = 'low_balance' | 'burn_rate' | 'group_added' | 'group_removed' | 'group_ratio_changed';

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  base_url: string;
  username: string | null;
  password: string | null;
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

export interface Overview {
  channel: Channel;
  profile: Record<string, unknown> | null;
  groups: unknown[];
  tokens: unknown[];
  subscriptions: unknown;
  latest_snapshot: BalanceSnapshot | null;
  history: BalanceSnapshot[];
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
