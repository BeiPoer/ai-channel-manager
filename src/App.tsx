import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  Home,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  Copy,
  ExternalLink,
  LogOut,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Trash2,
  ListChecks,
  Users,
  WalletCards,
  X,
  Zap
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent, PointerEvent, ReactNode } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { buildAppPath, normalizeRoute, parseAppRoute } from './routing';
import type { AppRoute, ChannelTabKey, NavigationMode, OwnedSiteTabKey } from './routing';
import type {
  AlertEvent,
  AuthState,
  AutomationTask,
  BalanceQueryLog,
  Channel,
  ChannelType,
  EmailSettings,
  Overview,
  OwnedSite,
  OwnedSiteAccount,
  OwnedSiteAlertEvent,
  OwnedSiteAutomationTask,
  OwnedSiteGroup,
  OwnedSiteTaskTargetType,
  PaginatedResult,
  TaskType,
  TokenModelsResult
} from './types';

type TabKey = ChannelTabKey;
type AppModule = AppRoute['module'];
type OwnedSiteRoute = Extract<AppRoute, { module: 'owned-sites' }>;

type MessageState = {
  tone: 'success' | 'error';
  text: string;
} | null;

type GroupOption = {
  value: string;
  label: string;
};

const defaultRoute: AppRoute = { module: 'home' };

function readCurrentRoute(): AppRoute {
  if (typeof window === 'undefined') return defaultRoute;
  return parseAppRoute(window.location.pathname);
}

const emptyEmail: EmailSettings = {
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_from: '',
  subject_prefix: '',
  default_recipients: [],
  default_interval_minutes: 30
};

const taskTimingDefaults: Record<TaskType, { interval_minutes: number; cooldown_minutes: number }> = {
  low_balance: { interval_minutes: 5, cooldown_minutes: 30 },
  burn_rate: { interval_minutes: 30, cooldown_minutes: 60 },
  group_added: { interval_minutes: 30, cooldown_minutes: 60 },
  group_removed: { interval_minutes: 30, cooldown_minutes: 60 },
  group_ratio_changed: { interval_minutes: 30, cooldown_minutes: 60 }
};

const statusCopy: Record<Channel['status'], { label: string; caption: string }> = {
  active: { label: '正常', caption: '可用' },
  syncing: { label: '同步中', caption: '处理中' },
  error: { label: '异常', caption: '需处理' }
};

const accountStatusCopy: Record<string, string> = {
  active: '正常',
  inactive: '停用',
  disabled: '禁用',
  error: '错误',
  rate_limited: '限速',
  temp_unschedulable: '临时不可调度',
  unschedulable: '不可调度',
  pending: '待处理'
};

const ownedTaskTargetCopy: Record<OwnedSiteTaskTargetType, string> = {
  account: '指定账号',
  group: '指定分组'
};

const taskTypeCopy: Record<TaskType, string> = {
  low_balance: '低余额',
  burn_rate: '消耗过快',
  group_added: '新增分组',
  group_removed: '减少分组',
  group_ratio_changed: '倍率变化'
};

const columnLabels: Record<string, string> = {
  id: 'ID',
  ID: 'ID',
  name: '名称',
  key: '密钥',
  value: '值',
  email: '邮箱',
  username: '账号',
  user_id: '用户 ID',
  role: '角色',
  balance: '余额',
  used_balance: '已用余额',
  total_recharged: '累计充值',
  quota: '额度',
  used_quota: '已用额度',
  quota_used: '已用额度',
  remain_quota: '剩余额度',
  status: '状态',
  active: '启用',
  summary: '摘要',
  group: '分组',
  group_id: '分组 ID',
  groupId: '分组 ID',
  allowed_groups: '允许分组',
  groups: '分组',
  group_ids: '分组 ID',
  schedulable: '可调度',
  error_message: '错误信息',
  before_status: '原状态',
  after_status: '新状态',
  target_type: '目标类型',
  target_id: '目标 ID',
  account_id: '账号 ID',
  account_name: '账号名称',
  site_name: '站点名称',
  ratio: '倍率',
  rate: '倍率',
  rate_multiplier: '倍率',
  rpm_limit: 'RPM 限制',
  concurrency: '并发数',
  run_mode: '运行模式',
  user_group: '用户分组',
  platform: '平台',
  description: '描述',
  type: '类型',
  plan: '套餐',
  subscription_type: '订阅类型',
  active_count: '活跃数',
  total: '总数',
  count: '数量',
  items: '项目',
  created_at: '创建时间',
  updated_at: '更新时间',
  expires_at: '过期时间',
  expired_time: '过期时间',
  last_active_at: '最近活跃',
  last_used_at: '最近使用',
  accessed_time: '最近访问',
  created_time: '创建时间',
  ip_whitelist: 'IP 白名单',
  ip_blacklist: 'IP 黑名单',
  identities: '身份',
  identity_bindings: '身份绑定',
  auth_bindings: '认证绑定',
  email_bound: '邮箱绑定',
  dingtalk_bound: '钉钉绑定',
  wechat_bound: '微信绑定',
  linuxdo_bound: 'LinuxDO 绑定',
  oidc_bound: 'OIDC 绑定',
  balance_notify_enabled: '余额通知',
  balance_notify_threshold: '余额通知阈值',
  balance_notify_threshold_type: '余额通知阈值类型',
  balance_notify_extra_emails: '余额通知额外邮箱',
  allow_image_generation: '允许生图',
  allow_messages_dispatch: '允许消息调度',
  claude_code_only: '仅 Claude Code',
  daily_limit_usd: '每日限额',
  weekly_limit_usd: '每周限额',
  monthly_limit_usd: '每月限额',
  fallback_group_id: '备用分组 ID',
  fallback_group_id_on_invalid_request: '无效请求备用分组 ID',
  image_price_1k: '图片 1K 价格',
  image_price_2k: '图片 2K 价格',
  image_price_4k: '图片 4K 价格',
  image_rate_independent: '图片独立倍率',
  image_rate_multiplier: '图片倍率',
  is_exclusive: '专属分组',
  require_oauth_only: '仅 OAuth',
  require_privacy_set: '要求隐私设置',
  unlimited_quota: '不限额度',
  model_limits_enabled: '模型限制',
  model_limits: '模型列表',
  allow_ips: '允许 IP',
  cross_group_retry: '跨组重试',
  rate_limit_5h: '5 小时限速',
  rate_limit_1d: '1 日限速',
  rate_limit_7d: '7 日限速',
  usage_5h: '5 小时用量',
  usage_1d: '1 日用量',
  usage_7d: '7 日用量',
  window_5h_start: '5 小时窗口开始',
  window_1d_start: '1 日窗口开始',
  window_7d_start: '7 日窗口开始',
  raw: '原始数据',
  error: '错误',
  message: '消息'
};

const labelTokenMap: Record<string, string> = {
  active: '活跃',
  allow: '允许',
  allowed: '允许',
  balance: '余额',
  blacklist: '黑名单',
  bindings: '绑定',
  bound: '绑定',
  claude: 'Claude',
  code: 'Code',
  concurrency: '并发',
  count: '数量',
  created: '创建',
  cross: '跨',
  daily: '每日',
  description: '描述',
  dispatch: '调度',
  email: '邮箱',
  enabled: '启用',
  error: '错误',
  exclusive: '专属',
  expired: '过期',
  expires: '过期',
  extra: '额外',
  fallback: '备用',
  generation: '生成',
  group: '分组',
  groups: '分组',
  id: 'ID',
  identities: '身份',
  identity: '身份',
  image: '图片',
  independent: '独立',
  invalid: '无效',
  ip: 'IP',
  key: '密钥',
  last: '最近',
  limit: '限制',
  linuxdo: 'LinuxDO',
  messages: '消息',
  mode: '模式',
  monthly: '每月',
  name: '名称',
  notify: '通知',
  oauth: 'OAuth',
  oidc: 'OIDC',
  only: '仅',
  platform: '平台',
  price: '价格',
  privacy: '隐私',
  quota: '额度',
  rate: '倍率',
  recharged: '充值',
  remain: '剩余',
  request: '请求',
  require: '要求',
  retry: '重试',
  role: '角色',
  rpm: 'RPM',
  run: '运行',
  start: '开始',
  status: '状态',
  subscription: '订阅',
  threshold: '阈值',
  time: '时间',
  total: '累计',
  type: '类型',
  updated: '更新',
  usage: '用量',
  used: '已用',
  user: '用户',
  weekly: '每周',
  whitelist: '白名单',
  window: '窗口'
};

const tableValueLabels: Record<string, string> = {
  active: '启用',
  inactive: '停用',
  disabled: '禁用',
  enabled: '启用',
  expired: '已过期',
  quota_exhausted: '额度耗尽',
  exhausted: '已耗尽',
  pending: '待处理',
  error: '异常',
  success: '成功',
  failed: '失败',
  standard: '标准',
  premium: '高级',
  trial: '试用',
  free: '免费',
  user: '用户',
  admin: '管理员',
  owner: '所有者',
  root: '超级管理员',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  auto: '自动'
};

const translatedValueColumns = new Set([
  'status',
  'role',
  'subscription_type',
  'platform',
  'type',
  'run_mode'
]);

function formatTime(value: string | null | undefined, fallback = '-') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

function formatShortTime(value: string | null | undefined, fallback = '从未同步') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
}

function formatCompactNumber(value: number) {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return '-';
  if (abs >= 100000) return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  if (abs >= 1000) return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
  if (abs >= 100) return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function smoothPath(points: { x: number; y: number }[]) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  const segments = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    const cp1 = {
      x: current.x + (next.x - previous.x) / 6,
      y: current.y + (next.y - previous.y) / 6
    };
    const cp2 = {
      x: next.x - (afterNext.x - current.x) / 6,
      y: next.y - (afterNext.y - current.y) / 6
    };
    segments.push(
      `C ${cp1.x.toFixed(2)} ${cp1.y.toFixed(2)} ${cp2.x.toFixed(2)} ${cp2.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
    );
  }
  return segments.join(' ');
}

function asRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : { value: item }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([key, value]) =>
      value && typeof value === 'object' ? { name: key, ...(value as Record<string, unknown>) } : { name: key, value }
    );
  }
  return [];
}

function subscriptionRows(data: unknown): Record<string, unknown>[] {
  if (isRecord(data) && 'active' in data) return asRows(data.active);
  return asRows(data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function valuePreview(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function displayValue(column: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string' && translatedValueColumns.has(column)) {
    return tableValueLabels[value.toLowerCase()] || value;
  }
  return valuePreview(value);
}

function tableColumnClass(column: string): string {
  const normalized = column.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return normalized ? `jsonColumn jsonColumn-${normalized}` : 'jsonColumn';
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('复制失败');
  } finally {
    document.body.removeChild(textarea);
  }
}

function columnLabel(column: string): string {
  if (columnLabels[column]) return columnLabels[column];
  return column
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => labelTokenMap[part.toLowerCase()] || part.toUpperCase())
    .join(' ');
}

function tokenIdOf(row: Record<string, unknown>): number | null {
  const parsed = Number(row.id ?? row.ID);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function groupNameFrom(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (isRecord(value)) return String(value.name ?? value.id ?? '').trim();
  return '';
}

function groupIdFrom(row: Record<string, unknown>): string {
  const direct = row.group_id ?? row.groupId;
  if (direct !== null && direct !== undefined && String(direct).trim() !== '') return String(direct);
  if (isRecord(row.group)) {
    const groupId = row.group.id ?? row.group.ID;
    if (groupId !== null && groupId !== undefined && String(groupId).trim() !== '') return String(groupId);
  }
  return '';
}

function stringIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function addIdentifier(identifiers: Set<string>, value: unknown) {
  const identifier = stringIdentifier(value);
  if (identifier) identifiers.add(identifier);
}

function collectGroupIdentifiers(value: unknown, identifiers = new Set<string>()): Set<string> {
  if (!isRecord(value)) {
    addIdentifier(identifiers, value);
    return identifiers;
  }
  const fields = [
    'id',
    'ID',
    'group_id',
    'groupId',
    'groupID',
    'name',
    'Name',
    'group',
    'Group',
    'key',
    'code',
    'group_name',
    'groupName',
    'display_name',
    'displayName',
    'title'
  ];
  for (const field of fields) {
    const fieldValue = value[field];
    if (isRecord(fieldValue)) {
      collectGroupIdentifiers(fieldValue, identifiers);
    } else {
      addIdentifier(identifiers, fieldValue);
    }
  }
  return identifiers;
}

function tokenGroupIdentifiers(row: Record<string, unknown>, channelType: ChannelType): Set<string> {
  const identifiers = new Set<string>();
  for (const field of ['group_id', 'groupId', 'groupID', 'group_name', 'groupName']) {
    addIdentifier(identifiers, row[field]);
  }
  const group = row.group ?? row.Group;
  if (isRecord(group)) {
    collectGroupIdentifiers(group, identifiers);
  } else {
    addIdentifier(identifiers, group);
    if (channelType === 'newapi' && group !== undefined && group !== null && String(group).trim() === '') {
      identifiers.add('default');
    }
  }
  return identifiers;
}

function groupRatioFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!isRecord(value)) return null;
  const fields = ['ratio', 'rate', 'multiplier', 'rate_multiplier', 'rateMultiplier', 'group_ratio', 'model_ratio', '倍率', 'value'];
  for (const field of fields) {
    const fieldValue = value[field];
    const parsed = typeof fieldValue === 'number' ? fieldValue : typeof fieldValue === 'string' ? Number(fieldValue) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function groupRatioLookup(groups: unknown[]): Map<string, number> {
  const ratios = new Map<string, number>();
  for (const group of asRows(groups)) {
    const ratio = groupRatioFrom(group);
    if (ratio === null) continue;
    for (const identifier of collectGroupIdentifiers(group)) {
      ratios.set(identifier, ratio);
    }
  }
  return ratios;
}

function tokenGroupRatioLabel(channelType: ChannelType, row: Record<string, unknown>, ratios: Map<string, number>): string {
  for (const identifier of tokenGroupIdentifiers(row, channelType)) {
    const ratio = ratios.get(identifier);
    if (ratio !== undefined) return formatNumber(ratio);
  }
  const embeddedRatio = groupRatioFrom(row.group ?? row.Group);
  return embeddedRatio === null ? '-' : formatNumber(embeddedRatio);
}

function appendUniqueOption(options: GroupOption[], option: GroupOption) {
  if (!option.value || options.some((item) => item.value === option.value)) return options;
  return [...options, option];
}

function tokenGroupOptions(overview: Overview, rows: Record<string, unknown>[]): GroupOption[] {
  const groups = asRows(overview.groups);
  let options: GroupOption[] = [];
  if (overview.channel.type === 'sub2api') {
    for (const group of groups) {
      const id = group.id ?? group.ID ?? group.group_id;
      if (id === null || id === undefined || String(id).trim() === '') continue;
      const label = groupNameFrom(group.name ?? group.display_name ?? group.title ?? id);
      options = appendUniqueOption(options, { value: String(id), label: label || String(id) });
    }
    for (const row of rows) {
      const value = groupIdFrom(row);
      if (!value) continue;
      const label = isRecord(row.group) ? groupNameFrom(row.group.name ?? value) : value;
      options = appendUniqueOption(options, { value, label: label || value });
    }
    return options;
  }

  options = [{ value: '', label: '默认分组' }];
  for (const group of groups) {
    const name = groupNameFrom(group.name ?? group.group ?? group.value);
    if (!name) continue;
    options = appendUniqueOption(options, { value: name, label: name });
  }
  for (const row of rows) {
    const name = groupNameFrom(row.group);
    if (!name) continue;
    options = appendUniqueOption(options, { value: name, label: name });
  }
  return options;
}

function currentTokenGroupValue(channelType: ChannelType, row: Record<string, unknown>): string {
  if (channelType === 'sub2api') return groupIdFrom(row);
  if (channelType === 'newapi') return groupNameFrom(row.group);
  return '';
}

function tokenColumns(rows: Record<string, unknown>[]) {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const visibleColumns = [
    'id',
    'name',
    'key',
    'status',
    'remain_quota',
    'used_quota',
    'expired_time'
  ];
  return visibleColumns.filter((key) => keys.includes(key));
}

function credentialLabel(channel: Channel) {
  if (channel.type === 'sub2api') return channel.has_password ? '密码已保存' : '待配置密码';
  if (channel.type === 'other') return channel.has_password ? '密码已保存' : '待配置密码';
  return channel.has_newapi_access_token ? '令牌已保存' : '待配置令牌';
}

function siteCredentialLabel(site: OwnedSite) {
  return site.has_admin_api_key ? 'Admin API Key 已保存' : '待配置 Admin API Key';
}

function groupLabel(group: OwnedSiteGroup) {
  return group.name && group.name !== group.id ? `${group.name}（${group.id}）` : group.id || group.name || '-';
}

function accountGroupLabel(account: OwnedSiteAccount, groups: OwnedSiteGroup[] = []) {
  const byId = new Map(groups.map((group) => [group.id, group.name || group.id]));
  const names = account.groups
    .map((group) => groupNameFrom(group.name ?? group.title ?? group.id))
    .filter(Boolean);
  const ids = account.group_ids.map((id) => byId.get(id) || id).filter(Boolean);
  return Array.from(new Set([...names, ...ids])).join('、') || '-';
}

function accountStatusLabel(status: string) {
  return accountStatusCopy[status] || status || '-';
}

function isGroupTaskType(type: TaskType) {
  return type === 'group_added' || type === 'group_removed' || type === 'group_ratio_changed';
}

function taskSummary(task: AutomationTask) {
  if (task.type === 'low_balance') return `余额 <= ${formatNumber(task.threshold)}`;
  if (task.type === 'burn_rate') return `每小时消耗 >= ${formatNumber(task.threshold)}`;
  if (task.type === 'group_added') return '发现新增分组时告警';
  if (task.type === 'group_removed') return '发现减少分组时告警';
  return '发现分组倍率变化时告警';
}

function StatusBadge({ status }: { status: Channel['status'] | OwnedSite['status'] }) {
  return <span className={`statusBadge ${status}`}>{statusCopy[status].label}</span>;
}

function TypeBadge({ type }: { type: ChannelType | OwnedSite['type'] }) {
  const label = type === 'sub2api' ? 'sub2api' : type === 'newapi' ? 'new-api' : '其它';
  return <span className={`typeBadge ${type}`}>{label}</span>;
}

function AccountStatusBadge({ status }: { status: string }) {
  const tone = status === 'error' ? 'error' : status === 'active' ? 'active' : status === 'rate_limited' ? 'syncing' : 'neutral';
  return <span className={`statusBadge ${tone}`}>{accountStatusLabel(status)}</span>;
}

function SectionHeader({
  title,
  description,
  icon,
  right
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="sectionHeader">
      <div className="sectionTitle">
        {icon && <span className="sectionIcon">{icon}</span>}
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

function DataSection({
  title,
  description,
  icon,
  right,
  children,
  className = ''
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`dataPanel ${className}`}>
      <SectionHeader title={title} description={description} icon={icon} right={right} />
      {children}
    </section>
  );
}

function MetricCard({
  label,
  value,
  meta,
  icon,
  tone = 'default'
}: {
  label: string;
  value: ReactNode;
  meta: ReactNode;
  icon: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'error' | 'accent';
}) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metricTop">
        <span>{label}</span>
        <span className="metricIcon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <small>{meta}</small>
    </div>
  );
}

function LoadingState({ label = '正在加载数据' }: { label?: string }) {
  return (
    <div className="loadingState">
      <RefreshCw size={18} className="spin" />
      <span>{label}</span>
    </div>
  );
}

function EmptyPanel({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="emptyPanel">
      <span className="emptyIcon">{icon}</span>
      <p>{title}</p>
      {action}
    </div>
  );
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void | Promise<void> }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.login(password);
      setPassword('');
      await onAuthenticated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="loginShell">
      <form className="loginPanel" onSubmit={submit}>
        <div className="loginIcon">
          <KeyRound size={24} />
        </div>
        <span className="brandKicker">SECURE ACCESS</span>
        <h1>AI 渠道管理台</h1>
        <p>请输入配置文件里的访问密码。</p>
        <label>
          访问密码
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="errorBox">{error}</div>}
        <button className="primaryButton fullWidth" type="submit" disabled={submitting}>
          {submitting ? '登录中' : '登录'}
        </button>
      </form>
    </main>
  );
}

function ChannelModal({
  channel,
  onClose,
  onSaved
}: {
  channel: Channel | null;
  onClose: () => void;
  onSaved: (channel: Channel) => void | Promise<void>;
}) {
  const [type, setType] = useState<ChannelType>(channel?.type || 'sub2api');
  const [form, setForm] = useState({
    name: channel?.name || '',
    base_url: channel?.base_url || '',
    username: channel?.username || '',
    password: channel?.password || '',
    newapi_access_token: channel?.newapi_access_token || '',
    newapi_user_id: channel?.newapi_user_id || ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isPasswordRequired = !channel && (type === 'sub2api' || type === 'other');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, type };
      const saved = channel ? await api.updateChannel(channel.id, payload) : await api.createChannel(payload);
      await onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modalHeader">
          <div>
            <span className="modalEyebrow">{channel ? 'CHANNEL EDIT' : 'NEW CHANNEL'}</span>
            <h2>{channel ? '编辑渠道' : '添加渠道'}</h2>
            <p>{type === 'other' ? '记录型渠道只保存站点和账号信息，不执行同步、余额查询或告警。' : '配置渠道认证后即可同步余额、账号资料和自动化告警。'}</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="segmented channelTypePicker">
          <button type="button" className={type === 'sub2api' ? 'active' : ''} onClick={() => setType('sub2api')} disabled={Boolean(channel)}>
            sub2api
          </button>
          <button type="button" className={type === 'newapi' ? 'active' : ''} onClick={() => setType('newapi')} disabled={Boolean(channel)}>
            new-api
          </button>
          <button type="button" className={type === 'other' ? 'active' : ''} onClick={() => setType('other')} disabled={Boolean(channel)}>
            其它
          </button>
        </div>

        <label>
          名称
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="可留空自动生成" autoFocus />
        </label>
        <label>
          站点链接
          <input required value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} placeholder="https://example.com" />
        </label>
        <div className="formGrid">
          <label>
            账号
            <input required={isPasswordRequired} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </label>
          <label>
            密码
            <input
              type="text"
              required={isPasswordRequired}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </label>
        </div>
        {type === 'newapi' && (
          <div className="formGrid">
            <label>
              系统访问令牌
              <input
                type="text"
                required={!channel}
                value={form.newapi_access_token}
                onChange={(event) => setForm({ ...form, newapi_access_token: event.target.value })}
              />
            </label>
            <label>
              userId
              <input required value={form.newapi_user_id} onChange={(event) => setForm({ ...form, newapi_user_id: event.target.value })} />
            </label>
          </div>
        )}
        {error && <div className="errorBox">{error}</div>}
        <div className="modalFooter">
          <button type="button" className="ghostButton" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primaryButton" disabled={saving}>
            {saving ? '保存中' : '保存渠道'}
          </button>
        </div>
      </form>
    </div>
  );
}

function EmailModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<EmailSettings>(emptyEmail);
  const [password, setPassword] = useState('');
  const [testRecipient, setTestRecipient] = useState('');
  const [message, setMessage] = useState<MessageState>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api
      .emailSettings()
      .then(setSettings)
      .catch((error) => setMessage({ tone: 'error', text: (error as Error).message }));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.saveEmailSettings({ ...settings, smtp_password: password });
      setSettings(saved);
      setPassword('');
      setMessage({ tone: 'success', text: '邮件设置已保存' });
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      await api.testEmail(testRecipient);
      setMessage({ tone: 'success', text: '测试邮件已发送' });
    } catch (error) {
      setMessage({ tone: 'error', text: (error as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal wideModal" onSubmit={save}>
        <div className="modalHeader">
          <div>
            <span className="modalEyebrow">MAIL DELIVERY</span>
            <h2>邮件设置</h2>
            <p>告警任务会使用这里的 SMTP 和默认收件人配置。</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="formGrid three">
          <label>
            SMTP 主机
            <input value={settings.smtp_host} onChange={(event) => setSettings({ ...settings, smtp_host: event.target.value })} />
          </label>
          <label>
            端口
            <input
              type="number"
              value={settings.smtp_port}
              onChange={(event) => setSettings({ ...settings, smtp_port: Number(event.target.value) })}
            />
          </label>
          <label className="checkboxLabel">
            <input
              type="checkbox"
              checked={settings.smtp_secure}
              onChange={(event) => setSettings({ ...settings, smtp_secure: event.target.checked })}
            />
            SSL/TLS
          </label>
        </div>
        <div className="formGrid">
          <label>
            SMTP 用户
            <input value={settings.smtp_user} onChange={(event) => setSettings({ ...settings, smtp_user: event.target.value })} />
          </label>
          <label>
            SMTP 密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={settings.has_smtp_password ? '已保存，留空保持不变' : ''}
            />
          </label>
        </div>
        <label>
          发件人
          <input value={settings.smtp_from} onChange={(event) => setSettings({ ...settings, smtp_from: event.target.value })} />
        </label>
        <label>
          邮件标题前缀
          <input
            value={settings.subject_prefix}
            onChange={(event) => setSettings({ ...settings, subject_prefix: event.target.value })}
            placeholder="例如：【abc】"
          />
        </label>
        <label>
          默认收件人
          <textarea
            value={settings.default_recipients.join('\n')}
            onChange={(event) => setSettings({ ...settings, default_recipients: event.target.value.split(/\n|,|;/).filter(Boolean) })}
            placeholder="一行一个邮箱，或用逗号分隔"
          />
        </label>
        <label>
          默认轮询间隔（分钟）
          <input
            type="number"
            min={1}
            value={settings.default_interval_minutes}
            onChange={(event) => setSettings({ ...settings, default_interval_minutes: Number(event.target.value) })}
          />
        </label>
        <div className="testRow">
          <div className="inputWithIcon">
            <Mail size={16} />
            <input value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="测试收件人，留空使用默认收件人" />
          </div>
          <button type="button" className="ghostButton" onClick={test} disabled={testing}>
            <Send size={16} />
            {testing ? '发送中' : '发送测试'}
          </button>
        </div>
        {message && <div className={message.tone === 'success' ? 'successBox' : 'errorBox'}>{message.text}</div>}
        <div className="modalFooter">
          <button type="button" className="ghostButton" onClick={onClose}>
            关闭
          </button>
          <button type="submit" className="primaryButton" disabled={saving}>
            {saving ? '保存中' : '保存设置'}
          </button>
        </div>
      </form>
    </div>
  );
}

function JsonTable({ data, emptyText = '暂无数据', className = '' }: { data: unknown; emptyText?: string; className?: string }) {
  const rows = asRows(data);
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="emptyState">{emptyText}</div>;
  return (
    <div className={`tableWrap ${className}`}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className={tableColumnClass(column)}>
                {columnLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className={tableColumnClass(column)} title={valuePreview(row[column])}>
                  {displayValue(column, row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceChart({ history }: { history: Overview['history'] }) {
  const chartId = useId().replace(/:/g, '');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const points = history.slice(-30);
  if (points.length < 2) return <div className="chartEmpty">暂无趋势</div>;
  const values = points.map((item) => item.balance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rawRange = max - min;
  const padding = rawRange === 0 ? Math.max(Math.abs(max) * 0.06, 1) : rawRange * 0.12;
  const lowerBound = min >= 0 ? Math.max(0, min - padding) : min - padding;
  const upperBound = max + padding;
  const range = upperBound - lowerBound || 1;
  const first = points[0];
  const latest = points[points.length - 1];
  const delta = latest.balance - first.balance;
  const deltaPercent = first.balance === 0 ? null : (delta / Math.abs(first.balance)) * 100;
  const trendTone = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const trendLabel = delta > 0 ? '增加' : delta < 0 ? '消耗' : '持平';
  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const value = upperBound - (range * index) / 3;
    return {
      value,
      y: 10 + ((upperBound - value) / range) * 76
    };
  });
  const chartPoints = points.map((item, index) => {
    const plotPaddingX = 1.8;
    return {
      item,
      x: plotPaddingX + (index / (points.length - 1)) * (100 - plotPaddingX * 2),
      y: 10 + ((upperBound - item.balance) / range) * 76
    };
  });
  const pathData = smoothPath(chartPoints);
  const firstPoint = chartPoints[0];
  const latestPoint = chartPoints[chartPoints.length - 1];
  const gradientId = `${chartId}-balance-area`;
  const deltaPrefix = delta > 0 ? '+' : '';
  const deltaValue = delta < 0 ? Math.abs(delta) : delta;
  const percentValue = deltaPercent === null ? null : delta < 0 ? Math.abs(deltaPercent) : deltaPercent;
  const percentPrefix = delta > 0 ? '+' : '';
  const percentLabel =
    percentValue === null
      ? null
      : `${percentPrefix}${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(percentValue)}%`;
  const hoveredPoint = hoverIndex === null ? null : chartPoints[hoverIndex];
  const tooltipAlign = hoveredPoint && hoveredPoint.x > 72 ? 'left' : hoveredPoint && hoveredPoint.x < 28 ? 'right' : 'center';
  const xTicks =
    points.length > 2
      ? [chartPoints[0], chartPoints[Math.floor((chartPoints.length - 1) / 2)], chartPoints[chartPoints.length - 1]]
      : [chartPoints[0], chartPoints[chartPoints.length - 1]];

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const position = ((event.clientX - rect.left) / rect.width) * 100;
    const nextIndex = chartPoints.reduce(
      (nearest, point, index) => {
        const distance = Math.abs(point.x - position);
        return distance < nearest.distance ? { index, distance } : nearest;
      },
      { index: 0, distance: Number.POSITIVE_INFINITY }
    ).index;
    setHoverIndex(nextIndex);
  }

  return (
    <div className="chartFrame">
      <div className="chartSummary">
        <div className="chartValue">
          <span>最新余额</span>
          <div className="chartValueLine">
            <strong>{formatNumber(latest.balance)}</strong>
          </div>
        </div>
        <div className={`chartDelta ${trendTone}`}>
          <span>{trendLabel}</span>
          <strong>
            {deltaPrefix}
            {formatNumber(deltaValue)}
          </strong>
          {percentLabel && <small>{percentLabel}</small>}
        </div>
      </div>
      <div className="chartPlotShell">
        <div className="chartYAxis" aria-hidden="true">
          {yTicks.map((tick) => (
            <span key={tick.value.toFixed(4)} style={{ top: `${tick.y}%` }}>
              {formatCompactNumber(tick.value)}
            </span>
          ))}
        </div>
        <div className="chartPlot">
          <div
            className="chartCanvas"
            onPointerMove={handlePointerMove}
            onPointerLeave={() => setHoverIndex(null)}
            onFocus={() => setHoverIndex(chartPoints.length - 1)}
            onBlur={() => setHoverIndex(null)}
            tabIndex={0}
          >
            <svg className="chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="余额趋势">
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="rgba(8, 145, 178, 0.26)" />
                  <stop offset="72%" stopColor="rgba(8, 145, 178, 0.06)" />
                  <stop offset="100%" stopColor="rgba(8, 145, 178, 0)" />
                </linearGradient>
              </defs>
              {yTicks.map((tick) => (
                <line key={tick.value.toFixed(4)} className="chartGridLine" x1="0" x2="100" y1={tick.y} y2={tick.y} />
              ))}
              <path className="chartArea" d={`${pathData} L ${latestPoint.x.toFixed(2)} 92 L ${firstPoint.x.toFixed(2)} 92 Z`} fill={`url(#${gradientId})`} />
              <path className="chartLineShadow" d={pathData} />
              <path className="chartLine" d={pathData} />
            </svg>
            <span className="chartMarker first" style={{ left: `${firstPoint.x}%`, top: `${firstPoint.y}%` }} />
            <span className="chartMarker latest" style={{ left: `${latestPoint.x}%`, top: `${latestPoint.y}%` }} />
            {hoveredPoint && (
              <>
                <span className="chartHoverLine" style={{ left: `${hoveredPoint.x}%` }} />
                <span className="chartHoverMarker" style={{ left: `${hoveredPoint.x}%`, top: `${hoveredPoint.y}%` }} />
                <span className={`chartTooltip ${tooltipAlign}`} style={{ left: `${hoveredPoint.x}%`, top: `${hoveredPoint.y}%` }}>
                  <strong>{formatNumber(hoveredPoint.item.balance)}</strong>
                  <small>{formatShortTime(hoveredPoint.item.captured_at, '-')}</small>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="chartTimeline">
        <div className="chartTimelineScale">
          {xTicks.map((point, index) => (
            <span
              key={`${point.item.id}-${index}`}
              className={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : undefined}
              style={{ left: `${point.x}%` }}
            >
              {formatShortTime(point.item.captured_at, '-')}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TokenModelsModal({
  state,
  onClose
}: {
  state: {
    row: Record<string, unknown>;
    result?: TokenModelsResult;
    loading: boolean;
    error?: string;
  };
  onClose: () => void;
}) {
  const tokenName = state.result?.token_name || valuePreview(state.row.name ?? state.row.id);
  const models = state.result?.models || [];
  const sourceLabel = state.result?.source === 'token_limits' ? '令牌限制' : '上游模型接口';

  return (
    <div className="modalBackdrop">
      <div className="modal wideModal tokenModelsModal" role="dialog" aria-modal="true" aria-labelledby="token-models-title">
        <div className="modalHeader">
          <div>
            <span className="modalEyebrow">TOKEN MODELS</span>
            <h2 id="token-models-title">支持模型</h2>
            <p>{tokenName}</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        {state.loading && <LoadingState label="正在读取模型列表" />}
        {state.error && <div className="inlineNotice error">{state.error}</div>}
        {!state.loading && !state.error && (
          <div className="tokenModelsBody">
            <div className="tokenModelsMeta">
              <span>{sourceLabel}</span>
              <strong>{models.length ? `${models.length} 个模型` : '未返回模型'}</strong>
            </div>
            {models.length ? (
              <div className="modelChipGrid">
                {models.map((model) => (
                  <span className="modelChip" key={model} title={model}>
                    {model}
                  </span>
                ))}
              </div>
            ) : (
              <div className="emptyState">当前令牌未返回可展示的模型列表</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenTable({ overview, onTokensChanged }: { overview: Overview; onTokensChanged: (tokens: unknown[]) => void }) {
  const rows = asRows(overview.tokens);
  const columns = tokenColumns(rows);
  const leadingColumns = columns.slice(0, 4);
  const trailingColumns = columns.slice(4);
  const options = tokenGroupOptions(overview, rows);
  const ratios = groupRatioLookup(overview.groups);
  const [updatingTokenId, setUpdatingTokenId] = useState<number | null>(null);
  const [modelsState, setModelsState] = useState<{
    row: Record<string, unknown>;
    result?: TokenModelsResult;
    loading: boolean;
    error?: string;
  } | null>(null);
  const [message, setMessage] = useState<MessageState>(null);

  if (!rows.length) return <div className="emptyState">暂无令牌缓存</div>;

  async function changeGroup(row: Record<string, unknown>, nextValue: string) {
    const tokenId = tokenIdOf(row);
    if (!tokenId) return;
    setUpdatingTokenId(tokenId);
    setMessage(null);
    try {
      const payload = overview.channel.type === 'sub2api' ? { group_id: Number(nextValue) } : { group: nextValue };
      const result = await api.updateTokenGroup(overview.channel.id, tokenId, payload);
      onTokensChanged(result.tokens);
      setMessage({ tone: 'success', text: '令牌分组已更新' });
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setUpdatingTokenId(null);
    }
  }

  async function copyKey(value: unknown) {
    const text = valuePreview(value);
    if (!text || text === '-') return;
    setMessage(null);
    try {
      await copyText(text);
      setMessage({ tone: 'success', text: '密钥已复制到剪贴板' });
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message || '密钥复制失败' });
    }
  }

  async function showTokenModels(row: Record<string, unknown>) {
    const tokenId = tokenIdOf(row);
    if (!tokenId) return;
    setMessage(null);
    setModelsState({ row, loading: true });
    try {
      const result = await api.tokenModels(overview.channel.id, tokenId);
      setModelsState({ row, result, loading: false });
    } catch (err) {
      setModelsState({ row, loading: false, error: (err as Error).message || '模型列表读取失败' });
    }
  }

  function renderTokenCell(row: Record<string, unknown>, column: string) {
    const preview = valuePreview(row[column]);
    if (column === 'key') {
      return (
        <td key={column} title={preview}>
          <button type="button" className="copyKeyButton" onClick={() => void copyKey(row[column])}>
            <span>{displayValue(column, row[column])}</span>
            <Copy size={14} />
          </button>
        </td>
      );
    }
    return (
      <td key={column} title={preview}>
        {displayValue(column, row[column])}
      </td>
    );
  }

  return (
    <div className="tokenTableStack">
      {message && <div className={`inlineNotice ${message.tone}`}>{message.text}</div>}
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              {leadingColumns.map((column) => (
                <th key={column}>{columnLabel(column)}</th>
              ))}
              <th className="tokenGroupColumn">分组</th>
              <th className="tokenRatioColumn">倍率</th>
              <th className="tokenModelsColumn">模型</th>
              {trailingColumns.map((column) => (
                <th key={column}>{columnLabel(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const tokenId = tokenIdOf(row);
              const currentValue = currentTokenGroupValue(overview.channel.type, row);
              const disabled = !tokenId || !options.length || updatingTokenId === tokenId;
              const ratioLabel = tokenGroupRatioLabel(overview.channel.type, row, ratios);
              const displayedOptions = currentValue
                ? appendUniqueOption(options, { value: currentValue, label: currentValue })
                : options;
              return (
                <tr key={tokenId ?? index}>
                  {leadingColumns.map((column) => renderTokenCell(row, column))}
                  <td className="tokenGroupColumn">
                    <select
                      className="tokenGroupSelect"
                      value={currentValue}
                      disabled={disabled}
                      onChange={(event) => void changeGroup(row, event.target.value)}
                      aria-label="令牌分组"
                      title={displayedOptions.find((option) => option.value === currentValue)?.label || currentValue || '未设置'}
                    >
                      {overview.channel.type === 'sub2api' && !currentValue && <option value="">未设置</option>}
                      {displayedOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="tokenRatioColumn" title={ratioLabel}>
                    {ratioLabel}
                  </td>
                  <td className="tokenModelsColumn">
                    <button
                      type="button"
                      className="tokenModelButton"
                      disabled={!tokenId}
                      onClick={() => void showTokenModels(row)}
                      aria-label="查看支持模型"
                      title="查看支持模型"
                    >
                      <Search size={15} />
                    </button>
                  </td>
                  {trailingColumns.map((column) => renderTokenCell(row, column))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {modelsState && <TokenModelsModal state={modelsState} onClose={() => setModelsState(null)} />}
    </div>
  );
}

function OverviewPanel({ overview, onOverviewChanged }: { overview: Overview; onOverviewChanged: (overview: Overview) => void }) {
  const [message, setMessage] = useState<MessageState>(null);
  const snapshot = overview.latest_snapshot;
  const status = overview.channel.status;
  const isRecordOnly = overview.channel.type === 'other';
  const lastSync = formatTime(overview.channel.last_sync_at, '尚未同步');
  const activeSubscriptions = subscriptionRows(overview.subscriptions);
  const profile = overview.profile || {};
  const concurrency = typeof profile.concurrency === 'number' ? profile.concurrency : Number(profile.concurrency);
  const dataCount = {
    groups: asRows(overview.groups).length,
    tokens: asRows(overview.tokens).length,
    subscriptions: activeSubscriptions.length
  };
  const passwordText = overview.channel.password || '';

  async function copySnapshotValue(label: string, value: string | null | undefined) {
    if (!value) return;
    setMessage(null);
    try {
      await copyText(value);
      setMessage({ tone: 'success', text: `${label}已复制到剪贴板` });
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message || `${label}复制失败` });
    }
  }

  if (isRecordOnly) {
    return (
      <>
        <div className="metricGrid">
          <MetricCard label="渠道用途" value="记录" meta="不执行上游同步" icon={<Database size={18} />} tone="accent" />
          <MetricCard label="账号" value={overview.channel.username || '-'} meta={credentialLabel(overview.channel)} icon={<KeyRound size={18} />} />
          <MetricCard
            label="记录状态"
            value={statusCopy[status].label}
            meta={`更新时间 ${formatShortTime(overview.channel.updated_at, '-')}`}
            icon={<CheckCircle2 size={18} />}
            tone="success"
          />
        </div>

        <DataSection title="记录信息" description="其它渠道仅保存站点和账号，不支持同步、分组、令牌、余额查询或告警" icon={<Database size={17} />}>
          <div className="snapshotList">
            <div>
              <span>站点</span>
              <strong>{overview.channel.base_url}</strong>
            </div>
            <div>
              <span>账号</span>
              {overview.channel.username ? (
                <button type="button" className="snapshotCopyButton" onClick={() => void copySnapshotValue('账号', overview.channel.username)}>
                  <strong>{overview.channel.username}</strong>
                  <Copy size={13} />
                </button>
              ) : (
                <strong>-</strong>
              )}
            </div>
            <div>
              <span>密码</span>
              {passwordText ? (
                <button type="button" className="snapshotCopyButton" onClick={() => void copySnapshotValue('密码', passwordText)}>
                  <strong>{passwordText}</strong>
                  <Copy size={13} />
                </button>
              ) : (
                <strong>-</strong>
              )}
            </div>
            <div>
              <span>创建时间</span>
              <strong>{formatShortTime(overview.channel.created_at, '-')}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{formatShortTime(overview.channel.updated_at, '-')}</strong>
            </div>
          </div>
          {message && <div className={`inlineNotice ${message.tone}`}>{message.text}</div>}
        </DataSection>
      </>
    );
  }

  return (
    <>
      <div className="metricGrid">
        <MetricCard
          label="当前余额"
          value={formatNumber(snapshot?.balance)}
          meta={snapshot ? '' : '等待首次同步'}
          icon={<WalletCards size={18} />}
          tone="accent"
        />
        <MetricCard
          label="并发数"
          value={Number.isFinite(concurrency) ? formatNumber(concurrency) : '-'}
          meta=""
          icon={<Activity size={18} />}
        />
        <MetricCard
          label="渠道健康"
          value={statusCopy[status].label}
          meta={`最近同步 ${lastSync}`}
          icon={status === 'active' ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}
          tone={status === 'active' ? 'success' : status === 'syncing' ? 'warning' : 'error'}
        />
      </div>

      <div className="overviewGrid">
        <DataSection
          className="chartPanel wide"
          title="余额趋势"
          description={`最近 ${overview.history.slice(-30).length} 个快照`}
          icon={<Activity size={17} />}
        >
          <BalanceChart history={overview.history} />
        </DataSection>

        <DataSection className="snapshotPanel" title="同步状态" description="当前渠道的运行上下文" icon={<RefreshCw size={17} />}>
          <div className="snapshotList">
            <div>
              <span>状态</span>
              <strong>{statusCopy[status].caption}</strong>
            </div>
            <div>
              <span>账号</span>
              {overview.channel.username ? (
                <button type="button" className="snapshotCopyButton" onClick={() => void copySnapshotValue('账号', overview.channel.username)}>
                  <strong>{overview.channel.username}</strong>
                  <Copy size={13} />
                </button>
              ) : (
                <strong>-</strong>
              )}
            </div>
            <div>
              <span>密码</span>
              {passwordText ? (
                <button type="button" className="snapshotCopyButton" onClick={() => void copySnapshotValue('密码', passwordText)}>
                  <strong>{passwordText}</strong>
                  <Copy size={13} />
                </button>
              ) : (
                <strong>-</strong>
              )}
            </div>
            <div>
              <span>更新时间</span>
              <strong>{formatShortTime(overview.channel.updated_at, '-')}</strong>
            </div>
          </div>
          {message && <div className={`inlineNotice ${message.tone}`}>{message.text}</div>}
        </DataSection>
      </div>

      <DataSection title="账户资料" description="渠道返回的用户资料缓存" icon={<Database size={17} />}>
        <JsonTable data={overview.profile ? [overview.profile] : []} emptyText="暂无账户资料缓存" />
      </DataSection>

      <div className="overviewDetails">
        <DataSection title="分组" description="同步缓存" icon={<Database size={17} />} right={<span className="dataPill">{dataCount.groups} 项</span>}>
          <JsonTable data={overview.groups} emptyText="暂无分组缓存" className="groupCacheTable" />
        </DataSection>
        <DataSection title="令牌" description="同步缓存" icon={<KeyRound size={17} />} right={<span className="dataPill">{dataCount.tokens} 项</span>}>
          <TokenTable overview={overview} onTokensChanged={(tokens) => onOverviewChanged({ ...overview, tokens })} />
        </DataSection>
      </div>

      {overview.channel.type === 'sub2api' && (
        <DataSection
          title="当前订阅"
          description="sub2api 订阅缓存"
          icon={<Zap size={17} />}
          right={<span className="dataPill">{dataCount.subscriptions} 项</span>}
        >
          <JsonTable data={activeSubscriptions} emptyText="当前无订阅" />
        </DataSection>
      )}
    </>
  );
}

function AutomationPanel({ channel, onAlertsChanged }: { channel: Channel; onAlertsChanged: () => void | Promise<void> }) {
  const defaultType: TaskType = 'low_balance';
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [form, setForm] = useState({
    type: defaultType,
    threshold: '',
    interval_minutes: taskTimingDefaults[defaultType].interval_minutes,
    lookback_minutes: 60,
    cooldown_minutes: taskTimingDefaults[defaultType].cooldown_minutes,
    recipients: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const isBurnRate = form.type === 'burn_rate';
  const isGroupTask = isGroupTaskType(form.type);

  const load = () => {
    setLoading(true);
    setError('');
    void api
      .tasks(channel.id)
      .then(setTasks)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [channel.id]);

  function selectTaskType(type: TaskType) {
    setForm({ ...form, type, ...taskTimingDefaults[type] });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api.createTask(channel.id, {
        ...form,
        threshold: isGroupTask ? undefined : Number(form.threshold),
        recipients: form.recipients
      });
      setForm({ ...form, threshold: '', recipients: '' });
      setMessage('任务已创建');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(task: AutomationTask) {
    setError('');
    try {
      await api.updateTask(channel.id, task.id, { enabled: !task.enabled });
      load();
      await onAlertsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(task: AutomationTask) {
    setError('');
    try {
      await api.deleteTask(channel.id, task.id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="panelGrid">
      <form className="taskForm dataPanel" onSubmit={create}>
        <SectionHeader title="新建自动化" description="按余额、消耗速度或分组变化触发邮件告警" icon={<Clock3 size={17} />} />
        <div className="segmented taskTypePicker">
          <button type="button" className={form.type === 'low_balance' ? 'active' : ''} onClick={() => selectTaskType('low_balance')}>
            低余额
          </button>
          <button type="button" className={form.type === 'burn_rate' ? 'active' : ''} onClick={() => selectTaskType('burn_rate')}>
            消耗过快
          </button>
          <button type="button" className={form.type === 'group_added' ? 'active' : ''} onClick={() => selectTaskType('group_added')}>
            新增分组
          </button>
          <button type="button" className={form.type === 'group_removed' ? 'active' : ''} onClick={() => selectTaskType('group_removed')}>
            减少分组
          </button>
          <button
            type="button"
            className={form.type === 'group_ratio_changed' ? 'active' : ''}
            onClick={() => selectTaskType('group_ratio_changed')}
          >
            倍率变化
          </button>
        </div>
        {!isGroupTask && (
          <label>
            {isBurnRate ? '每小时消耗超过' : '余额低于或等于'}
            <input
              required
              type="number"
              step="0.0001"
              value={form.threshold}
              onChange={(event) => setForm({ ...form, threshold: event.target.value })}
              placeholder={isBurnRate ? '例如 50' : '例如 10'}
            />
          </label>
        )}
        <div className={`formGrid ${isBurnRate ? 'three' : ''}`}>
          <label>
            检查间隔
            <input
              type="number"
              min={1}
              value={form.interval_minutes}
              onChange={(event) => setForm({ ...form, interval_minutes: Number(event.target.value) })}
            />
          </label>
          {isBurnRate && (
            <label>
              统计窗口
              <input
                type="number"
                min={1}
                value={form.lookback_minutes}
                onChange={(event) => setForm({ ...form, lookback_minutes: Number(event.target.value) })}
              />
            </label>
          )}
          <label>
            冷却时间
            <input
              type="number"
              min={0}
              value={form.cooldown_minutes}
              onChange={(event) => setForm({ ...form, cooldown_minutes: Number(event.target.value) })}
            />
          </label>
        </div>
        <p className="fieldHint">
          {isGroupTask
            ? '创建任务时记录当前分组作为基线；之后每次检查会同步渠道分组，并和任务基线对比。没有分组缓存时，首次检查只建立基线。'
            : isBurnRate
              ? '按统计窗口内最早余额和最新余额计算消耗量，再折算成每小时消耗速度；充值或余额上涨不会触发。'
              : '只判断最新余额快照；统计窗口不参与低余额判断。'}
        </p>
        <label>
          收件人
          <textarea value={form.recipients} onChange={(event) => setForm({ ...form, recipients: event.target.value })} placeholder="留空使用全局默认收件人" />
        </label>
        <button className="primaryButton fullWidth" type="submit">
          <Plus size={16} />
          新建任务
        </button>
        {message && <div className="successBox">{message}</div>}
        {error && <div className="errorBox">{error}</div>}
      </form>

      <DataSection
        className="taskListPanel"
        title="任务列表"
        description={`${channel.name} 的自动化规则`}
        icon={<Bell size={17} />}
        right={<span className="dataPill">{tasks.length} 个任务</span>}
      >
        {loading && !tasks.length ? (
          <LoadingState label="正在加载任务" />
        ) : tasks.length ? (
          <div className="taskList">
            {tasks.map((task) => (
              <div className="taskItem" key={task.id}>
                <div className="taskSummary">
                  <span className={`taskType ${task.type}`}>{taskTypeCopy[task.type]}</span>
                  <strong>{taskSummary(task)}</strong>
                  <p>
                    每 {task.interval_minutes} 分钟检查
                    {task.type === 'burn_rate' ? ` · 窗口 ${task.lookback_minutes} 分钟` : ''} · 冷却 {task.cooldown_minutes} 分钟
                  </p>
                  <small>上次运行 {formatTime(task.last_run_at, '尚未运行')} · 上次告警 {formatTime(task.last_alert_at, '尚未告警')}</small>
                </div>
                <div className="taskActions">
                  <label className="switch" title={task.enabled ? '已启用' : '已停用'}>
                    <input type="checkbox" checked={task.enabled} onChange={() => toggle(task)} />
                    <span />
                  </label>
                  <button className="iconButton danger" onClick={() => remove(task)} aria-label="删除任务" type="button">
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel icon={<Clock3 size={24} />} title="暂无自动化任务" />
        )}
      </DataSection>
    </div>
  );
}

function AlertsPanel({ alerts }: { alerts: AlertEvent[] }) {
  if (!alerts.length) {
    return (
      <DataSection title="告警事件" description="当前渠道还没有触发记录" icon={<Bell size={17} />}>
        <EmptyPanel icon={<Bell size={24} />} title="暂无告警记录" />
      </DataSection>
    );
  }

  return (
    <DataSection title="告警事件" description="按时间倒序展示邮件投递和触发内容" icon={<Bell size={17} />} right={<span className="dataPill">{alerts.length} 条</span>}>
      <div className="tableWrap alertTable">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>内容</th>
              <th>邮件</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{formatTime(alert.created_at)}</td>
                <td>
                  <span className={`taskType ${alert.type}`}>{taskTypeCopy[alert.type]}</span>
                </td>
                <td title={alert.message}>{alert.message}</td>
                <td>
                  <span className={`emailState ${alert.email_sent ? 'ok' : alert.email_error ? 'error' : 'pending'}`}>
                    {alert.email_sent ? '已发送' : alert.email_error || '未发送'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DataSection>
  );
}

function BalanceQueryLogsPanel({ channel, refreshKey }: { channel: Channel; refreshKey: number }) {
  const [result, setResult] = useState<PaginatedResult<BalanceQueryLog> | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPage(1);
  }, [channel.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .balanceQueryLogs(channel.id, page)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id, page, refreshKey]);

  const totalPages = Math.max(1, result?.pages || 1);

  return (
    <DataSection
      title="余额查询记录"
      description="记录每次余额查询的成功结果和失败原因"
      icon={<ListChecks size={17} />}
      right={<span className="dataPill">{result ? `${result.total} 条` : '每页 10 条'}</span>}
    >
      {error && <div className="inlineNotice error">{error}</div>}
      {loading && !result ? (
        <LoadingState label="正在加载余额查询记录" />
      ) : result?.items.length ? (
        <>
          <div className="tableWrap balanceLogTable">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>状态</th>
                  <th>余额</th>
                  <th>已用余额</th>
                  <th>单位</th>
                  <th>结果</th>
                  <th>失败原因</th>
                  <th>原始返回</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.id}>
                    <td>{formatTime(item.created_at)}</td>
                    <td>
                      <span className={`queryStatus ${item.status}`}>{item.status === 'success' ? '成功' : '失败'}</span>
                    </td>
                    <td>{item.balance === null ? '-' : formatNumber(item.balance)}</td>
                    <td>{item.used_balance === null ? '-' : formatNumber(item.used_balance)}</td>
                    <td>{item.unit || '-'}</td>
                    <td title={item.message}>{item.message}</td>
                    <td className="balanceLogError" title={item.error || '-'}>
                      {item.error || '-'}
                    </td>
                    <td title={item.raw_json || '-'}>
                      {item.raw_json ? item.raw_json.slice(0, 120) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="paginationBar">
            <span>
              第 {result.page} / {totalPages} 页
            </span>
            <div className="paginationActions">
              <button className="ghostButton" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>
                上一页
              </button>
              <button
                className="ghostButton"
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={loading || page >= totalPages}
              >
                下一页
              </button>
            </div>
          </div>
        </>
      ) : (
        <EmptyPanel icon={<ListChecks size={24} />} title="暂无余额查询记录" />
      )}
    </DataSection>
  );
}

function HomeSwitcher({
  onSelect,
  onLogout,
  onEmailSettings
}: {
  onSelect: (module: Exclude<AppModule, 'home'>) => void;
  onLogout: () => void | Promise<void>;
  onEmailSettings: () => void;
}) {
  return (
    <main className="moduleShell">
      <header className="moduleHeader">
        <div>
          <span className="brandKicker">AI OPS</span>
          <h1>AI 管理台</h1>
          <p>选择要进入的管理模块。</p>
        </div>
        <div className="moduleActions">
          <button className="iconButton" onClick={onEmailSettings} aria-label="邮件设置">
            <Settings size={18} />
          </button>
          <button className="iconButton" onClick={onLogout} aria-label="退出登录">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="moduleGrid" aria-label="模块选择">
        <button className="moduleCard" type="button" onClick={() => onSelect('channels')}>
          <span className="moduleIcon">
            <Database size={24} />
          </span>
          <span className="moduleCardBody">
            <strong>渠道管理</strong>
            <span>管理上游 sub2api / new-api 渠道，查看余额、分组、令牌和渠道告警。</span>
          </span>
          <span className="moduleAction">进入模块</span>
        </button>
        <button className="moduleCard" type="button" onClick={() => onSelect('owned-sites')}>
          <span className="moduleIcon accent">
            <Server size={24} />
          </span>
          <span className="moduleCardBody">
            <strong>自有站点管理</strong>
            <span>接入自己的 sub2api 站点，查看分组和账号，并监控账号错误状态。</span>
          </span>
          <span className="moduleAction">进入模块</span>
        </button>
      </section>
    </main>
  );
}

function OwnedSiteModal({
  site,
  onClose,
  onSaved
}: {
  site: OwnedSite | null;
  onClose: () => void;
  onSaved: (site: OwnedSite) => void | Promise<void>;
}) {
  const [form, setForm] = useState({
    name: site?.name || '',
    base_url: site?.base_url || '',
    admin_api_key: ''
  });
  const [checkOnSave, setCheckOnSave] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        type: 'sub2api',
        check: site ? checkOnSave : undefined
      };
      const saved = site ? await api.updateOwnedSite(site.id, payload) : await api.createOwnedSite(payload);
      await onSaved(saved);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modalHeader">
          <div>
            <span className="modalEyebrow">{site ? 'OWNED SITE EDIT' : 'NEW OWNED SITE'}</span>
            <h2>{site ? '编辑自有站点' : '添加自有站点'}</h2>
            <p>当前仅支持 sub2api 站点，通过后台 Admin API Key 接入。</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <label>
          站点名称
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：主站" />
        </label>
        <label>
          Base URL
          <input
            required
            value={form.base_url}
            onChange={(event) => setForm({ ...form, base_url: event.target.value })}
            placeholder="https://sub2api.example.com"
          />
        </label>
        <label>
          Admin API Key
          <input
            required={!site}
            type="password"
            value={form.admin_api_key}
            onChange={(event) => setForm({ ...form, admin_api_key: event.target.value })}
            placeholder={site?.has_admin_api_key ? '已保存，留空保持不变' : 'x-api-key'}
          />
        </label>
        {site && (
          <label className="checkboxLabel">
            <input type="checkbox" checked={checkOnSave} onChange={(event) => setCheckOnSave(event.target.checked)} />
            保存后立即检查连接
          </label>
        )}
        {error && <div className="errorBox">{error}</div>}
        <div className="modalFooter">
          <button type="button" className="ghostButton" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primaryButton" disabled={saving}>
            {saving ? '保存中' : site ? '保存站点' : '添加站点'}
          </button>
        </div>
      </form>
    </div>
  );
}

function OwnedSiteOverview({
  site,
  onSiteChanged
}: {
  site: OwnedSite;
  onSiteChanged: (site: OwnedSite) => void | Promise<void>;
}) {
  const [stats, setStats] = useState<{ groups: number; accounts: number; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadStats() {
    setLoading(true);
    setError('');
    try {
      const [groups, accounts, errors] = await Promise.all([
        api.ownedSiteGroups(site.id),
        api.ownedSiteAccounts(site.id, { page: 1, page_size: 1 }),
        api.ownedSiteAccounts(site.id, { page: 1, page_size: 1, status: 'error' })
      ]);
      setStats({ groups: groups.length, accounts: accounts.total, errors: errors.total });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStats();
  }, [site.id]);

  async function check() {
    setChecking(true);
    setError('');
    setMessage('');
    try {
      const checked = await api.checkOwnedSite(site.id);
      await onSiteChanged(checked);
      setMessage('连接检查成功');
      await loadStats();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <div className="metricGrid">
        <MetricCard
          label="站点健康"
          value={statusCopy[site.status].label}
          meta={`最近检查 ${formatTime(site.last_check_at, '尚未检查')}`}
          icon={site.status === 'active' ? <CheckCircle2 size={18} /> : <ShieldAlert size={18} />}
          tone={site.status === 'active' ? 'success' : site.status === 'syncing' ? 'warning' : 'error'}
        />
        <MetricCard
          label="分组数量"
          value={loading && !stats ? '-' : stats?.groups ?? '-'}
          meta="实时读取自有站点后台"
          icon={<Users size={18} />}
          tone="accent"
        />
        <MetricCard
          label="账号状态"
          value={loading && !stats ? '-' : stats ? `${formatNumber(stats.errors)} / ${formatNumber(stats.accounts)}` : '-'}
          meta="错误账号 / 账号总数"
          icon={<AlertTriangle size={18} />}
          tone={stats?.errors ? 'error' : 'default'}
        />
      </div>

      <div className="overviewGrid">
        <DataSection title="连接状态" description="站点接入信息和最近检查结果" icon={<Server size={17} />}>
          <div className="snapshotList">
            <div>
              <span>站点</span>
              <strong>{site.name}</strong>
            </div>
            <div>
              <span>地址</span>
              <strong>{site.base_url}</strong>
            </div>
            <div>
              <span>凭据</span>
              <strong>{siteCredentialLabel(site)}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{formatShortTime(site.updated_at, '-')}</strong>
            </div>
          </div>
          {site.last_error && (
            <div className="inlineNotice error">
              <span>{site.last_error}</span>
            </div>
          )}
          {message && <div className="inlineNotice success">{message}</div>}
          {error && <div className="inlineNotice error">{error}</div>}
        </DataSection>

        <DataSection
          title="快速检查"
          description="立即调用 sub2api 后台接口验证 Admin API Key"
          icon={<RefreshCw size={17} />}
        >
          <button className="primaryButton fullWidth" onClick={check} disabled={checking} type="button">
            <RefreshCw size={16} className={checking ? 'spin' : ''} />
            {checking ? '检查中' : '检查连接'}
          </button>
          {loading && <LoadingState label="正在读取统计数据" />}
        </DataSection>
      </div>
    </>
  );
}

function OwnedSiteGroupsPanel({ site }: { site: OwnedSite }) {
  const [groups, setGroups] = useState<OwnedSiteGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    void api
      .ownedSiteGroups(site.id)
      .then(setGroups)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, [site.id]);

  return (
    <DataSection
      title="分组列表"
      description="实时读取自有 sub2api 站点分组"
      icon={<Users size={17} />}
      right={
        <button className="ghostButton" onClick={load} disabled={loading} type="button">
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          刷新
        </button>
      }
    >
      {error && <div className="inlineNotice error">{error}</div>}
      {loading && !groups.length ? (
        <LoadingState label="正在加载分组" />
      ) : (
        <JsonTable
          data={groups.map((group) => ({
            id: group.id,
            name: group.name,
            platform: group.platform,
            status: group.status
          }))}
          emptyText="暂无分组"
        />
      )}
    </DataSection>
  );
}

function OwnedSiteAccountsPanel({ site }: { site: OwnedSite }) {
  const [groups, setGroups] = useState<OwnedSiteGroup[]>([]);
  const [result, setResult] = useState<PaginatedResult<OwnedSiteAccount> | null>(null);
  const [filters, setFilters] = useState({
    search: '',
    group: '',
    status: '',
    page_size: 20,
    sort_by: 'updated_at',
    sort_order: 'desc'
  });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .ownedSiteGroups(site.id)
      .then((items) => {
        if (!cancelled) setGroups(items);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [site.id]);

  function updateFilter(key: keyof typeof filters, value: string | number) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }

  function loadAccounts() {
    setLoading(true);
    setError('');
    void api
      .ownedSiteAccounts(site.id, { ...filters, page })
      .then(setResult)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .ownedSiteAccounts(site.id, { ...filters, page })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [site.id, filters, page]);

  const totalPages = Math.max(1, result?.pages || 1);

  return (
    <DataSection
      title="账号列表"
      description="支持后端分页、搜索、分组和状态筛选"
      icon={<KeyRound size={17} />}
      right={<span className="dataPill">{result ? `${result.total} 个账号` : '实时分页'}</span>}
    >
      <div className="filterBar">
        <label>
          搜索
          <div className="inputWithIcon">
            <Search size={15} />
            <input value={filters.search} onChange={(event) => updateFilter('search', event.target.value)} placeholder="名称、ID 或关键字" />
          </div>
        </label>
        <label>
          分组
          <select value={filters.group} onChange={(event) => updateFilter('group', event.target.value)}>
            <option value="">全部分组</option>
            {groups.map((group) => (
              <option value={group.id} key={group.id}>
                {groupLabel(group)}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
            <option value="">全部状态</option>
            {['active', 'error', 'inactive', 'disabled', 'rate_limited', 'temp_unschedulable', 'unschedulable'].map((status) => (
              <option value={status} key={status}>
                {accountStatusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        <label>
          排序
          <select value={filters.sort_by} onChange={(event) => updateFilter('sort_by', event.target.value)}>
            <option value="updated_at">更新时间</option>
            <option value="name">名称</option>
            <option value="status">状态</option>
            <option value="platform">平台</option>
          </select>
        </label>
        <label>
          顺序
          <select value={filters.sort_order} onChange={(event) => updateFilter('sort_order', event.target.value)}>
            <option value="desc">倒序</option>
            <option value="asc">正序</option>
          </select>
        </label>
        <label>
          每页
          <select value={filters.page_size} onChange={(event) => updateFilter('page_size', Number(event.target.value))}>
            {[10, 20, 50, 100].map((size) => (
              <option value={size} key={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button className="ghostButton filterRefresh" onClick={loadAccounts} disabled={loading} type="button">
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          刷新
        </button>
      </div>

      {error && <div className="inlineNotice error">{error}</div>}
      {loading && !result ? (
        <LoadingState label="正在加载账号" />
      ) : result?.items.length ? (
        <>
          <div className="tableWrap ownedAccountTable">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>名称</th>
                  <th>平台</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>分组</th>
                  <th>可调度</th>
                  <th>错误信息</th>
                  <th>最近使用</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((account) => (
                  <tr key={account.id}>
                    <td title={account.id}>{account.id}</td>
                    <td title={account.name}>{account.name || '-'}</td>
                    <td>{account.platform || '-'}</td>
                    <td>{account.type || '-'}</td>
                    <td>
                      <AccountStatusBadge status={account.status} />
                    </td>
                    <td title={accountGroupLabel(account, groups)}>{accountGroupLabel(account, groups)}</td>
                    <td>{account.schedulable === null ? '-' : account.schedulable ? '可调度' : '不可调度'}</td>
                    <td title={account.error_message}>{account.error_message || '-'}</td>
                    <td>{formatShortTime(account.last_used_at, '-')}</td>
                    <td>{formatShortTime(account.updated_at, '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="paginationBar">
            <span>
              第 {result.page} / {totalPages} 页
            </span>
            <div className="paginationActions">
              <button className="ghostButton" type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={loading || page <= 1}>
                上一页
              </button>
              <button
                className="ghostButton"
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={loading || page >= totalPages}
              >
                下一页
              </button>
            </div>
          </div>
        </>
      ) : (
        <EmptyPanel icon={<KeyRound size={24} />} title="暂无账号" />
      )}
    </DataSection>
  );
}

function ownedTaskTargetLabel(task: OwnedSiteAutomationTask) {
  const id = task.target_type === 'account' ? task.target_account_id : task.target_group_id;
  const name = task.target_type === 'account' ? task.target_account_name : task.target_group_name;
  if (name && id && name !== id) return `${name}（${id}）`;
  return name || id || '-';
}

function OwnedSiteAutomationPanel({ site, onAlertsChanged }: { site: OwnedSite; onAlertsChanged: () => void | Promise<void> }) {
  const [tasks, setTasks] = useState<OwnedSiteAutomationTask[]>([]);
  const [groups, setGroups] = useState<OwnedSiteGroup[]>([]);
  const [targetType, setTargetType] = useState<OwnedSiteTaskTargetType>('account');
  const [form, setForm] = useState({
    account_id: '',
    group_id: '',
    interval_minutes: 1,
    cooldown_minutes: 30,
    recipients: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function load() {
    setLoading(true);
    setError('');
    void Promise.all([api.ownedSiteTasks(site.id), api.ownedSiteGroups(site.id)])
      .then(([nextTasks, nextGroups]) => {
        setTasks(nextTasks);
        setGroups(nextGroups);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, [site.id]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    const selectedGroup = groups.find((group) => group.id === form.group_id);
    try {
      await api.createOwnedSiteTask(site.id, {
        target_type: targetType,
        target_account_id: targetType === 'account' ? form.account_id.trim() : undefined,
        target_group_id: targetType === 'group' ? form.group_id : undefined,
        target_group_name: targetType === 'group' ? selectedGroup?.name || form.group_id : undefined,
        interval_minutes: Number(form.interval_minutes),
        cooldown_minutes: Number(form.cooldown_minutes),
        recipients: form.recipients
      });
      setForm({ ...form, account_id: '', recipients: '' });
      setMessage('任务已创建，首次运行只建立账号状态基线');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(task: OwnedSiteAutomationTask) {
    setError('');
    try {
      await api.updateOwnedSiteTask(site.id, task.id, { enabled: !task.enabled });
      load();
      await onAlertsChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(task: OwnedSiteAutomationTask) {
    const confirmed = window.confirm(`确定删除自有站点任务「${ownedTaskTargetLabel(task)}」吗？`);
    if (!confirmed) return;
    setError('');
    try {
      await api.deleteOwnedSiteTask(site.id, task.id);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="panelGrid">
      <form className="taskForm dataPanel" onSubmit={create}>
        <SectionHeader title="新建自动化" description="账号状态从非 error 变为 error 时发送邮件告警" icon={<Clock3 size={17} />} />
        <div className="segmented">
          <button type="button" className={targetType === 'account' ? 'active' : ''} onClick={() => setTargetType('account')}>
            指定账号
          </button>
          <button type="button" className={targetType === 'group' ? 'active' : ''} onClick={() => setTargetType('group')}>
            指定分组
          </button>
        </div>
        {targetType === 'account' ? (
          <label>
            账号 ID
            <input required value={form.account_id} onChange={(event) => setForm({ ...form, account_id: event.target.value })} placeholder="例如 123" />
          </label>
        ) : (
          <label>
            分组
            <select required value={form.group_id} onChange={(event) => setForm({ ...form, group_id: event.target.value })}>
              <option value="">选择分组</option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {groupLabel(group)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="formGrid">
          <label>
            检查间隔
            <input
              type="number"
              min={1}
              value={form.interval_minutes}
              onChange={(event) => setForm({ ...form, interval_minutes: Number(event.target.value) })}
            />
          </label>
          <label>
            冷却时间
            <input
              type="number"
              min={0}
              value={form.cooldown_minutes}
              onChange={(event) => setForm({ ...form, cooldown_minutes: Number(event.target.value) })}
            />
          </label>
        </div>
        <p className="fieldHint">首次运行会保存账号状态基线，不会发送告警；只有后续从非 error 变为 error 时才触发。</p>
        <label>
          收件人
          <textarea value={form.recipients} onChange={(event) => setForm({ ...form, recipients: event.target.value })} placeholder="留空使用全局默认收件人" />
        </label>
        <button className="primaryButton fullWidth" type="submit">
          <Plus size={16} />
          新建任务
        </button>
        {message && <div className="successBox">{message}</div>}
        {error && <div className="errorBox">{error}</div>}
      </form>

      <DataSection
        className="taskListPanel"
        title="任务列表"
        description={`${site.name} 的账号错误监控规则`}
        icon={<Bell size={17} />}
        right={<span className="dataPill">{tasks.length} 个任务</span>}
      >
        {loading && !tasks.length ? (
          <LoadingState label="正在加载任务" />
        ) : tasks.length ? (
          <div className="taskList">
            {tasks.map((task) => (
              <div className="taskItem" key={task.id}>
                <div className="taskSummary">
                  <span className="taskType account_error">账号错误</span>
                  <strong>{ownedTaskTargetLabel(task)}</strong>
                  <p>
                    {ownedTaskTargetCopy[task.target_type]} · 每 {task.interval_minutes} 分钟检查 · 冷却 {task.cooldown_minutes} 分钟
                  </p>
                  <small>上次运行 {formatTime(task.last_run_at, '尚未运行')} · 上次告警 {formatTime(task.last_alert_at, '尚未告警')}</small>
                </div>
                <div className="taskActions">
                  <label className="switch" title={task.enabled ? '已启用' : '已停用'}>
                    <input type="checkbox" checked={task.enabled} onChange={() => toggle(task)} />
                    <span />
                  </label>
                  <button className="iconButton danger" onClick={() => remove(task)} aria-label="删除任务" type="button">
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyPanel icon={<Clock3 size={24} />} title="暂无自动化任务" />
        )}
      </DataSection>
    </div>
  );
}

function OwnedSiteAlertsPanel({ site }: { site: OwnedSite }) {
  const [alerts, setAlerts] = useState<OwnedSiteAlertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    void api
      .ownedSiteAlerts(site.id)
      .then(setAlerts)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, [site.id]);

  return (
    <DataSection
      title="告警事件"
      description="账号错误状态变化记录和邮件投递结果"
      icon={<Bell size={17} />}
      right={
        <button className="ghostButton" onClick={load} disabled={loading} type="button">
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          刷新
        </button>
      }
    >
      {error && <div className="inlineNotice error">{error}</div>}
      {loading && !alerts.length ? (
        <LoadingState label="正在加载告警" />
      ) : alerts.length ? (
        <div className="tableWrap alertTable">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>目标</th>
                <th>账号</th>
                <th>变化</th>
                <th>内容</th>
                <th>邮件</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td>{formatTime(alert.created_at)}</td>
                  <td>{alert.target_type ? ownedTaskTargetCopy[alert.target_type] : '-'}</td>
                  <td title={alert.account_id || ''}>{alert.account_name || alert.account_id || '-'}</td>
                  <td>
                    {alert.before_status || '-'} → {alert.after_status || '-'}
                  </td>
                  <td title={alert.message}>{alert.message}</td>
                  <td>
                    <span className={`emailState ${alert.email_sent ? 'ok' : alert.email_error ? 'error' : 'pending'}`}>
                      {alert.email_sent ? '已发送' : alert.email_error || '未发送'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyPanel icon={<Bell size={24} />} title="暂无告警记录" />
      )}
    </DataSection>
  );
}

function OwnedSiteManagerView({
  route,
  onNavigate,
  onBack,
  onLogout,
  onEmailSettings
}: {
  route: OwnedSiteRoute;
  onNavigate: (route: AppRoute, mode?: NavigationMode) => void;
  onBack: () => void;
  onLogout: () => void | Promise<void>;
  onEmailSettings: () => void;
}) {
  const [sites, setSites] = useState<OwnedSite[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(route.siteId ?? null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<OwnedSiteTabKey>(route.tab);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [siteModal, setSiteModal] = useState<OwnedSite | null | 'new'>(null);

  const selected = sites.find((site) => site.id === selectedId) || null;
  const filtered = useMemo(
    () => sites.filter((site) => `${site.name} ${site.base_url}`.toLowerCase().includes(query.toLowerCase())),
    [sites, query]
  );
  const siteStats = useMemo(
    () => ({
      active: sites.filter((site) => site.status === 'active').length,
      syncing: sites.filter((site) => site.status === 'syncing').length,
      error: sites.filter((site) => site.status === 'error').length
    }),
    [sites]
  );

  async function loadSites(nextSelectedId?: number) {
    const list = await api.ownedSites();
    setSites(list);
    const nextId =
      nextSelectedId && list.some((site) => site.id === nextSelectedId)
        ? nextSelectedId
        : route.siteId && list.some((site) => site.id === route.siteId)
          ? route.siteId
        : selectedId && list.some((site) => site.id === selectedId)
          ? selectedId
          : list[0]?.id || null;
    setSelectedId(nextId);
    if (nextId) {
      const nextTab = nextSelectedId ? 'overview' : tab;
      onNavigate({ module: 'owned-sites', siteId: nextId, tab: nextTab }, 'replace');
    } else {
      onNavigate({ module: 'owned-sites', tab: 'overview' }, 'replace');
    }
  }

  useEffect(() => {
    setLoading(true);
    setError('');
    void loadSites()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSelectedId(route.siteId ?? null);
    setTab(route.tab);
  }, [route.siteId, route.tab]);

  useEffect(() => {
    setMessage('');
    setError('');
  }, [selectedId]);

  async function checkSelected() {
    if (!selected) return;
    setChecking(true);
    setMessage('');
    setError('');
    try {
      const checked = await api.checkOwnedSite(selected.id);
      await loadSites(checked.id);
      setMessage('连接检查成功');
    } catch (err) {
      setError((err as Error).message);
      await loadSites(selected.id).catch(() => undefined);
    } finally {
      setChecking(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    const confirmed = window.confirm(`确定删除自有站点「${selected.name}」吗？相关任务、快照和告警记录也会被删除。`);
    if (!confirmed) return;
    setLoading(true);
    setError('');
    try {
      await api.deleteOwnedSite(selected.id);
      const list = await api.ownedSites();
      setSites(list);
      const nextId = list[0]?.id || null;
      setSelectedId(nextId);
      setTab('overview');
      onNavigate(nextId ? { module: 'owned-sites', siteId: nextId, tab: 'overview' } : { module: 'owned-sites', tab: 'overview' }, 'replace');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const tabs: Array<{ key: OwnedSiteTabKey; label: string; icon: ReactNode }> = [
    { key: 'overview', label: '概览', icon: <Activity size={16} /> },
    { key: 'groups', label: '分组', icon: <Users size={16} /> },
    { key: 'accounts', label: '账号', icon: <KeyRound size={16} /> },
    { key: 'automation', label: '自动化', icon: <Clock3 size={16} /> },
    { key: 'alerts', label: '告警', icon: <Bell size={16} /> }
  ];

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandRow">
          <div>
            <span className="brandKicker">OWNED SITES</span>
            <h1>自有站点管理</h1>
            <p>{sites.length} 个自有站点接入</p>
          </div>
          <div className="brandActions">
            <button className="iconButton" onClick={onBack} aria-label="返回首页">
              <Home size={18} />
            </button>
            <button className="iconButton" onClick={onEmailSettings} aria-label="邮件设置">
              <Settings size={18} />
            </button>
            <button className="iconButton" onClick={onLogout} aria-label="退出登录">
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="railStats" aria-label="自有站点状态概览">
          <div>
            <strong>{siteStats.active}</strong>
            <span>正常</span>
          </div>
          <div>
            <strong>{siteStats.syncing}</strong>
            <span>同步中</span>
          </div>
          <div>
            <strong>{siteStats.error}</strong>
            <span>异常</span>
          </div>
        </div>

        <div className="searchBox">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索站点名称或 URL" />
        </div>
        <button className="addButton" onClick={() => setSiteModal('new')}>
          <Plus size={17} />
          添加站点
        </button>

        <div className="channelList">
          {filtered.map((site) => (
            <button
              key={site.id}
              className={`channelItem ${site.id === selectedId ? 'selected' : ''}`}
              onClick={() => onNavigate({ module: 'owned-sites', siteId: site.id, tab })}
            >
              <span className={`channelRailMark ${site.status}`} />
              <span className="channelMain">
                <span className="channelTitleRow">
                  <strong>{site.name}</strong>
                  <TypeBadge type={site.type} />
                </span>
                <small className="channelUrl">{site.base_url}</small>
                <span className="channelMeta">
                  <span>
                    <Clock3 size={12} />
                    {formatShortTime(site.last_check_at, '尚未检查')}
                  </span>
                  <span>
                    <KeyRound size={12} />
                    {siteCredentialLabel(site)}
                  </span>
                </span>
              </span>
              <StatusBadge status={site.status} />
            </button>
          ))}
          {!filtered.length && <EmptyPanel icon={<Server size={24} />} title={sites.length ? '没有匹配的站点' : '暂无自有站点'} />}
        </div>
      </aside>

      <main className="mainArea">
        {selected ? (
          <>
            <header className="topBar">
              <div className="channelHero">
                <div className="titleLine">
                  <h2>{selected.name}</h2>
                  <TypeBadge type={selected.type} />
                  <StatusBadge status={selected.status} />
                </div>
                <p>{selected.base_url}</p>
                <div className="heroMeta">
                  <span>
                    <Clock3 size={14} />
                    最近检查 {formatTime(selected.last_check_at, '尚未检查')}
                  </span>
                  <span>
                    <KeyRound size={14} />
                    {siteCredentialLabel(selected)}
                  </span>
                </div>
              </div>
              <div className="toolbar">
                <button className="ghostButton" onClick={() => setSiteModal(selected)}>
                  <Pencil size={16} />
                  编辑
                </button>
                <button className="ghostButton" onClick={checkSelected} disabled={checking}>
                  <RefreshCw size={16} className={checking ? 'spin' : ''} />
                  检查
                </button>
                <button className="ghostButton dangerText" onClick={deleteSelected} disabled={loading}>
                  <Trash2 size={16} />
                  删除
                </button>
              </div>
            </header>

            {message && <div className="successBox">{message}</div>}
            {error && (
              <div className="errorBox">
                <AlertTriangle size={17} />
                {error}
              </div>
            )}
            {selected.last_error && (
              <div className="warnBox">
                <AlertTriangle size={17} />
                <span>最近检查发现异常：{selected.last_error}</span>
              </div>
            )}

            <nav className="tabs">
              {tabs.map((item) => (
                <button
                  key={item.key}
                  className={tab === item.key ? 'active' : ''}
                  onClick={() => {
                    if (selectedId) onNavigate({ module: 'owned-sites', siteId: selectedId, tab: item.key });
                    else onNavigate({ module: 'owned-sites', tab: item.key });
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </nav>

            <section className="content">
              {tab === 'overview' && <OwnedSiteOverview site={selected} onSiteChanged={(site) => loadSites(site.id)} />}
              {tab === 'groups' && <OwnedSiteGroupsPanel site={selected} />}
              {tab === 'accounts' && <OwnedSiteAccountsPanel site={selected} />}
              {tab === 'automation' && (
                <OwnedSiteAutomationPanel
                  site={selected}
                  onAlertsChanged={() => {
                    if (selectedId) return api.ownedSiteAlerts(selectedId);
                    return undefined;
                  }}
                />
              )}
              {tab === 'alerts' && <OwnedSiteAlertsPanel site={selected} />}
            </section>
          </>
        ) : (
          <div className="blank">
            <Server size={42} />
            <h2>暂无自有站点</h2>
            <p>添加第一个 sub2api 自有站点后，可以查看站点分组、账号分页列表，并配置账号错误状态告警。</p>
            <button className="primaryButton" onClick={() => setSiteModal('new')}>
              <Plus size={16} />
              添加站点
            </button>
          </div>
        )}
      </main>

      {siteModal && (
        <OwnedSiteModal
          site={siteModal === 'new' ? null : siteModal}
          onClose={() => setSiteModal(null)}
          onSaved={(site) => loadSites(site.id)}
        />
      )}
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [route, setRoute] = useState<AppRoute>(() => readCurrentRoute());
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(route.module === 'channels' ? route.channelId ?? null : null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TabKey>(route.module === 'channels' ? route.tab : 'overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [balanceLogsRefreshKey, setBalanceLogsRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [channelModal, setChannelModal] = useState<Channel | null | 'new'>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const selected = channels.find((channel) => channel.id === selectedId) || null;
  const selectedIsRecordOnly = selected?.type === 'other';
  const filtered = useMemo(
    () => channels.filter((channel) => `${channel.name} ${channel.base_url} ${channel.username || ''}`.toLowerCase().includes(query.toLowerCase())),
    [channels, query]
  );
  const channelStats = useMemo(
    () => ({
      active: channels.filter((channel) => channel.status === 'active').length,
      syncing: channels.filter((channel) => channel.status === 'syncing').length,
      error: channels.filter((channel) => channel.status === 'error').length
    }),
    [channels]
  );

  const navigate = useCallback((nextRoute: AppRoute, mode: NavigationMode = 'push') => {
    const normalized = normalizeRoute(nextRoute);
    const nextPath = buildAppPath(normalized);
    if (typeof window !== 'undefined') {
      const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (currentPath !== nextPath) {
        if (mode === 'replace') window.history.replaceState(null, '', nextPath);
        else window.history.pushState(null, '', nextPath);
      }
    }
    setRoute(normalized);
  }, []);

  async function loadChannels(nextSelectedId?: number) {
    const list = await api.channels();
    setChannels(list);
    const desiredId = route.module === 'channels' ? route.channelId : undefined;
    const nextId =
      nextSelectedId && list.some((channel) => channel.id === nextSelectedId)
        ? nextSelectedId
        : desiredId && list.some((channel) => channel.id === desiredId)
          ? desiredId
          : selectedId && list.some((channel) => channel.id === selectedId)
            ? selectedId
            : list[0]?.id || null;
    setSelectedId(nextId);
    if (route.module === 'channels') {
      const nextTab = nextSelectedId ? 'overview' : route.tab;
      navigate(nextId ? { module: 'channels', channelId: nextId, tab: nextTab } : { module: 'channels', tab: 'overview' }, 'replace');
    } else if (nextSelectedId) {
      navigate({ module: 'channels', channelId: nextSelectedId, tab: 'overview' });
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthState('anonymous');
      setChannels([]);
      setSelectedId(null);
      setOverview(null);
      setAlerts([]);
    });
    const handlePopState = () => setRoute(readCurrentRoute());
    window.addEventListener('popstate', handlePopState);
    api
      .authStatus()
      .then((status) => {
        if (status.authenticated) {
          setAuthState('authenticated');
          return loadChannels();
        }
        setAuthState('anonymous');
        return undefined;
      })
      .catch((err) => {
        setAuthState('anonymous');
        setError((err as Error).message);
      });
    return () => {
      setUnauthorizedHandler(null);
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (route.module !== 'channels') return;
    setSelectedId(route.channelId ?? null);
    setTab(route.tab);
  }, [route]);

  useEffect(() => {
    if (authState !== 'authenticated' || route.module !== 'channels') return;
    if (route.channelId && channels.some((channel) => channel.id === route.channelId)) return;
    const nextId = channels[0]?.id || null;
    setSelectedId(nextId);
    navigate(nextId ? { module: 'channels', channelId: nextId, tab: route.tab } : { module: 'channels', tab: 'overview' }, 'replace');
  }, [authState, channels, navigate, route]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (!selectedId) {
      setOverview(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setOverview(null);
    api
      .overview(selectedId)
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authState, selectedId]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    if (!selectedId) {
      setAlerts([]);
      return;
    }
    if (tab !== 'alerts') return;
    let cancelled = false;
    setError('');
    api
      .alerts(selectedId)
      .then((data) => {
        if (!cancelled) setAlerts(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [authState, selectedId, tab]);

  async function afterLogin() {
    setAuthState('authenticated');
    setError('');
    await loadChannels();
  }

  async function logout() {
    await api.logout().catch(() => undefined);
    setAuthState('anonymous');
    navigate({ module: 'home' }, 'replace');
    setChannels([]);
    setSelectedId(null);
    setOverview(null);
    setAlerts([]);
    setError('');
  }

  async function syncSelected() {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    try {
      await api.syncChannel(selectedId);
      await loadChannels(selectedId);
      setOverview(await api.overview(selectedId));
      if (tab === 'alerts') setAlerts(await api.alerts(selectedId));
      setBalanceLogsRefreshKey((value) => value + 1);
    } catch (err) {
      setError((err as Error).message);
      await loadChannels(selectedId).catch(() => undefined);
      setBalanceLogsRefreshKey((value) => value + 1);
    } finally {
      setLoading(false);
    }
  }

  function openUpstreamLogin(channel: Channel) {
    window.open(api.upstreamLoginUrl(channel.id), '_blank', 'noopener,noreferrer');
  }

  async function deleteSelected() {
    if (!selected) return;
    const confirmed = window.confirm(`确定删除渠道「${selected.name}」吗？相关缓存和自动化配置也会被删除。`);
    if (!confirmed) return;
    setLoading(true);
    setError('');
    try {
      await api.deleteChannel(selected.id);
      const list = await api.channels();
      setChannels(list);
      const nextId = list[0]?.id || null;
      setSelectedId(nextId);
      setTab('overview');
      navigate(nextId ? { module: 'channels', channelId: nextId, tab: 'overview' } : { module: 'channels', tab: 'overview' }, 'replace');
      setOverview(null);
      setAlerts([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const tabs: Array<{ key: TabKey; label: string; icon: ReactNode }> = [
    { key: 'overview', label: '概览', icon: <CircleDollarSign size={16} /> },
    { key: 'automation', label: '自动化', icon: <Clock3 size={16} /> },
    { key: 'balance-logs', label: '余额查询', icon: <ListChecks size={16} /> },
    { key: 'alerts', label: '告警', icon: <Bell size={16} /> }
  ];
  const visibleTabs = selectedIsRecordOnly ? tabs.filter((item) => item.key === 'overview') : tabs;

  useEffect(() => {
    if (selectedIsRecordOnly && tab !== 'overview') {
      if (selectedId) navigate({ module: 'channels', channelId: selectedId, tab: 'overview' }, 'replace');
      else navigate({ module: 'channels', tab: 'overview' }, 'replace');
    }
  }, [navigate, selectedId, selectedIsRecordOnly, tab]);

  if (authState === 'checking') {
    return (
      <main className="loginShell">
        <LoadingState label="正在检查登录状态" />
      </main>
    );
  }

  if (authState === 'anonymous') return <LoginScreen onAuthenticated={afterLogin} />;

  if (route.module === 'home') {
    return (
      <>
        <HomeSwitcher
          onSelect={(module) => navigate(module === 'channels' ? { module: 'channels', tab: 'overview' } : { module: 'owned-sites', tab: 'overview' })}
          onLogout={logout}
          onEmailSettings={() => setEmailOpen(true)}
        />
        {emailOpen && <EmailModal onClose={() => setEmailOpen(false)} />}
      </>
    );
  }

  if (route.module === 'owned-sites') {
    return (
      <>
        <OwnedSiteManagerView
          route={route}
          onNavigate={navigate}
          onBack={() => navigate({ module: 'home' })}
          onLogout={logout}
          onEmailSettings={() => setEmailOpen(true)}
        />
        {emailOpen && <EmailModal onClose={() => setEmailOpen(false)} />}
      </>
    );
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandRow">
          <div>
            <span className="brandKicker">AI OPS</span>
            <h1>AI 渠道管理台</h1>
            <p>{channels.length} 个渠道接入</p>
          </div>
          <div className="brandActions">
            <button className="iconButton" onClick={() => navigate({ module: 'home' })} aria-label="返回首页">
              <ArrowLeft size={18} />
            </button>
            <button className="iconButton" onClick={() => setEmailOpen(true)} aria-label="邮件设置">
              <Settings size={18} />
            </button>
            <button className="iconButton" onClick={logout} aria-label="退出登录">
              <LogOut size={18} />
            </button>
          </div>
        </div>

        <div className="railStats" aria-label="渠道状态概览">
          <div>
            <strong>{channelStats.active}</strong>
            <span>正常</span>
          </div>
          <div>
            <strong>{channelStats.syncing}</strong>
            <span>同步中</span>
          </div>
          <div>
            <strong>{channelStats.error}</strong>
            <span>异常</span>
          </div>
        </div>

        <div className="searchBox">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、URL 或账号" />
        </div>
        <button className="addButton" onClick={() => setChannelModal('new')}>
          <Plus size={17} />
          添加渠道
        </button>

        <div className="channelList">
          {filtered.map((channel) => (
            <button
              key={channel.id}
              className={`channelItem ${channel.id === selectedId ? 'selected' : ''}`}
              onClick={() => navigate({ module: 'channels', channelId: channel.id, tab })}
            >
              <span className={`channelRailMark ${channel.status}`} />
              <span className="channelMain">
                <span className="channelTitleRow">
                  <strong>{channel.name}</strong>
                  <TypeBadge type={channel.type} />
                </span>
                <small className="channelUrl">{channel.base_url}</small>
                <span className="channelMeta">
                  <span>
                    <Clock3 size={12} />
                    {formatShortTime(channel.last_sync_at)}
                  </span>
                  <span>
                    <KeyRound size={12} />
                    {credentialLabel(channel)}
                  </span>
                </span>
              </span>
              <StatusBadge status={channel.status} />
            </button>
          ))}
          {!filtered.length && <EmptyPanel icon={<Database size={24} />} title={channels.length ? '没有匹配的渠道' : '暂无渠道'} />}
        </div>
      </aside>

      <main className="mainArea">
        {selected ? (
          <>
            <header className="topBar">
              <div className="channelHero">
                <div className="titleLine">
                  <h2>{selected.name}</h2>
                  <TypeBadge type={selected.type} />
                  <StatusBadge status={selected.status} />
                </div>
                <p>{selected.base_url}</p>
                <div className="heroMeta">
                  <span>
                    <Clock3 size={14} />
                    最近同步 {formatTime(selected.last_sync_at, '尚未同步')}
                  </span>
                  <span>
                    <KeyRound size={14} />
                    {credentialLabel(selected)}
                  </span>
                  {selected.username && <span>账号 {selected.username}</span>}
                </div>
              </div>
              <div className="toolbar">
                {selected.type === 'sub2api' && (
                  <button className="ghostButton" onClick={() => openUpstreamLogin(selected)}>
                    <ExternalLink size={16} />
                    进入上游
                  </button>
                )}
                <button className="ghostButton" onClick={() => setChannelModal(selected)}>
                  <Pencil size={16} />
                  编辑
                </button>
                {!selectedIsRecordOnly && (
                  <button className="ghostButton" onClick={syncSelected} disabled={loading}>
                    <RefreshCw size={16} className={loading ? 'spin' : ''} />
                    同步
                  </button>
                )}
                <button className="ghostButton dangerText" onClick={deleteSelected} disabled={loading}>
                  <Trash2 size={16} />
                  删除
                </button>
              </div>
            </header>

            {error && (
              <div className="errorBox">
                <AlertTriangle size={17} />
                {error}
              </div>
            )}
            {selected.last_error && (
              <div className="warnBox">
                <AlertTriangle size={17} />
                <span>上次同步发现异常：{selected.last_error}</span>
              </div>
            )}

            <nav className="tabs">
              {visibleTabs.map((item) => (
                <button
                  key={item.key}
                  className={tab === item.key ? 'active' : ''}
                  onClick={() => {
                    if (selectedId) navigate({ module: 'channels', channelId: selectedId, tab: item.key });
                    else navigate({ module: 'channels', tab: item.key });
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </nav>

            <section className="content">
              {tab === 'overview' &&
                (loading && !overview ? (
                  <LoadingState />
                ) : overview ? (
                  <OverviewPanel overview={overview} onOverviewChanged={setOverview} />
                ) : (
                  <EmptyPanel icon={<Database size={24} />} title="暂无概览数据，先执行一次同步" />
                ))}
              {tab === 'automation' && !selectedIsRecordOnly && (
                <AutomationPanel
                  channel={selected}
                  onAlertsChanged={() => {
                    if (selectedId) return api.alerts(selectedId).then(setAlerts);
                    return undefined;
                  }}
                />
              )}
              {tab === 'balance-logs' && !selectedIsRecordOnly && <BalanceQueryLogsPanel channel={selected} refreshKey={balanceLogsRefreshKey} />}
              {tab === 'alerts' && !selectedIsRecordOnly && <AlertsPanel alerts={alerts} />}
            </section>
          </>
        ) : (
          <div className="blank">
            <Database size={42} />
            <h2>暂无渠道</h2>
            <p>添加第一个 sub2api 或 new-api 渠道后，管理台会开始展示余额、同步状态和告警任务。</p>
            <button className="primaryButton" onClick={() => setChannelModal('new')}>
              <Plus size={16} />
              添加渠道
            </button>
          </div>
        )}
      </main>

      {channelModal && (
        <ChannelModal
          channel={channelModal === 'new' ? null : channelModal}
          onClose={() => setChannelModal(null)}
          onSaved={(channel) => loadChannels(channel.id)}
        />
      )}
      {emailOpen && <EmailModal onClose={() => setEmailOpen(false)} />}
    </div>
  );
}
