import {
  PATCH_WORTHY_DAEMON_EVENTS,
  activeCyclesFingerprint,
  buildDetailCacheFromData,
  channelPanelFingerprint,
  daemonBarFingerprint,
  detailCacheNeedsPatch,
  observabilityFingerprint,
} from './live-state.js';

const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const metaEl = document.getElementById('meta');
const filterEl = document.getElementById('filter');
const liveStatusEl = document.getElementById('live-status');
const subjectOverviewEl = document.getElementById('subject-overview');
const daemonBarEl = document.getElementById('daemon-bar');
const attentionPanelEl = document.getElementById('attention-panel');
const activeCyclesEl = document.getElementById('active-cycles');
const channelPanelEl = document.getElementById('channel-panel');
const eventFeedEl = document.getElementById('event-feed');

/** @type {{ subject: string, namespace: string, health?: string }[]} */
let subjectsList = [];
let defaultSubject = null;
let activeSubject = null;

/** @type {Record<string, object>} */
const manifestsBySubject = {};
/** @type {Record<string, object>} */
const daemonBySubject = {};
/** @type {Record<string, object[]>} */
const feedEventsBySubject = {};
/** @type {Record<string, Set<string>>} */
const seenCycleIdsBySubject = {};
/** @type {Record<string, Set<string>>} */
const newCycleIdsBySubject = {};
/** @type {Record<string, object|null>} */
const observabilityBySubject = {};
/** @type {Record<string, { bar: string, cycles: string, channel: string, attention: string }>} */
const panelFpBySubject = {};

let activeCycleId = null;
/** @type {'cycle'|'round'|null} */
let activeViewMode = null;
/** @type {ReturnType<typeof buildDetailCacheFromData>|null} */
let activeDetailCache = null;

let eventSource = null;
let reconnectDelayMs = 5000;
let reconnectTimer = null;
let daemonPollTimer = null;
let loadDaemonTimer = null;
let loadObservabilityTimer = null;
let patchDetailTimer = null;

const LOAD_DAEMON_DEBOUNCE_MS = 400;
const LOAD_OBSERVABILITY_DEBOUNCE_MS = 400;
const PATCH_DETAIL_DEBOUNCE_MS = 500;

const EVENT_LABELS = {
  worker_started: 'Worker 启动',
  worker_stopped: 'Worker 停止',
  worker_start_failed: 'Worker 启动失败',
  daemon_tick: '心跳 tick',
  cycle_due: '新 cycle',
  cycle_step_enqueued: '步骤入队',
  cycle_event_dispatched: '事件分发',
  cycle_step_completed: '步骤完成',
  cycle_reconciled: 'Reconcile',
  cycle_abandoned: 'Cycle 放弃',
  task_enqueued: '任务入队',
  task_claimed: '任务领取',
  task_completed: '任务完成',
  task_failed: '任务失败',
  task_lease_renewed: '租约续期',
  task_lease_renew_failed: '租约续期失败',
  stale_lease_reclaimed: '过期租约回收',
  evolution_mode_changed: '演化模式变更',
  cycle_start_requested: '开轮请求入队',
  cycle_start_consumed: '开轮请求已消费',
  cycle_start_deferred: '开轮请求暂缓',
};

const CHANNEL_EVENT_LABELS = {
  channel_worker_started: 'Channel Worker 启动',
  channel_worker_stop_requested: 'Channel Worker 停止请求',
  channel_tick: 'Channel tick',
  channel_task_enqueued: 'Channel 任务入队',
  channel_task_claimed: 'Channel 任务领取',
  channel_task_completed: 'Channel 任务完成',
  channel_inbound_completed: '入站轮询完成',
  channel_message_ingested: '消息已分类入库',
  channel_message_ingest_failed: '消息分类失败',
  channel_expression_recompute_requested: '表达重算请求',
  channel_expression_planned: '表达计划',
  channel_expression_noop: '表达无动作',
  channel_expression_silenced: '表达沉默',
  channel_presence_completed: 'Presence 完成',
  channel_presence_timeout: 'Presence 超时',
  channel_speech_generated: '话术已生成',
  channel_speech_generation_failed: '话术生成失败',
  channel_deprecated_tasks_purged: '废弃任务已清理',
  channel_message_sent: '消息已发送',
  channel_message_send_failed: '消息发送失败',
  channel_message_received: 'Channel 收到消息',
  feishu_listener_started: 'Feishu 监听启动',
  feishu_listener_stopped: 'Feishu 监听停止',
  feishu_listener_connected: 'Feishu 已连接',
  feishu_listener_disconnected: 'Feishu 已断开',
  feishu_listener_start_failed: 'Feishu 监听启动失败',
};

const EVOLUTION_MODE_LABELS = {
  continuous: '持续',
  on_demand: '按需',
};

const EVOLUTION_MODE_SOURCE_LABELS = {
  'subjects.json': 'subjects.json',
  cli: 'CLI 启动参数',
  env: '环境变量',
  default: '默认',
};

function isMultiSubject() {
  return subjectsList.length > 1;
}

function getManifest() {
  return activeSubject ? manifestsBySubject[activeSubject] ?? null : null;
}

function getDaemonState() {
  return activeSubject ? daemonBySubject[activeSubject] ?? null : null;
}

function getFeedEvents() {
  if (!activeSubject) return [];
  if (!feedEventsBySubject[activeSubject]) feedEventsBySubject[activeSubject] = [];
  return feedEventsBySubject[activeSubject];
}

function getSeenCycleIds() {
  if (!activeSubject) return new Set();
  if (!seenCycleIdsBySubject[activeSubject]) seenCycleIdsBySubject[activeSubject] = new Set();
  return seenCycleIdsBySubject[activeSubject];
}

function getNewCycleIds() {
  if (!activeSubject) return new Set();
  if (!newCycleIdsBySubject[activeSubject]) newCycleIdsBySubject[activeSubject] = new Set();
  return newCycleIdsBySubject[activeSubject];
}

function getObservability() {
  return activeSubject ? observabilityBySubject[activeSubject] ?? null : null;
}

function getPanelFp() {
  if (!activeSubject) return { bar: '', cycles: '', channel: '', attention: '' };
  if (!panelFpBySubject[activeSubject]) {
    panelFpBySubject[activeSubject] = { bar: '', cycles: '', channel: '', attention: '' };
  }
  return panelFpBySubject[activeSubject];
}

const ATTENTION_SEVERITY_LABELS = {
  critical: '严重',
  warning: '警告',
  info: '提示',
};

function subjectApiBase(subject) {
  return `/api/subjects/${encodeURIComponent(subject)}`;
}

function subjectFromQuery() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('subject')?.trim();
  return raw || null;
}

function setSubjectQuery(subject) {
  const params = new URLSearchParams(location.search);
  if (subject) params.set('subject', subject);
  else params.delete('subject');
  const qs = params.toString();
  const next = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (`${location.pathname}${location.search}${location.hash}` !== next) {
    history.replaceState(null, '', next);
  }
}

function cycleFromHash() {
  const raw = location.hash.replace(/^#/, '').trim();
  return raw || null;
}

function setHash(cycleId) {
  const next = cycleId ? `#${cycleId}` : '';
  if (location.hash !== next) location.hash = next;
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function formatTimeShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function updateMeta(extra = '') {
  const manifest = getManifest();
  if (!manifest) return;
  const parts = [
    manifest.subject,
    manifest.namespace,
    `共 ${manifest.round_count ?? manifest.rounds?.length ?? 0} 轮`,
    manifest.built_at ? `更新于 ${formatWhen(manifest.built_at)}` : '',
    isMultiSubject() ? `${subjectsList.length} 个 subject` : '',
    extra,
  ].filter(Boolean);
  metaEl.textContent = parts.join(' · ');
}

function setLiveStatus(text, state = '') {
  if (!liveStatusEl) return;
  liveStatusEl.textContent = text;
  liveStatusEl.className = `live-status${state ? ` ${state}` : ''}`;
}

function renderStepBadges(steps, { compact = false } = {}) {
  if (!steps || typeof steps !== 'object') return '';
  const order = [
    'intel', 'intel_report', 'exec', 'verify', 'belief_update',
    'goals_assess', 'goals_calibrate', 'diary',
  ];
  const labels = {
    intel: 'Intel',
    intel_report: 'Report',
    exec: 'Exec',
    verify: 'Verify',
    belief_update: 'Beliefs',
    goals_assess: 'Goals',
    goals_calibrate: 'Calibrate',
    diary: 'Diary',
  };
  const items = order
    .filter((name) => steps[name])
    .map((name) => {
      const raw = steps[name];
      const status = typeof raw === 'string' ? raw : (raw.status ?? 'pending');
      const label = labels[name] ?? name;
      const err = typeof raw === 'object' && raw?.error ? String(raw.error).slice(0, 80) : '';
      if (compact) {
        const sym = status === 'done' ? '✓' : status === 'running' ? '▶' : status === 'failed' ? '✗' : '·';
        const errHint = err ? ` — ${err}` : '';
        return `<span class="step-dot step-${status}" title="${label}: ${status}${errHint}">${sym}</span>`;
      }
      const errPart = err ? ` (${err})` : '';
      return `<span class="step-badge step-${status}" title="${name}">${label}: ${status}${errPart}</span>`;
    });
  if (!items.length) return '';
  const cls = compact ? 'step-dots' : 'step-badges';
  return `<div class="${cls}">${items.join('')}</div>`;
}

function formatEventLabel(ev) {
  const base = EVENT_LABELS[ev.event_type] ?? ev.event_type;
  if (ev.event_type === 'evolution_mode_changed' && ev.from && ev.to) {
    return `${base}: ${formatEvolutionMode(ev.from)} → ${formatEvolutionMode(ev.to)}`;
  }
  const parts = [base];
  if (ev.task_type || ev.step_type) parts.push(ev.task_type ?? ev.step_type);
  if (ev.cycle_id) parts.push(ev.cycle_id);
  return parts.join(' · ');
}

function formatChannelEventLabel(ev) {
  const type = ev.type ?? ev.event_type;
  const base = CHANNEL_EVENT_LABELS[type] ?? type ?? 'channel';
  const parts = [base];
  if (ev.task_type) parts.push(ev.task_type);
  if (ev.message_id) parts.push(ev.message_id);
  if (ev.ingest_kind) parts.push(ev.ingest_kind);
  if (ev.status && ev.status !== 'ok') parts.push(ev.status);
  return parts.join(' · ');
}

function renderEventFeed() {
  if (!eventFeedEl) return;
  const feedEvents = getFeedEvents();
  if (!feedEvents.length) {
    eventFeedEl.innerHTML = '<p class="feed-empty">暂无 daemon 事件</p>';
    return;
  }
  eventFeedEl.innerHTML = feedEvents.slice(0, 30).map((ev) => {
    const time = formatTimeShort(ev.recorded_at);
    return `<div class="feed-row"><span class="feed-time">${time}</span><span class="feed-label">${formatEventLabel(ev)}</span></div>`;
  }).join('');
}

function prependFeedEvent(ev, subject = activeSubject) {
  if (!ev?.event_type || !subject) return;
  if (!feedEventsBySubject[subject]) feedEventsBySubject[subject] = [];
  feedEventsBySubject[subject].unshift(ev);
  if (feedEventsBySubject[subject].length > 50) feedEventsBySubject[subject].length = 50;
  if (subject === activeSubject) renderEventFeed();
}

function formatEvolutionMode(mode) {
  return EVOLUTION_MODE_LABELS[mode] ?? mode ?? 'unknown';
}

function formatEvolutionModeSource(source) {
  return EVOLUTION_MODE_SOURCE_LABELS[source] ?? source ?? '';
}

function renderSubjectOverview() {
  if (!subjectOverviewEl) return;
  if (!isMultiSubject()) {
    subjectOverviewEl.classList.add('hidden');
    subjectOverviewEl.innerHTML = '';
    return;
  }
  subjectOverviewEl.classList.remove('hidden');
  subjectOverviewEl.innerHTML = subjectsList.map((summary) => {
    const healthClass = summary.health ?? 'unknown';
    const active = summary.subject === activeSubject ? ' active' : '';
    const daemon = daemonBySubject[summary.subject];
    const workerOn = daemon?.worker?.running ?? summary.worker_running;
    const openCycles = daemon?.cycles?.open_count ?? summary.open_cycles ?? 0;
    const pending = daemon?.tasks?.counts?.pending ?? summary.pending_tasks ?? 0;
    const running = daemon?.tasks?.counts?.running ?? summary.running_tasks ?? 0;
    const inPending = daemon?.channel?.inbound?.pending_count ?? summary.channel_inbound_pending ?? 0;
    const outPending = daemon?.channel?.outbox?.pending_count ?? summary.channel_outbox_pending ?? 0;
    const att = summary.attention
      ?? observabilityBySubject[summary.subject]?.attention?.summary
      ?? null;
    const attChip = att?.count > 0 && att.highest_severity
      ? `<span class="daemon-chip attention-${att.highest_severity}" title="${att.critical ?? 0} 严重 · ${att.warning ?? 0} 警告 · ${att.info ?? 0} 提示">关注 ${att.count}</span>`
      : '';
    return `
      <button type="button" class="daemon-card${active}" data-subject="${summary.subject}" aria-pressed="${summary.subject === activeSubject}">
        <span class="daemon-card-title">${summary.subject}</span>
        <span class="daemon-card-meta">${summary.namespace ?? ''}</span>
        <span class="daemon-card-stats">
          <span class="daemon-chip health-${healthClass}">${healthClass}</span>
          <span class="daemon-chip worker-${workerOn ? 'on' : 'off'}">${workerOn ? 'Worker 运行' : 'Worker 停'}</span>
          <span class="daemon-chip">open ${openCycles}</span>
          <span class="daemon-chip">${pending}/${running}</span>
          ${attChip}
          ${inPending || outPending ? `<span class="daemon-chip channel-attention">Ch ${inPending}/${outPending}</span>` : ''}
        </span>
      </button>
    `;
  }).join('');

  for (const btn of subjectOverviewEl.querySelectorAll('.daemon-card')) {
    btn.addEventListener('click', () => {
      const subject = btn.dataset.subject;
      if (subject && subject !== activeSubject) void setActiveSubject(subject, { preserveHash: true });
    });
  }
}

function renderDaemonBar() {
  if (!daemonBarEl) return;
  const daemonState = getDaemonState();
  if (!daemonState) {
    daemonBarEl.classList.add('hidden');
    return;
  }
  daemonBarEl.classList.remove('hidden');

  const worker = daemonState.worker ?? {};
  const health = daemonState.health ?? {};
  const counts = daemonState.tasks?.counts ?? {};
  const running = daemonState.tasks?.running ?? [];
  const stepTasks = daemonState.tasks?.step_tasks ?? [];
  const current = running[0];
  const mode = daemonState.evolution_mode;
  const modeLabel = mode ? formatEvolutionMode(mode) : '未知';
  const modeSource = formatEvolutionModeSource(daemonState.evolution_mode_source);
  const pendingRequest = daemonState.cycles?.pending_cycle_start_request ?? null;

  let currentText = '无运行中任务';
  if (current) {
    const linked = stepTasks.find((t) => t.task_id === current.task_id);
    const cyclePart = linked?.cycle_id ? ` @ ${linked.cycle_id}` : '';
    currentText = `当前 ${current.type}${cyclePart}`;
  }

  const tickPart = daemonState.last_tick_at
    ? `上次 tick ${formatTimeShort(daemonState.last_tick_at)}`
    : '尚无 tick 记录';

  let pendingPart = '';
  if (pendingRequest) {
    const reasons = (pendingRequest.reasons ?? []).join(', ') || 'unknown';
    const deferred = pendingRequest.deferred_count > 0
      ? ` · 暂缓 ${pendingRequest.deferred_count} 次`
      : '';
    pendingPart = `<span class="daemon-chip cycle-start-pending" title="${reasons}">开轮请求 pending${deferred}</span>`;
  }

  const modeClass = mode ? `mode-${mode}` : 'mode-unknown';
  const modeTitle = modeSource
    ? `来源: ${modeSource}${mode === 'on_demand' ? ' · tick 不会自动开新轮' : mode === 'continuous' ? ' · tick 可自动开新轮' : ''}`
    : '';

  const channel = daemonState.channel ?? null;
  let channelPart = '';
  if (channel) {
    const chHealth = channel.health?.status ?? 'unknown';
    const chWorker = channel.worker ?? {};
    const chCounts = channel.tasks?.counts ?? {};
    const inPending = channel.inbound?.pending_count ?? 0;
    const outPending = channel.outbox?.pending_count ?? 0;
    channelPart = `
      <span class="daemon-chip channel-domain">Channel</span>
      <span class="daemon-chip health-${chHealth}" title="Channel worker 健康">Ch: ${chHealth}</span>
      <span class="daemon-chip worker-${chWorker.running ? 'on' : 'off'}">Ch Worker: ${chWorker.running ? '运行' : '停止'}${chWorker.stale ? ' (stale)' : ''}</span>
      <span class="daemon-chip">Ch 队列 ${chCounts.pending ?? 0}/${chCounts.running ?? 0}</span>
      <span class="daemon-chip${inPending || outPending ? ' channel-attention' : ''}">入 ${inPending} · 出 ${outPending}</span>
    `;
  }

  const subjectChip = isMultiSubject()
    ? `<span class="daemon-chip muted">Subject: ${activeSubject}</span>`
    : '';

  daemonBarEl.innerHTML = `
    ${subjectChip}
    <span class="daemon-chip ${modeClass}" title="${modeTitle}">模式: ${modeLabel}</span>
    <span class="daemon-chip health-${health.status ?? 'unknown'}">Health: ${health.status ?? 'unknown'}</span>
    <span class="daemon-chip worker-${worker.running ? 'on' : 'off'}">Worker: ${worker.running ? '运行中' : '未运行'}${worker.stale ? ' (stale)' : ''}</span>
    <span class="daemon-chip">队列 pending ${counts.pending ?? 0} · running ${counts.running ?? 0}</span>
    ${pendingPart}
    <span class="daemon-chip">${currentText}</span>
    ${channelPart}
    <span class="daemon-chip muted">${tickPart}${modeSource ? ` · ${modeSource}` : ''}</span>
  `;
}

function collectAttentionItems() {
  const items = [];
  if (isMultiSubject()) {
    for (const s of subjectsList) {
      for (const item of observabilityBySubject[s.subject]?.attention?.items ?? []) {
        items.push(item);
      }
    }
  } else {
    for (const item of getObservability()?.attention?.items ?? []) {
      items.push(item);
    }
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return items
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
    .slice(0, 24);
}

function renderAttentionPanel() {
  if (!attentionPanelEl) return;
  const items = collectAttentionItems();
  if (!items.length) {
    attentionPanelEl.classList.add('hidden');
    attentionPanelEl.innerHTML = '';
    return;
  }
  attentionPanelEl.classList.remove('hidden');
  attentionPanelEl.innerHTML = `
    <div class="attention-header">
      <span class="attention-title">待关注 (${items.length})</span>
    </div>
    <ul class="attention-list">
      ${items.map((item) => `
        <li class="attention-item severity-${item.severity ?? 'info'}">
          <div class="attention-item-head">
            <span class="attention-severity">${ATTENTION_SEVERITY_LABELS[item.severity] ?? item.severity}</span>
            ${isMultiSubject() && item.subject ? `<span class="attention-subject">${escapeHtml(item.subject)}</span>` : ''}
            <span class="attention-item-title">${escapeHtml(item.title)}</span>
          </div>
          ${item.summary ? `<p class="attention-summary">${escapeHtml(item.summary)}</p>` : ''}
          ${item.suggested_command ? `<code class="attention-cmd">${escapeHtml(item.suggested_command)}</code>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

function formatChannelRoleWorkers(workers) {
  const roles = workers?.roles ?? [];
  if (!roles.length) return '<p class="channel-detail-muted">无分 role worker 记录</p>';
  return roles.map((r) => {
    const stale = r.stale ? ' stale' : '';
    const zombie = r.zombie ? ' zombie' : '';
    return `<div class="channel-role-row"><span class="channel-role-name">${escapeHtml(r.role)}</span> <span class="channel-role-meta${stale}${zombie}">${r.running ? '运行' : '停'} · pid ${r.pid_alive ? '✓' : '✗'}${stale ? ' · stale' : ''}${zombie ? ' · zombie' : ''}</span></div>`;
  }).join('');
}

function renderChannelPresenceDetails(channel) {
  if (!channel) return '';
  const workers = channel.workers ?? {};
  const classifier = channel.classifier ?? {};
  const presence = channel.presence ?? {};
  const reactor = presence.reactor ?? null;
  const pendingSpeech = presence.pending_speech_generation ?? [];
  const feishu = channel.feishu ?? {};
  const listener = feishu.listener ?? {};
  const reload = feishu.reload ?? {};

  const classifierLine = classifier.enabled === false
    ? 'Classifier: 已禁用'
    : `Classifier: ${classifier.mode ?? '—'} · 间隔 ${classifier.interval_ms ?? '—'}ms · batch ${classifier.batch_size ?? '—'}`;

  const reactorStatus = reactor?.status ?? 'idle';
  const reactorDeadline = reactor?.deadline_at
    ? ` · 截止 ${formatTimeShort(reactor.deadline_at)}`
    : '';

  const listenerLine = listener.running
    ? `Feishu WS: 运行${listener.fingerprint_stale ? ' (配置过期)' : ''}`
    : 'Feishu WS: 未运行';
  const reloadLine = reload.pending
    ? `热加载 pending: ${escapeHtml(reload.request?.reason ?? 'reload')}`
    : reload.last_error
      ? `上次热加载错误: ${escapeHtml(String(reload.last_error).slice(0, 80))}`
      : '';

  return `
    <details class="channel-details">
      <summary>Presence / Classifier / Feishu</summary>
      <div class="channel-details-body">
        <div class="channel-subheading">Role workers (${workers.running_count ?? 0} 运行)</div>
        ${formatChannelRoleWorkers(workers)}
        <div class="channel-subheading">Classifier</div>
        <p class="channel-detail-line">${escapeHtml(classifierLine)}</p>
        <div class="channel-subheading">Presence reactor</div>
        <p class="channel-detail-line">${escapeHtml(reactorStatus)}${reactorDeadline}</p>
        ${pendingSpeech.length ? `<p class="channel-detail-line channel-stat-warn">待生成话术 ${pendingSpeech.length}</p>` : ''}
        <div class="channel-subheading">Feishu</div>
        <p class="channel-detail-line">${escapeHtml(listenerLine)}</p>
        ${reloadLine ? `<p class="channel-detail-line">${reloadLine}</p>` : ''}
      </div>
    </details>
  `;
}

function renderChannelPanel() {
  if (!channelPanelEl) return;
  const channel = getDaemonState()?.channel
    ?? getObservability()?.channel_diagnostics;
  if (!channel) {
    channelPanelEl.innerHTML = '<p class="feed-empty">Channel 未初始化</p>';
    return;
  }

  const health = channel.health ?? {};
  const worker = channel.worker ?? {};
  const counts = channel.tasks?.counts ?? {};
  const running = channel.tasks?.running ?? [];
  const failed = channel.tasks?.failed ?? [];
  const inPending = channel.inbound?.pending_count ?? channel.inbound_pending ?? 0;
  const outPending = channel.outbox?.pending_count ?? channel.outbox_pending ?? 0;
  const healthClass = health.status ?? 'unknown';
  const workerText = worker.running
    ? `运行中${worker.stale ? ' (stale)' : ''}`
    : '未运行';

  const statsHtml = `
    <div class="channel-stats">
      <span class="channel-stat health-${healthClass}">健康: ${health.status ?? 'unknown'}</span>
      <span class="channel-stat">Worker: ${workerText}</span>
      <span class="channel-stat">队列 pending ${counts.pending ?? 0} · running ${counts.running ?? 0}</span>
      <span class="channel-stat${inPending ? ' channel-stat-warn' : ''}">入站待处理 ${inPending}</span>
      <span class="channel-stat${outPending ? ' channel-stat-warn' : ''}">出站待发 ${outPending}</span>
    </div>
  `;

  let runningHtml = '';
  if (running.length) {
    runningHtml = `<div class="channel-subheading">运行中任务</div>${running.map((t) => `
      <div class="channel-task-row"><code>${escapeHtml(t.task_id)}</code> · ${escapeHtml(t.type)}</div>
    `).join('')}`;
  }

  let failedHtml = '';
  if (failed.length) {
    failedHtml = `<div class="channel-subheading channel-subheading-warn">失败任务</div>${failed.slice(0, 3).map((t) => `
      <div class="channel-task-row channel-task-failed">${escapeHtml(t.type)} · ${escapeHtml(t.last_error_code ?? 'error')}</div>
    `).join('')}`;
  }

  const events = channel.recent_events ?? [];
  let eventsHtml = '<p class="feed-empty">暂无 Channel 事件</p>';
  if (events.length) {
    eventsHtml = events.slice(0, 10).map((ev) => {
      const time = formatTimeShort(ev.recorded_at);
      const errClass = ev.status && ev.status !== 'ok' ? ' channel-event-error' : '';
      return `<div class="feed-row channel-event-row${errClass}"><span class="feed-time">${time}</span><span class="feed-label" title="${escapeHtml(ev.type ?? '')}">${formatChannelEventLabel(ev)}</span></div>`;
    }).join('');
  }

  const presenceDetails = renderChannelPresenceDetails(
    getDaemonState()?.channel ?? null,
  );

  channelPanelEl.innerHTML = `${statsHtml}${presenceDetails}${runningHtml}${failedHtml}<div class="channel-subheading">最近事件</div><div class="channel-event-feed">${eventsHtml}</div>`;
}

function renderActiveCycles() {
  if (!activeCyclesEl) return;
  const cycles = getDaemonState()?.cycles?.recent ?? [];
  if (!cycles.length) {
    activeCyclesEl.innerHTML = '<p class="feed-empty">无 open cycle</p>';
    return;
  }

  activeCyclesEl.innerHTML = '';
  for (const cycle of cycles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const classes = ['round-btn', 'cycle-active'];
    if (cycle.cycle_id === activeCycleId && activeViewMode === 'cycle') classes.push('active');
    if (cycle.meta?.abandoned) classes.push('cycle-abandoned');
    btn.className = classes.join(' ');
    btn.dataset.cycleId = cycle.cycle_id;

    const stepsObj = {};
    for (const [name, status] of Object.entries(cycle.steps ?? {})) {
      stepsObj[name] = { status };
    }

    btn.innerHTML = `
      <span class="cycle-id">${cycle.cycle_id}</span>
      <span class="when">${formatWhen(cycle.opened_at)} · ${cycle.status ?? 'open'}</span>
      ${renderStepBadges(stepsObj, { compact: true })}
    `;
    btn.addEventListener('click', () => selectCycle(cycle.cycle_id));
    activeCyclesEl.appendChild(btn);
  }
}

function applyObservabilityState(subject, next) {
  if (!subject || !next) return null;
  if (!panelFpBySubject[subject]) {
    panelFpBySubject[subject] = { bar: '', cycles: '', channel: '', attention: '' };
  }
  const fp = panelFpBySubject[subject];
  const attFp = observabilityFingerprint(next);
  const changed = attFp !== fp.attention;
  observabilityBySubject[subject] = next;
  if (subject === activeSubject && changed) {
    fp.attention = attFp;
    renderAttentionPanel();
  }
  renderSubjectOverview();
  return next;
}

async function fetchObservabilityForSubject(subject) {
  try {
    const res = await fetch(`${subjectApiBase(subject)}/observability`, { cache: 'no-store' });
    if (!res.ok) return null;
    const next = await res.json();
    return applyObservabilityState(subject, next);
  } catch {
    return null;
  }
}

function scheduleLoadObservability(subject = activeSubject) {
  if (!subject) return;
  if (loadObservabilityTimer) clearTimeout(loadObservabilityTimer);
  loadObservabilityTimer = setTimeout(() => {
    loadObservabilityTimer = null;
    void fetchObservabilityForSubject(subject);
    if (isMultiSubject()) {
      for (const s of subjectsList) {
        if (s.subject !== subject) void fetchObservabilityForSubject(s.subject);
      }
    }
  }, LOAD_OBSERVABILITY_DEBOUNCE_MS);
}

async function loadObservability(subject = activeSubject) {
  return fetchObservabilityForSubject(subject);
}

function applyDaemonState(subject, next) {
  if (!subject || !next) return null;
  if (!panelFpBySubject[subject]) {
    panelFpBySubject[subject] = { bar: '', cycles: '', channel: '', attention: '' };
  }
  const fp = panelFpBySubject[subject];
  const barFp = daemonBarFingerprint(next);
  const cyclesFp = activeCyclesFingerprint(next);
  const channelFp = channelPanelFingerprint(next);
  const barChanged = barFp !== fp.bar;
  const cyclesChanged = cyclesFp !== fp.cycles;
  const channelChanged = channelFp !== fp.channel;

  daemonBySubject[subject] = next;
  if (subject === activeSubject) {
    if (barChanged) {
      fp.bar = barFp;
      renderDaemonBar();
    }
    if (cyclesChanged) {
      fp.cycles = cyclesFp;
      renderActiveCycles();
    }
    if (channelChanged) {
      fp.channel = channelFp;
      renderChannelPanel();
    }
  }
  renderSubjectOverview();
  return next;
}

function patchEvolutionModeFromEvent(payload) {
  const subject = payload?.subject ?? activeSubject;
  if (!subject) return false;
  if (!payload || payload.event_type !== 'evolution_mode_changed' || !payload.to) return false;
  const state = daemonBySubject[subject] ?? {};
  state.evolution_mode = payload.to;
  if (payload.source) state.evolution_mode_source = payload.source;
  const fp = panelFpBySubject[subject];
  if (fp) fp.bar = '';
  applyDaemonState(subject, { ...state });
  return true;
}

async function fetchDaemonForSubject(subject) {
  try {
    const res = await fetch(`${subjectApiBase(subject)}/daemon`, { cache: 'no-store' });
    if (!res.ok) return null;
    const next = await res.json();
    return applyDaemonState(subject, next);
  } catch {
    return null;
  }
}

function scheduleLoadDaemon(subject = activeSubject) {
  if (!subject) return;
  if (loadDaemonTimer) clearTimeout(loadDaemonTimer);
  loadDaemonTimer = setTimeout(() => {
    loadDaemonTimer = null;
    void fetchDaemonForSubject(subject);
    if (isMultiSubject()) {
      for (const s of subjectsList) {
        if (s.subject !== subject) void fetchDaemonForSubject(s.subject);
      }
    }
  }, LOAD_DAEMON_DEBOUNCE_MS);
}

async function loadDaemon(subject = activeSubject) {
  return fetchDaemonForSubject(subject);
}

function renderTimeline(filter = '') {
  const manifest = getManifest();
  if (!manifest?.rounds) return;
  const q = filter.trim().toLowerCase();
  const newCycleIds = getNewCycleIds();
  timelineEl.innerHTML = '';

  for (const round of manifest.rounds) {
    const hay = `${round.cycle_id} ${round.tldr ?? ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    const classes = ['round-btn'];
    if (round.cycle_id === activeCycleId && activeViewMode === 'round') classes.push('active');
    if (newCycleIds.has(round.cycle_id)) classes.push('is-new');
    btn.className = classes.join(' ');
    btn.dataset.cycleId = round.cycle_id;
    btn.innerHTML = `
      <span class="cycle-id">${round.cycle_id}${newCycleIds.has(round.cycle_id) ? ' <span class="new-tag">新</span>' : ''}</span>
      <span class="when">${formatWhen(round.generated_at)}</span>
      ${round.tldr ? `<span class="tldr">${truncate(round.tldr)}</span>` : ''}
      <span class="badge ${round.has_diary ? '' : 'none'}">${round.has_diary ? '有日记' : '无日记'}</span>
    `;
    btn.addEventListener('click', () => {
      newCycleIds.delete(round.cycle_id);
      selectRound(round.cycle_id);
    });
    timelineEl.appendChild(btn);
  }
}

async function loadManifest(subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/manifest`);
  if (!res.ok) throw new Error(`无法加载 manifest: ${subject}`);
  const next = await res.json();
  const prev = manifestsBySubject[subject];
  const prevIds = new Set(prev?.rounds?.map((r) => r.cycle_id) ?? []);
  manifestsBySubject[subject] = next;
  const seenCycleIds = getSeenCycleIds();
  const newCycleIds = getNewCycleIds();
  for (const round of next.rounds ?? []) {
    if (!seenCycleIds.has(round.cycle_id)) {
      seenCycleIds.add(round.cycle_id);
      if (prevIds.size > 0 && !prevIds.has(round.cycle_id)) {
        newCycleIds.add(round.cycle_id);
      }
    }
  }
  if (subject === activeSubject) updateMeta();
  return next;
}

async function loadRecentEvents(subject = activeSubject) {
  try {
    const res = await fetch(`${subjectApiBase(subject)}/events/recent?limit=30`);
    if (!res.ok) return;
    const data = await res.json();
    feedEventsBySubject[subject] = data.events ?? [];
    if (subject === activeSubject) renderEventFeed();
  } catch {
    // ignore
  }
}

async function loadRoundDetail(cycleId, subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/rounds/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`无法加载轮次详情: ${res.status}`);
  return res.json();
}

async function loadCycleDetail(cycleId, subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/cycles/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`无法加载 cycle 详情: ${res.status}`);
  return res.json();
}

function buildCycleDiagnosticsPanel(data) {
  const section = document.createElement('section');
  section.className = 'panel diagnostics-panel';
  const diag = data.diagnostics ?? {};
  const attention = data.observability_attention ?? [];
  const stuck = diag.stuck_steps ?? [];
  const drift = diag.drift_steps ?? [];
  const obs = getObservability();
  const failedTasks = (obs?.cycle_diagnostics?.failed_tasks ?? [])
    .filter((t) => t.cycle_id === data.cycle_id || !t.cycle_id)
    .slice(0, 5);
  const suggestions = obs?.cycle_diagnostics?.health_suggestions ?? [];

  const parts = [];
  if (stuck.length) {
    parts.push(`<div class="diag-block diag-critical"><strong>卡住 step</strong><ul>${stuck.map((s) => `
      <li><code>${escapeHtml(s.step)}</code> — ${escapeHtml(s.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (drift.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>漂移 step</strong><ul>${drift.map((d) => `
      <li><code>${escapeHtml(d.step)}</code> — ${escapeHtml(d.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (attention.length) {
    parts.push(`<div class="diag-block"><strong>本 cycle 相关关注</strong><ul>${attention.map((a) => `
      <li class="severity-${a.severity}">${escapeHtml(a.title)}: ${escapeHtml(a.summary)}</li>
    `).join('')}</ul></div>`);
  }
  if (failedTasks.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>失败任务</strong><ul>${failedTasks.map((t) => `
      <li><code>${escapeHtml(t.task_id)}</code> ${escapeHtml(t.type)} — ${escapeHtml(t.last_error_code ?? t.last_error ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (suggestions.length) {
    parts.push(`<div class="diag-block"><strong>建议</strong><ul>${suggestions.slice(0, 3).map((s) => `
      <li><code>${escapeHtml(s)}</code></li>
    `).join('')}</ul></div>`);
  }

  if (!parts.length) return null;

  section.innerHTML = `<h3>Cycle 诊断</h3>${parts.join('')}`;
  return section;
}

function buildTasksPanelElement(tasks) {
  const section = document.createElement('section');
  section.className = 'panel tasks-panel';
  section.innerHTML = `
    <h3>Daemon 任务</h3>
    <table class="tasks-table">
      <thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
      <tbody>${(tasks ?? []).map((t) => `
        <tr class="${t.status === 'failed' ? 'task-row-failed' : ''}">
          <td><code>${escapeHtml(t.task_id)}</code></td>
          <td>${escapeHtml(t.type)}</td>
          <td>${escapeHtml(t.status)}</td>
          <td>${t.attempts ?? 0}</td>
          <td>${escapeHtml(t.last_error_code ?? t.last_error ?? '')}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
  return section;
}

function patchDetailHeader(data) {
  const header = detailEl.querySelector('.detail-header');
  if (!header) return;

  let statusTag = header.querySelector('.cycle-status-tag');
  if (data.cycle_status) {
    if (!statusTag) {
      statusTag = document.createElement('span');
      statusTag.className = 'cycle-status-tag';
      header.insertBefore(statusTag, header.querySelector('.detail-steps') ?? null);
    }
    statusTag.textContent = `status: ${data.cycle_status}`;
  } else if (statusTag) {
    statusTag.remove();
  }

  if (data.steps) {
    let stepsWrap = header.querySelector('.detail-steps');
    if (!stepsWrap) {
      stepsWrap = document.createElement('div');
      stepsWrap.className = 'detail-steps';
      header.appendChild(stepsWrap);
    }
    stepsWrap.innerHTML = renderStepBadges(data.steps);
  }
}

function patchDetailTasks(data) {
  const existing = detailEl.querySelector('.tasks-panel');
  const next = buildTasksPanelElement(data.tasks);
  if (existing) {
    existing.replaceWith(next);
  } else {
    detailEl.appendChild(next);
  }
}

function patchDetailDiaryContent(data) {
  const diaryContent = detailEl.querySelector('.panel.diary .content');
  if (!diaryContent) return;
  const diaries = data.diaries ?? [];
  if (!diaries.length) {
    diaryContent.innerHTML = '<p class="missing">本轮无关联日记</p>';
    return;
  }
  diaryContent.innerHTML = diaries[0]?.html ?? '<p class="missing">无日记内容</p>';
}

function patchDetailDom(data, mode, needs) {
  if (needs.header) patchDetailHeader(data);
  if (needs.tasks && mode === 'cycle') patchDetailTasks(data);
  if (needs.diary) patchDetailDiaryContent(data);
}

async function patchActiveDetailIfNeeded() {
  if (!activeCycleId || !activeViewMode || !activeSubject) return;

  try {
    const data = activeViewMode === 'cycle'
      ? await loadCycleDetail(activeCycleId)
      : await loadRoundDetail(activeCycleId);

    const needs = detailCacheNeedsPatch(activeDetailCache, data, activeViewMode);
    if (!needs.header && !needs.tasks && !needs.diary) return;

    patchDetailDom(data, activeViewMode, needs);
    activeDetailCache = buildDetailCacheFromData(data, activeViewMode);
  } catch {
    // keep current view on patch failure
  }
}

function schedulePatchActiveDetail() {
  if (patchDetailTimer) clearTimeout(patchDetailTimer);
  patchDetailTimer = setTimeout(() => {
    patchDetailTimer = null;
    void patchActiveDetailIfNeeded();
  }, PATCH_DETAIL_DEBOUNCE_MS);
}

function renderDetail(data, { mode = 'round' } = {}) {
  const diaries = data.diaries ?? [];
  let diaryIndex = 0;

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `<h2>${data.cycle_id}</h2>`;
  if (data.cycle_status) {
    const statusSpan = document.createElement('span');
    statusSpan.className = 'cycle-status-tag';
    statusSpan.textContent = `status: ${data.cycle_status}`;
    header.appendChild(statusSpan);
  }
  if (data.steps) {
    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'detail-steps';
    stepsWrap.innerHTML = renderStepBadges(data.steps);
    header.appendChild(stepsWrap);
  }

  if (diaries.length > 1) {
    const selectWrap = document.createElement('div');
    selectWrap.className = 'diary-select';
    const label = document.createElement('label');
    label.textContent = '日记';
    const select = document.createElement('select');
    diaries.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = d.exec_id;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      diaryIndex = Number(select.value);
      updateDiaryPanel();
    });
    selectWrap.append(label, select);
    header.appendChild(selectWrap);
  } else if (diaries.length === 1) {
    const span = document.createElement('span');
    span.className = 'diary-select';
    span.innerHTML = `<label>日记</label> <code>${diaries[0].exec_id}</code>`;
    header.appendChild(span);
  }

  const panels = document.createElement('div');
  panels.className = 'panels';

  const reportPanel = document.createElement('section');
  reportPanel.className = 'panel report';
  reportPanel.innerHTML = '<h3>情报报告</h3>';
  const reportContent = document.createElement('div');
  reportContent.className = 'content';
  reportContent.innerHTML = data.report_html ?? '<p class="missing">无报告内容</p>';
  reportPanel.appendChild(reportContent);

  const diaryPanel = document.createElement('section');
  diaryPanel.className = 'panel diary';
  diaryPanel.innerHTML = '<h3>进化日记</h3>';
  const diaryContent = document.createElement('div');
  diaryContent.className = 'content';
  diaryPanel.appendChild(diaryContent);

  function updateDiaryPanel() {
    if (!diaries.length) {
      diaryContent.innerHTML = '<p class="missing">本轮无关联日记</p>';
      return;
    }
    diaryContent.innerHTML = diaries[diaryIndex]?.html ?? '<p class="missing">无日记内容</p>';
  }
  updateDiaryPanel();

  panels.append(reportPanel, diaryPanel);

  const children = [header];
  if (mode === 'cycle') {
    const diagPanel = buildCycleDiagnosticsPanel(data);
    if (diagPanel) children.push(diagPanel);
  }
  children.push(panels);
  if (mode === 'cycle' && data.tasks?.length) {
    children.push(buildTasksPanelElement(data.tasks));
  }
  detailEl.replaceChildren(...children);

  activeDetailCache = buildDetailCacheFromData(data, mode);
}

async function selectCycle(cycleId, { scrollTimeline = false } = {}) {
  activeCycleId = cycleId;
  activeViewMode = 'cycle';
  activeDetailCache = null;
  setHash(cycleId);
  renderTimeline(filterEl.value);
  renderActiveCycles();
  if (scrollTimeline) {
    const btn = activeCyclesEl?.querySelector(`[data-cycle-id="${cycleId}"]`);
    btn?.scrollIntoView({ block: 'nearest' });
  }
  detailEl.innerHTML = '<p class="placeholder">加载中…</p>';
  try {
    const data = await loadCycleDetail(cycleId);
    renderDetail(data, { mode: 'cycle' });
  } catch (err) {
    activeDetailCache = null;
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

async function selectRound(cycleId, { scrollTimeline = false } = {}) {
  activeCycleId = cycleId;
  activeViewMode = 'round';
  activeDetailCache = null;
  setHash(cycleId);
  renderTimeline(filterEl.value);
  renderActiveCycles();
  if (scrollTimeline) {
    const btn = timelineEl.querySelector(`[data-cycle-id="${cycleId}"]`);
    btn?.scrollIntoView({ block: 'nearest' });
  }
  detailEl.innerHTML = '<p class="placeholder">加载中…</p>';
  try {
    const data = await loadRoundDetail(cycleId);
    renderDetail(data, { mode: 'round' });
  } catch (err) {
    activeDetailCache = null;
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

async function selectById(cycleId, opts = {}) {
  const cycleRes = await fetch(`${subjectApiBase(activeSubject)}/cycles/${encodeURIComponent(cycleId)}`);
  if (cycleRes.ok) {
    await selectCycle(cycleId, opts);
    return;
  }
  await selectRound(cycleId, opts);
}

function patchManifestRound(cycleId, patch, subject = activeSubject) {
  const round = manifestsBySubject[subject]?.rounds?.find((r) => r.cycle_id === cycleId);
  if (round) Object.assign(round, patch);
}

function eventSubject(payload) {
  return payload?.subject ?? defaultSubject ?? activeSubject;
}

function handleSsePayload(payload) {
  const event = payload?.event;
  const subject = eventSubject(payload);

  if (event === 'hello') {
    setLiveStatus('实时已连接', 'connected');
    if (payload.default_subject) defaultSubject = payload.default_subject;
    if (Array.isArray(payload.subjects) && payload.subjects.length) {
      subjectsList = payload.subjects.map((s) => ({
        subject: s.subject,
        namespace: s.namespace,
      }));
    }
    if (!activeSubject && defaultSubject) {
      void setActiveSubject(subjectFromQuery() || defaultSubject, { skipQueryUpdate: true });
    }
    updateMeta('实时');
    return;
  }
  if (event === 'ping') return;
  if (event === 'error') {
    setLiveStatus(`错误: ${payload.message ?? 'unknown'}`, 'error');
    return;
  }
  if (event === 'daemon_event') {
    prependFeedEvent(payload, subject);
    patchEvolutionModeFromEvent(payload);
    scheduleLoadDaemon(subject);
    scheduleLoadObservability(subject);
    if (
      subject === activeSubject
      && activeCycleId
      && payload.cycle_id === activeCycleId
      && PATCH_WORTHY_DAEMON_EVENTS.has(payload.event_type)
    ) {
      schedulePatchActiveDetail();
    }
    return;
  }
  if (event === 'runtime_updated') {
    scheduleLoadDaemon(subject);
    scheduleLoadObservability(subject);
    return;
  }
  if (event === 'round_added') {
    setLiveStatus('实时已连接', 'connected');
    if (subject === activeSubject) {
      void loadManifest(subject).then(() => {
        renderTimeline(filterEl.value);
        updateMeta('实时');
      });
    } else {
      void loadManifest(subject);
    }
    return;
  }
  if (event === 'round_updated') {
    setLiveStatus('实时已连接', 'connected');
    scheduleLoadDaemon(subject);
    if (payload.has_diary) {
      patchManifestRound(payload.cycle_id, { has_diary: true }, subject);
      if (subject === activeSubject) renderTimeline(filterEl.value);
    }
    if (
      subject === activeSubject
      && activeCycleId === payload.cycle_id
      && payload.has_diary
    ) {
      schedulePatchActiveDetail();
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  setLiveStatus(`已断开，${Math.round(reconnectDelayMs / 1000)}s 后重连`, 'disconnected');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectLive();
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, 30_000);
  }, reconnectDelayMs);
}

function connectLive() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  try {
    eventSource = new EventSource('/events');
  } catch {
    setLiveStatus('实时不可用', 'error');
    return;
  }

  for (const name of [
    'hello', 'round_added', 'round_updated', 'daemon_event', 'runtime_updated', 'error',
  ]) {
    eventSource.addEventListener(name, (e) => {
      try {
        handleSsePayload(JSON.parse(e.data));
      } catch {
        // ignore
      }
      if (name === 'hello') reconnectDelayMs = 5000;
    });
  }

  eventSource.addEventListener('ping', () => {});

  eventSource.onopen = () => {
    reconnectDelayMs = 5000;
    setLiveStatus('实时连接中…', 'connecting');
  };

  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    scheduleReconnect();
  };
}

function startDaemonPolling() {
  if (daemonPollTimer) clearInterval(daemonPollTimer);
  daemonPollTimer = setInterval(() => {
    scheduleLoadDaemon(activeSubject);
    scheduleLoadObservability(activeSubject);
  }, 15_000);
  if (daemonPollTimer.unref) daemonPollTimer.unref();
}

async function loadSubjectsIndex() {
  const res = await fetch('/api/subjects');
  if (!res.ok) throw new Error('无法加载 /api/subjects');
  const data = await res.json();
  defaultSubject = data.default_subject;
  subjectsList = data.subjects ?? [];
  return data;
}

async function refreshActiveSubjectPanels() {
  if (!activeSubject) return;
  panelFpBySubject[activeSubject] = { bar: '', cycles: '', channel: '', attention: '' };
  await loadManifest(activeSubject);
  await Promise.all([
    loadDaemon(activeSubject),
    loadObservability(activeSubject),
  ]);
  await loadRecentEvents(activeSubject);
  renderTimeline(filterEl.value);
  renderActiveCycles();
  renderChannelPanel();
  renderDaemonBar();
  renderAttentionPanel();
  renderSubjectOverview();
  updateMeta('');
}

async function setActiveSubject(subject, { preserveHash = false, skipQueryUpdate = false } = {}) {
  if (!subject || !subjectsList.some((s) => s.subject === subject)) return;
  activeSubject = subject;
  if (!skipQueryUpdate) setSubjectQuery(subject);
  activeCycleId = null;
  activeViewMode = null;
  activeDetailCache = null;
  if (!preserveHash) setHash('');
  await refreshActiveSubjectPanels();

  const initial = preserveHash ? cycleFromHash() : null;
  if (initial) {
    await selectById(initial);
  } else {
    const daemonState = getDaemonState();
    if (daemonState?.cycles?.recent?.[0]?.cycle_id) {
      await selectCycle(daemonState.cycles.recent[0].cycle_id);
    } else {
      const manifest = getManifest();
      if (manifest?.rounds?.[0]?.cycle_id) {
        await selectRound(manifest.rounds[0].cycle_id);
      } else {
        detailEl.innerHTML = '<p class="placeholder">从左侧选择一轮或进行中的 cycle。</p>';
      }
    }
  }
}

async function init() {
  try {
    await loadSubjectsIndex();
  } catch {
    metaEl.textContent = '无法连接 viewer API，请运行 jea intel viewer serve';
    return;
  }

  const querySubject = subjectFromQuery();
  const initialSubject = querySubject && subjectsList.some((s) => s.subject === querySubject)
    ? querySubject
    : defaultSubject;

  for (const s of subjectsList) {
    seenCycleIdsBySubject[s.subject] = new Set();
    newCycleIdsBySubject[s.subject] = new Set();
    panelFpBySubject[s.subject] = { bar: '', cycles: '', channel: '', attention: '' };
  }

  await setActiveSubject(initialSubject, { preserveHash: true, skipQueryUpdate: !querySubject });
  if (isMultiSubject()) {
    for (const s of subjectsList) {
      if (s.subject !== activeSubject) void fetchObservabilityForSubject(s.subject);
    }
  }
  if (querySubject) setSubjectQuery(initialSubject);

  for (const round of getManifest()?.rounds ?? []) {
    getSeenCycleIds().add(round.cycle_id);
  }

  startDaemonPolling();

  filterEl.addEventListener('input', () => renderTimeline(filterEl.value));
  window.addEventListener('hashchange', () => {
    const id = cycleFromHash();
    if (id && id !== activeCycleId) void selectById(id);
  });

  connectLive();
}

init();
