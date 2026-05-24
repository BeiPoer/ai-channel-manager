import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Database,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { AlertEvent, AutomationTask, Channel, ChannelType, EmailSettings, Overview } from './types';

type TabKey = 'overview' | 'automation' | 'alerts';

const emptyEmail: EmailSettings = {
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_from: '',
  default_recipients: [],
  default_interval_minutes: 30
};

const formatTime = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '-');

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

function StatusBadge({ status }: { status: Channel['status'] }) {
  const className = status === 'active' ? 'badge ok' : status === 'syncing' ? 'badge pending' : 'badge error';
  const label = status === 'active' ? '正常' : status === 'syncing' ? '同步中' : '异常';
  return <span className={className}>{label}</span>;
}

function ChannelModal({
  channel,
  onClose,
  onSaved
}: {
  channel: Channel | null;
  onClose: () => void;
  onSaved: (channel: Channel) => void;
}) {
  const [type, setType] = useState<ChannelType>(channel?.type || 'sub2api');
  const [form, setForm] = useState({
    name: channel?.name || '',
    base_url: channel?.base_url || '',
    username: channel?.username || '',
    password: '',
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
      onSaved(saved);
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
          <h2>{channel ? '编辑渠道' : '添加渠道'}</h2>
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
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="可留空自动生成" />
        </label>
        <label>
          站点链接
          <input required value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} placeholder="https://example.com" />
        </label>
        <label>
          账号
          <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
        </label>
        <label>
          密码
          <input
            type="password"
            required={!channel && type === 'sub2api'}
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            placeholder={channel ? '留空保持不变' : ''}
          />
        </label>
        {type === 'newapi' && (
          <>
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
          </>
        )}
        {error && <div className="errorBox">{error}</div>}
        <div className="modalFooter">
          <button type="button" className="ghostButton" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="primaryButton" disabled={saving}>
            {saving ? '保存中' : '保存'}
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
  const [message, setMessage] = useState('');

  useEffect(() => {
    api.emailSettings().then(setSettings).catch((error) => setMessage((error as Error).message));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    try {
      const saved = await api.saveEmailSettings({ ...settings, smtp_password: password });
      setSettings(saved);
      setPassword('');
      setMessage('已保存');
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function test() {
    setMessage('');
    try {
      await api.testEmail(testRecipient);
      setMessage('测试邮件已发送');
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  return (
    <div className="modalBackdrop">
      <form className="modal wideModal" onSubmit={save}>
        <div className="modalHeader">
          <h2>邮件设置</h2>
          <button type="button" className="iconButton" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="formGrid">
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
          <label>
            SMTP 用户
            <input value={settings.smtp_user} onChange={(event) => setSettings({ ...settings, smtp_user: event.target.value })} />
          </label>
          <label>
            SMTP 密码
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={settings.has_smtp_password ? '已保存，留空保持不变' : ''} />
          </label>
          <label>
            发件人
            <input value={settings.smtp_from} onChange={(event) => setSettings({ ...settings, smtp_from: event.target.value })} />
          </label>
        </div>
        <label>
          默认收件人
          <textarea
            value={settings.default_recipients.join('\n')}
            onChange={(event) => setSettings({ ...settings, default_recipients: event.target.value.split(/\n|,|;/).filter(Boolean) })}
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
          <input value={testRecipient} onChange={(event) => setTestRecipient(event.target.value)} placeholder="测试收件人，留空使用默认收件人" />
          <button type="button" className="ghostButton" onClick={test}>
            发送测试
          </button>
        </div>
        {message && <div className={message.includes('已') ? 'successBox' : 'errorBox'}>{message}</div>}
        <div className="modalFooter">
          <button type="button" className="ghostButton" onClick={onClose}>
            关闭
          </button>
          <button type="submit" className="primaryButton">
            保存
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
                <td key={column}>{valuePreview(row[column])}</td>
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
      const y = 90 - ((item.balance - min) / range) * 70;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg className="chart" viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={pathData} />
    </svg>
  );
}

function AutomationPanel({ channel, onAlertsChanged }: { channel: Channel; onAlertsChanged: () => void }) {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [form, setForm] = useState({
    type: 'low_balance',
    threshold: '',
    interval_minutes: 30,
    lookback_minutes: 60,
    cooldown_minutes: 60,
    recipients: ''
  });
  const [error, setError] = useState('');
  const isBurnRate = form.type === 'burn_rate';

  const load = () => {
    void api
      .tasks(channel.id)
      .then(setTasks)
      .catch((err) => setError((err as Error).message));
  };
  useEffect(() => {
    load();
  }, [channel.id]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.createTask(channel.id, {
        ...form,
        threshold: Number(form.threshold),
        recipients: form.recipients
      });
      setForm({ ...form, threshold: '', recipients: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(task: AutomationTask) {
    await api.updateTask(channel.id, task.id, { enabled: !task.enabled });
    load();
    onAlertsChanged();
  }

  async function remove(task: AutomationTask) {
    await api.deleteTask(channel.id, task.id);
    load();
  }

  return (
    <div className="panelGrid">
      <form className="taskForm" onSubmit={create}>
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
            placeholder={isBurnRate ? '例如 50，表示每小时消耗超过 50 预警' : '例如 10，表示余额小于等于 10 预警'}
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
        <button className="primaryButton" type="submit">
          新建任务
        </button>
        {error && <div className="errorBox">{error}</div>}
      </form>
      <div className="taskList">
        {tasks.map((task) => (
          <div className="taskItem" key={task.id}>
            <div>
              <strong>{task.type === 'low_balance' ? '低余额' : '消耗过快'}</strong>
              <p>
                {task.type === 'low_balance'
                  ? `余额 <= ${task.threshold}`
                  : `每小时消耗 >= ${task.threshold} · 窗口 ${task.lookback_minutes} 分钟`}{' '}
                · 每 {task.interval_minutes} 分钟检查 · 冷却 {task.cooldown_minutes} 分钟
              </p>
            </div>
            <div className="taskActions">
              <label className="switch">
                <input type="checkbox" checked={task.enabled} onChange={() => toggle(task)} />
                <span />
              </label>
              <button className="iconButton danger" onClick={() => remove(task)} aria-label="删除任务">
                <Trash2 size={17} />
              </button>
            </div>
          </div>
        ))}
        {!tasks.length && <div className="emptyState">暂无自动化任务</div>}
      </div>
    </div>
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

  async function loadChannels(nextSelectedId?: number) {
    const list = await api.channels();
    setChannels(list);
    if (nextSelectedId) setSelectedId(nextSelectedId);
    else if (!selectedId && list[0]) setSelectedId(list[0].id);
  }

  useEffect(() => {
    loadChannels().catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    api
      .overview(selectedId)
      .then(setOverview)
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    setError('');
    if (tab === 'alerts') api.alerts(selectedId).then(setAlerts).catch((err) => setError((err as Error).message));
  }, [selectedId, tab]);

  async function syncSelected() {
    if (!selectedId) return;
    setLoading(true);
    setError('');
    try {
      await api.syncChannel(selectedId);
      await loadChannels(selectedId);
      setOverview(await api.overview(selectedId));
    } catch (err) {
      setError((err as Error).message);
      await loadChannels(selectedId).catch(() => undefined);
    } finally {
      setLoading(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    await api.deleteChannel(selected.id);
    const list = await api.channels();
    setChannels(list);
    setSelectedId(list[0]?.id || null);
  }

  const tabs: Array<{ key: TabKey; label: string; icon: JSX.Element; hidden?: boolean }> = [
    { key: 'overview', label: '概览', icon: <CircleDollarSign size={16} /> },
    { key: 'automation', label: '自动化', icon: <Clock3 size={16} /> },
    { key: 'alerts', label: '告警', icon: <Bell size={16} /> }
  ];

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brandRow">
          <div>
            <h1>AI 渠道管理台</h1>
            <p>{channels.length} 个渠道</p>
          </div>
          <button className="iconButton" onClick={() => setEmailOpen(true)} aria-label="邮件设置">
            <Settings size={18} />
          </button>
        </div>
        <div className="searchBox">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索渠道" />
        </div>
        <button className="addButton" onClick={() => setChannelModal('new')}>
          <Plus size={17} />
          添加渠道
        </button>
        <div className="channelList">
          {filtered.map((channel) => (
            <button key={channel.id} className={`channelItem ${channel.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(channel.id)}>
              <span className={`typeDot ${channel.type}`} />
              <span>
                <strong>{channel.name}</strong>
                <small>{channel.base_url}</small>
              </span>
              <StatusBadge status={channel.status} />
            </button>
          ))}
          {!filtered.length && <div className="emptyState">暂无渠道</div>}
        </div>
      </aside>

      <main className="mainArea">
        {selected ? (
          <>
            <header className="topBar">
              <div>
                <div className="titleLine">
                  <h2>{selected.name}</h2>
                  <span className={`typeBadge ${selected.type}`}>{selected.type}</span>
                  <StatusBadge status={selected.status} />
                </div>
                <p>{selected.base_url}</p>
              </div>
              <div className="toolbar">
                <button className="ghostButton" onClick={() => setChannelModal(selected)}>
                  <Settings size={16} />
                  编辑
                </button>
                <button className="ghostButton" onClick={syncSelected} disabled={loading}>
                  <RefreshCw size={16} className={loading ? 'spin' : ''} />
                  同步
                </button>
                <button className="ghostButton dangerText" onClick={deleteSelected}>
                  <Trash2 size={16} />
                  删除
                </button>
              </div>
            </header>

            {error && <div className="errorBox">{error}</div>}
            {selected.last_error && <div className="warnBox"><AlertTriangle size={17} />{selected.last_error}</div>}

            <nav className="tabs">
              {tabs
                .filter((item) => !item.hidden)
                .map((item) => (
                  <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>
                    {item.icon}
                    {item.label}
                  </button>
                ))}
            </nav>

            <section className="content">
              {tab === 'overview' && overview && (
                <>
                  <div className="metricGrid">
                    <div className="metric">
                      <span>余额</span>
                      <strong>{overview.latest_snapshot?.balance ?? '-'}</strong>
                      <small>{overview.latest_snapshot?.unit || '原始单位'}</small>
                    </div>
                    <div className="metric">
                      <span>已用</span>
                      <strong>{overview.latest_snapshot?.used_balance ?? '-'}</strong>
                      <small>最近同步</small>
                    </div>
                    <div className="metric">
                      <span>同步时间</span>
                      <strong>{formatTime(overview.channel.last_sync_at)}</strong>
                      <small>{overview.channel.status}</small>
                    </div>
                  </div>
                  <div className="chartPanel">
                    <div className="sectionHeader">
                      <h3>余额趋势</h3>
                      <CheckCircle2 size={18} />
                    </div>
                    <BalanceChart history={overview.history} />
                  </div>
                  <div className="sectionHeader">
                    <h3>账户资料</h3>
                  </div>
                  <JsonTable data={overview.profile ? [overview.profile] : []} />
                  <div className="overviewDetails">
                    <div>
                      <div className="sectionHeader">
                        <h3>分组</h3>
                      </div>
                      <JsonTable data={overview.groups} emptyText="暂无分组缓存" />
                    </div>
                    <div>
                      <div className="sectionHeader">
                        <h3>令牌</h3>
                      </div>
                      <JsonTable data={overview.tokens} emptyText="暂无令牌缓存" />
                    </div>
                  </div>
                  {selected.type === 'sub2api' && (
                    <>
                      <div className="sectionHeader">
                        <h3>当前订阅</h3>
                      </div>
                      <JsonTable data={overview.subscriptions} emptyText="暂无订阅缓存" />
                    </>
                  )}
                </>
              )}
              {tab === 'automation' && <AutomationPanel channel={selected} onAlertsChanged={() => api.alerts(selected.id).then(setAlerts)} />}
              {tab === 'alerts' && (
                <div className="tableWrap">
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
                          <td>{alert.type === 'low_balance' ? '低余额' : '消耗过快'}</td>
                          <td>{alert.message}</td>
                          <td>{alert.email_sent ? '已发送' : alert.email_error || '未发送'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!alerts.length && <div className="emptyState">暂无告警记录</div>}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="blank">
            <Database size={42} />
            <h2>暂无渠道</h2>
            <button className="primaryButton" onClick={() => setChannelModal('new')}>
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
