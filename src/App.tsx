import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
  WalletCards,
  X,
  Zap
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from './api';
import type { AlertEvent, AutomationTask, Channel, ChannelType, EmailSettings, Overview, TaskType } from './types';

type TabKey = 'overview' | 'automation' | 'alerts';

type MessageState = {
  tone: 'success' | 'error';
  text: string;
} | null;

const emptyEmail: EmailSettings = {
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_from: '',
  default_recipients: [],
  default_interval_minutes: 30
};

const statusCopy: Record<Channel['status'], { label: string; caption: string }> = {
  active: { label: '正常', caption: '可用' },
  syncing: { label: '同步中', caption: '处理中' },
  error: { label: '异常', caption: '需处理' }
};

const taskTypeCopy: Record<TaskType, string> = {
  low_balance: '低余额',
  burn_rate: '消耗过快'
};

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

function valuePreview(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function credentialLabel(channel: Channel) {
  if (channel.type === 'sub2api') return channel.has_password ? '密码已保存' : '待配置密码';
  return channel.has_newapi_access_token ? '令牌已保存' : '待配置令牌';
}

function StatusBadge({ status }: { status: Channel['status'] }) {
  return <span className={`statusBadge ${status}`}>{statusCopy[status].label}</span>;
}

function TypeBadge({ type }: { type: ChannelType }) {
  return <span className={`typeBadge ${type}`}>{type === 'sub2api' ? 'sub2api' : 'new-api'}</span>;
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
    newapi_access_token: '',
    newapi_user_id: channel?.newapi_user_id || ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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
            <p>配置渠道认证后即可同步余额、账号资料和自动化告警。</p>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="segmented">
          <button type="button" className={type === 'sub2api' ? 'active' : ''} onClick={() => setType('sub2api')} disabled={Boolean(channel)}>
            sub2api
          </button>
          <button type="button" className={type === 'newapi' ? 'active' : ''} onClick={() => setType('newapi')} disabled={Boolean(channel)}>
            new-api
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
            <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </label>
          <label>
            密码
            <input
              type="text"
              required={!channel && type === 'sub2api'}
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
                type="password"
                required={!channel}
                value={form.newapi_access_token}
                onChange={(event) => setForm({ ...form, newapi_access_token: event.target.value })}
                placeholder={channel ? '留空保持不变' : ''}
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

function JsonTable({ data, emptyText = '暂无数据' }: { data: unknown; emptyText?: string }) {
  const rows = asRows(data);
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="emptyState">{emptyText}</div>;
  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} title={valuePreview(row[column])}>
                  {valuePreview(row[column])}
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
  const points = history.slice(-30);
  if (points.length < 2) return <div className="chartEmpty">暂无趋势</div>;
  const values = points.map((item) => item.balance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pathData = points
    .map((item, index) => {
      const x = (index / (points.length - 1)) * 100;
      const y = 88 - ((item.balance - min) / range) * 70;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <div className="chartFrame">
      <svg className="chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="余额趋势">
        {[20, 40, 60, 80].map((y) => (
          <line key={y} className="chartGridLine" x1="0" x2="100" y1={y} y2={y} />
        ))}
        <path className="chartArea" d={`${pathData} L 100 94 L 0 94 Z`} />
        <path className="chartLine" d={pathData} />
      </svg>
      <div className="chartLegend">
        <span>低点 {formatNumber(min)}</span>
        <span>高点 {formatNumber(max)}</span>
      </div>
    </div>
  );
}

function OverviewPanel({ overview }: { overview: Overview }) {
  const snapshot = overview.latest_snapshot;
  const status = overview.channel.status;
  const lastSync = formatTime(overview.channel.last_sync_at, '尚未同步');
  const dataCount = {
    groups: asRows(overview.groups).length,
    tokens: asRows(overview.tokens).length,
    subscriptions: asRows(overview.subscriptions).length
  };

  return (
    <>
      <div className="metricGrid">
        <MetricCard
          label="当前余额"
          value={formatNumber(snapshot?.balance)}
          meta={snapshot?.unit || '原始单位'}
          icon={<WalletCards size={18} />}
          tone="accent"
        />
        <MetricCard
          label="已用余额"
          value={formatNumber(snapshot?.used_balance)}
          meta={snapshot ? `采集于 ${formatShortTime(snapshot.captured_at, '-')}` : '等待首次同步'}
          icon={<CircleDollarSign size={18} />}
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
          right={<span className="dataPill">{snapshot?.unit || 'unit'}</span>}
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
              <strong>{overview.channel.username || '-'}</strong>
            </div>
            <div>
              <span>认证</span>
              <strong>{credentialLabel(overview.channel)}</strong>
            </div>
            <div>
              <span>更新时间</span>
              <strong>{formatShortTime(overview.channel.updated_at, '-')}</strong>
            </div>
          </div>
        </DataSection>
      </div>

      <DataSection title="账户资料" description="渠道返回的用户资料缓存" icon={<Database size={17} />}>
        <JsonTable data={overview.profile ? [overview.profile] : []} emptyText="暂无账户资料缓存" />
      </DataSection>

      <div className="overviewDetails">
        <DataSection title="分组" description="同步缓存" icon={<Database size={17} />} right={<span className="dataPill">{dataCount.groups} 项</span>}>
          <JsonTable data={overview.groups} emptyText="暂无分组缓存" />
        </DataSection>
        <DataSection title="令牌" description="同步缓存" icon={<KeyRound size={17} />} right={<span className="dataPill">{dataCount.tokens} 项</span>}>
          <JsonTable data={overview.tokens} emptyText="暂无令牌缓存" />
        </DataSection>
      </div>

      {overview.channel.type === 'sub2api' && (
        <DataSection
          title="当前订阅"
          description="sub2api 订阅缓存"
          icon={<Zap size={17} />}
          right={<span className="dataPill">{dataCount.subscriptions} 项</span>}
        >
          <JsonTable data={overview.subscriptions} emptyText="暂无订阅缓存" />
        </DataSection>
      )}
    </>
  );
}

function AutomationPanel({ channel, onAlertsChanged }: { channel: Channel; onAlertsChanged: () => void | Promise<void> }) {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [form, setForm] = useState({
    type: 'low_balance' as TaskType,
    threshold: '',
    interval_minutes: 30,
    lookback_minutes: 60,
    cooldown_minutes: 60,
    recipients: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const isBurnRate = form.type === 'burn_rate';

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

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await api.createTask(channel.id, {
        ...form,
        threshold: Number(form.threshold),
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
        <SectionHeader title="新建自动化" description="按余额阈值或消耗速度触发邮件告警" icon={<Clock3 size={17} />} />
        <div className="segmented">
          <button type="button" className={form.type === 'low_balance' ? 'active' : ''} onClick={() => setForm({ ...form, type: 'low_balance' })}>
            低余额
          </button>
          <button type="button" className={form.type === 'burn_rate' ? 'active' : ''} onClick={() => setForm({ ...form, type: 'burn_rate' })}>
            消耗过快
          </button>
        </div>
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
          {isBurnRate
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
                  <strong>
                    {task.type === 'low_balance'
                      ? `余额 <= ${formatNumber(task.threshold)}`
                      : `每小时消耗 >= ${formatNumber(task.threshold)}`}
                  </strong>
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

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [channelModal, setChannelModal] = useState<Channel | null | 'new'>(null);
  const [emailOpen, setEmailOpen] = useState(false);

  const selected = channels.find((channel) => channel.id === selectedId) || null;
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

  async function loadChannels(nextSelectedId?: number) {
    const list = await api.channels();
    setChannels(list);
    setSelectedId((current) => {
      if (nextSelectedId && list.some((channel) => channel.id === nextSelectedId)) return nextSelectedId;
      if (current && list.some((channel) => channel.id === current)) return current;
      return list[0]?.id || null;
    });
  }

  useEffect(() => {
    loadChannels().catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
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
  }, [selectedId]);

  useEffect(() => {
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
  }, [selectedId, tab]);

  async function syncSelected() {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    try {
      await api.syncChannel(selectedId);
      await loadChannels(selectedId);
      setOverview(await api.overview(selectedId));
      if (tab === 'alerts') setAlerts(await api.alerts(selectedId));
    } catch (err) {
      setError((err as Error).message);
      await loadChannels(selectedId).catch(() => undefined);
    } finally {
      setLoading(false);
    }
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
      setSelectedId(list[0]?.id || null);
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
    { key: 'alerts', label: '告警', icon: <Bell size={16} /> }
  ];

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandRow">
          <div>
            <span className="brandKicker">AI OPS</span>
            <h1>AI 渠道管理台</h1>
            <p>{channels.length} 个渠道接入</p>
          </div>
          <button className="iconButton" onClick={() => setEmailOpen(true)} aria-label="邮件设置">
            <Settings size={18} />
          </button>
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
            <button key={channel.id} className={`channelItem ${channel.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(channel.id)}>
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
                <button className="ghostButton" onClick={() => setChannelModal(selected)}>
                  <Pencil size={16} />
                  编辑
                </button>
                <button className="ghostButton" onClick={syncSelected} disabled={loading}>
                  <RefreshCw size={16} className={loading ? 'spin' : ''} />
                  同步
                </button>
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
              {tabs.map((item) => (
                <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>
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
                  <OverviewPanel overview={overview} />
                ) : (
                  <EmptyPanel icon={<Database size={24} />} title="暂无概览数据，先执行一次同步" />
                ))}
              {tab === 'automation' && (
                <AutomationPanel
                  channel={selected}
                  onAlertsChanged={() => {
                    if (selectedId) return api.alerts(selectedId).then(setAlerts);
                    return undefined;
                  }}
                />
              )}
              {tab === 'alerts' && <AlertsPanel alerts={alerts} />}
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
