import {
  PATCH_WORTHY_DAEMON_EVENTS,
  activeCyclesFingerprint,
  buildDetailCacheFromData,
  channelPanelFingerprint,
  daemonBarFingerprint,
  detailCacheNeedsPatch,
  observabilityFingerprint,
  opsHomeFingerprint,
  resolveViewMode,
} from './live-state.js';
import {
  t,
  tDynamic,
  getLocale,
  setLocale,
  availableLocales,
  onLocaleChange,
  LOCALE_LABELS,
} from './i18n.js';
import './components/channel-pipeline.js';
import './components/channel-event-feed.js';
import './components/presence-reactor.js';
import './components/channel-workers.js';

const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const opsHomeEl = document.getElementById('ops-home');
const cycleReaderEl = document.getElementById('cycle-reader');
const backToOpsBtn = document.getElementById('back-to-ops');
const readerNavCycleEl = document.getElementById('reader-nav-cycle');
const readerNavMetaEl = document.getElementById('reader-nav-meta');
const metaEl = document.getElementById('meta');
const filterEl = document.getElementById('filter');
const liveStatusEl = document.getElementById('live-status');
const subjectOverviewEl = document.getElementById('subject-overview');
const activeCyclesEl = document.getElementById('active-cycles');
const localeSwitchEl = document.getElementById('locale-switch');

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
/** @type {Record<string, object[]>} */
const channelEventsBySubject = {};
/** @type {Record<string, Set<string>>} */
const seenCycleIdsBySubject = {};
/** @type {Record<string, Set<string>>} */
const newCycleIdsBySubject = {};
/** @type {Record<string, object|null>} */
const observabilityBySubject = {};
/** @type {Record<string, { cycles: string, opsHome: string }>} */
const panelFpBySubject = {};
/** @type {Record<string, string>} */
const channelFpBySubject = {};

/** @type {'ops'|'reading'} */
let viewMode = 'ops';

let activeCycleId = null;
/** @type {'cycle'|'round'|null} */
let activeViewMode = null;
/** @type {ReturnType<typeof buildDetailCacheFromData>|null} */
let activeDetailCache = null;

/** @type {{ key: string, params: object|null, state: string }} */
let liveStatusState = { key: 'live.connecting', params: null, state: 'connecting' };

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
const CHANNEL_EVENT_BUFFER = 80;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const STEP_ORDER = [
  'intel', 'intel_report', 'exec', 'verify', 'belief_update',
  'goals_assess', 'goals_calibrate', 'diary',
];

const STEP_LABELS = {
  intel: 'Intel',
  intel_report: 'Report',
  exec: 'Exec',
  verify: 'Verify',
  belief_update: 'Beliefs',
  goals_assess: 'Goals',
  goals_calibrate: 'Calibrate',
  diary: 'Diary',
};

const STEP_STATUS_LABELS = {
  done: 'done',
  running: 'running',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'pending',
};

const CHANNEL_ROLES = ['notify', 'control', 'agent', 'presence', 'speech', 'classifier'];

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

function getChannelEvents() {
  if (!activeSubject) return [];
  if (!channelEventsBySubject[activeSubject]) channelEventsBySubject[activeSubject] = [];
  return channelEventsBySubject[activeSubject];
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
  if (!activeSubject) return { cycles: '', opsHome: '' };
  if (!panelFpBySubject[activeSubject]) {
    panelFpBySubject[activeSubject] = { cycles: '', opsHome: '' };
  }
  return panelFpBySubject[activeSubject];
}

function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
}

function renderLocaleSwitch() {
  if (!localeSwitchEl) return;
  const cur = getLocale();
  localeSwitchEl.innerHTML = availableLocales().map((loc) => `
    <button type="button" class="locale-btn${loc === cur ? ' active' : ''}" data-locale="${loc}" aria-pressed="${loc === cur}">${escapeHtml(LOCALE_LABELS[loc] ?? loc)}</button>
  `).join('');
  for (const btn of localeSwitchEl.querySelectorAll('.locale-btn')) {
    btn.addEventListener('click', () => setLocale(btn.dataset.locale));
  }
}

function rerenderAll() {
  applyStaticI18n();
  renderLocaleSwitch();
  applyLiveStatus();
  updateMeta();
  renderSubjectOverview();
  renderActiveCycles();
  renderTimeline(filterEl?.value ?? '');
  if (viewMode === 'ops') {
    renderOpsHome();
  } else if (activeCycleId) {
    void selectById(activeCycleId, { scrollTimeline: false });
  }
}

function updateReaderNav({ cycleId = '', meta = '', loading = false } = {}) {
  if (readerNavCycleEl) {
    readerNavCycleEl.textContent = cycleId || (loading ? t('common.ellipsis') : '');
  }
  if (readerNavMetaEl) {
    const text = loading ? t('common.loading') : meta;
    readerNavMetaEl.textContent = text;
    readerNavMetaEl.classList.toggle('hidden', !text);
    readerNavMetaEl.classList.toggle('is-loading', loading);
  }
}

function setViewMode(mode) {
  viewMode = mode;
  document.body.dataset.view = mode;
  if (opsHomeEl) opsHomeEl.classList.toggle('hidden', mode !== 'ops');
  if (cycleReaderEl) cycleReaderEl.classList.toggle('hidden', mode !== 'reading');
}

function goToOpsHome() {
  activeCycleId = null;
  activeViewMode = null;
  activeDetailCache = null;
  updateReaderNav();
  setHash('');
  setViewMode('ops');
  renderTimeline(filterEl?.value ?? '');
  renderActiveCycles();
  renderOpsHome();
}

function navigateToCycle(cycleId, subject = activeSubject) {
  if (subject && subject !== activeSubject) {
    void setActiveSubject(subject, { preserveHash: false, skipQueryUpdate: false }).then(() => {
      void selectById(cycleId);
    });
    return;
  }
  void selectById(cycleId);
}

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
  if (!iso) return t('common.dash');
  try {
    return new Date(iso).toLocaleString(getLocale(), { hour12: false });
  } catch {
    return iso;
  }
}

function formatTimeShort(iso) {
  if (!iso) return t('common.dash');
  try {
    return new Date(iso).toLocaleTimeString(getLocale(), { hour12: false });
  } catch {
    return iso;
  }
}

function escapeHtml(text) {
  if (text == null) return t('common.dash');
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}${t('common.ellipsis')}`;
}

function updateMeta(extra = '') {
  const manifest = getManifest();
  if (!manifest) return;
  const parts = [
    manifest.subject,
    manifest.namespace,
    t('meta.roundCount', { count: manifest.round_count ?? manifest.rounds?.length ?? 0 }),
    manifest.built_at ? t('meta.updatedAt', { time: formatWhen(manifest.built_at) }) : '',
    isMultiSubject() ? t('meta.subjectCount', { count: subjectsList.length }) : '',
    extra,
  ].filter(Boolean);
  metaEl.textContent = parts.join(' · ');
}

function applyLiveStatus() {
  if (!liveStatusEl) return;
  const { key, params, state } = liveStatusState;
  liveStatusEl.textContent = t(key, params ?? undefined);
  liveStatusEl.className = `live-status${state ? ` ${state}` : ''}`;
}

function setLiveStatus(key, params = null, state = '') {
  liveStatusState = { key, params, state };
  applyLiveStatus();
}

function renderStepBadges(steps, { compact = false } = {}) {
  if (!steps || typeof steps !== 'object') return t('common.dash');
  const items = STEP_ORDER
    .filter((name) => steps[name])
    .map((name) => {
      const raw = steps[name];
      const status = typeof raw === 'string' ? raw : (raw.status ?? 'pending');
      const label = STEP_LABELS[name] ?? name;
      const err = typeof raw === 'object' && raw?.error ? String(raw.error).slice(0, 80) : '';
      if (compact) {
        const sym = status === 'done' ? 'ok' : status === 'running' ? 'run' : status === 'failed' ? 'x' : '-';
        const errHint = err ? ` - ${err}` : '';
        return `<span class="step-dot step-${status}" title="${label}: ${status}${errHint}">${sym}</span>`;
      }
      const errPart = err ? ` (${err})` : '';
      return `<span class="step-badge step-${status}" title="${name}">${label}: ${status}${errPart}</span>`;
    });
  if (!items.length) return t('common.dash');
  const cls = compact ? 'step-dots' : 'step-badges';
  return `<div class="${cls}">${items.join('')}</div>`;
}

function stepStatus(steps, name) {
  const raw = steps?.[name];
  if (!raw) return 'pending';
  return typeof raw === 'string' ? raw : (raw.status ?? 'pending');
}

function normalizeCycleSteps(cycle) {
  const stepsObj = {};
  for (const [name, status] of Object.entries(cycle?.steps ?? {})) {
    stepsObj[name] = { status: typeof status === 'string' ? status : (status?.status ?? 'pending') };
  }
  return stepsObj;
}

function activeStepName(steps) {
  for (const name of STEP_ORDER) {
    if (stepStatus(steps, name) === 'running') return name;
  }
  for (const name of STEP_ORDER) {
    if (stepStatus(steps, name) === 'failed') return name;
  }
  for (const name of STEP_ORDER) {
    if (stepStatus(steps, name) === 'pending') return name;
  }
  return null;
}

function runningStepLabel(cycles) {
  for (const cycle of cycles ?? []) {
    const steps = normalizeCycleSteps(cycle);
    const running = STEP_ORDER.find((name) => stepStatus(steps, name) === 'running');
    if (running) return `${STEP_LABELS[running] ?? running} @ ${cycle.cycle_id}`;
  }
  return t('common.dash');
}

function failedTaskCount(tasks) {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t2) => t2.status === 'failed').length;
}

function severitySummary(summary = {}) {
  if (!summary.count) return '0';
  const parts = [];
  if (summary.critical) parts.push(t('severitySummary.critical', { count: summary.critical }));
  if (summary.warning) parts.push(t('severitySummary.warning', { count: summary.warning }));
  if (summary.info) parts.push(t('severitySummary.info', { count: summary.info }));
  return parts.length ? parts.join(' / ') : String(summary.count);
}

function attentionPostureSummary(summary = {}) {
  const active = summary.active_count ?? summary.count ?? 0;
  const historical = summary.historical_count ?? 0;
  if (!active && historical) return t('posture.attentionHistorical', { count: historical });
  if (historical) return `${severitySummary({ ...summary, count: active, critical: summary.active_critical, warning: summary.active_warning, info: summary.active_info })} · ${t('posture.historyAck', { count: historical })}`;
  return severitySummary(summary);
}

function isActiveBlockingAttention(item) {
  return item?.status === 'active' && item.blocking !== false;
}

function isAcknowledgeableAttention(item) {
  if (!item || (item.status !== 'needs_ack' && item.category !== 'history')) return false;
  if (item.kind === 'task_failed') return Boolean(item.refs?.task_id);
  if (item.kind === 'channel_health') return true;
  return false;
}

function formatEventLabel(ev) {
  const base = tDynamic('events', ev.event_type, ev.event_type);
  if (ev.event_type === 'evolution_mode_changed' && ev.from && ev.to) {
    return `${base}: ${formatEvolutionMode(ev.from)} → ${formatEvolutionMode(ev.to)}`;
  }
  const parts = [base];
  if (ev.task_type || ev.step_type) parts.push(ev.task_type ?? ev.step_type);
  if (ev.cycle_id) parts.push(ev.cycle_id);
  return parts.join(' · ');
}

export function formatChannelEventLabel(ev) {
  const type = ev.type ?? ev.event_type;
  const base = tDynamic('channelEvents', type, type ?? 'channel');
  const parts = [base];
  if (ev.task_type) parts.push(ev.task_type);
  if (ev.message_id) parts.push(ev.message_id);
  if (ev.ingest_kind) parts.push(ev.ingest_kind);
  if (ev.status && ev.status !== 'ok') parts.push(ev.status);
  return parts.join(' · ');
}

function eventCategory(ev) {
  const type = ev.event_type ?? ev.type ?? '';
  if (/failed|error|crashed|blocked|timeout|zombie/.test(type) || ev.status === 'failed') return 'error';
  if (type.startsWith('channel_') || type.startsWith('feishu_')) return 'channel';
  if (type.startsWith('task_') || type.includes('lease')) return 'task';
  if (type.startsWith('cycle_') || ev.cycle_id) return 'cycle';
  if (type.startsWith('worker_') || type.includes('health') || type === 'daemon_tick') return 'health';
  return 'system';
}

function shouldShowEventByDefault(ev) {
  const type = ev.event_type ?? ev.type ?? '';
  if (eventCategory(ev) === 'error') return true;
  if (type === 'daemon_tick' || type === 'task_lease_renewed') return false;
  return true;
}

function renderEventFeedHtml(events, limit = 20) {
  if (!events?.length) {
    return `<p class="feed-empty">${t('ops.eventsEmpty')}</p>`;
  }
  const filtered = events.filter(shouldShowEventByDefault);
  const visible = (filtered.length ? filtered : events).slice(0, limit);
  return visible.map((ev) => {
    const time = formatTimeShort(ev.recorded_at);
    const category = eventCategory(ev);
    const label = formatEventLabel(ev);
    const rawType = ev.event_type ?? ev.type ?? 'event';
    return `<div class="feed-row event-${category}">
      <span class="feed-time">${time}</span>
      <span class="feed-type">${escapeHtml(rawType)}</span>
      <span class="feed-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
}

function prependFeedEvent(ev, subject = activeSubject) {
  if (!ev?.event_type || !subject) return;
  if (!feedEventsBySubject[subject]) feedEventsBySubject[subject] = [];
  feedEventsBySubject[subject].unshift(ev);
  if (feedEventsBySubject[subject].length > 50) feedEventsBySubject[subject].length = 50;
  if (subject === activeSubject && viewMode === 'ops') scheduleRenderOpsHome();
}

function prependChannelEvent(ev, subject = activeSubject) {
  if (!ev || !subject) return;
  if (!channelEventsBySubject[subject]) channelEventsBySubject[subject] = [];
  channelEventsBySubject[subject].unshift(ev);
  if (channelEventsBySubject[subject].length > CHANNEL_EVENT_BUFFER) {
    channelEventsBySubject[subject].length = CHANNEL_EVENT_BUFFER;
  }
  if (subject === activeSubject) {
    pushChannelEventToFeed(ev);
    pulseChannelPipeline(ev);
  }
}

function formatEvolutionMode(mode) {
  return tDynamic('evolutionMode', mode, mode ?? 'unknown');
}

function formatHealthStatus(status) {
  return tDynamic('healthStatus', status, status ?? 'unknown');
}

function formatEvolutionModeSource(source) {
  return tDynamic('modeSource', source, source ?? '');
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
    const failed = daemon?.tasks?.counts?.failed ?? summary.failed_tasks ?? 0;
    const inPending = daemon?.channel?.inbound?.pending_count ?? summary.channel_inbound_pending ?? 0;
    const outPending = daemon?.channel?.outbox?.pending_count ?? summary.channel_outbox_pending ?? 0;
    const att = summary.attention
      ?? observabilityBySubject[summary.subject]?.attention?.summary
      ?? null;
    const mode = daemon?.evolution_mode ?? summary.evolution_mode ?? 'unknown';
    const activeSeverity = att?.highest_active_severity
      ?? (att?.active_count == null ? att?.highest_severity : null);
    const activeCount = att?.active_count ?? att?.count ?? 0;
    const historicalCount = att?.historical_count ?? 0;
    const attentionClass = activeSeverity ? ` has-attention attention-${activeSeverity}` : '';
    const attChip = activeCount > 0 && activeSeverity
      ? `<span class="daemon-chip attention-${activeSeverity}" title="${att.active_critical ?? att.critical ?? 0} ${t('severity.critical')} · ${att.active_warning ?? att.warning ?? 0} ${t('severity.warning')} · ${att.active_info ?? att.info ?? 0} ${t('severity.info')}">${t('kpi.attention')} ${activeCount}</span>`
      : historicalCount > 0
        ? `<span class="daemon-chip" title="${t('posture.historicalOnly', { count: historicalCount })}">${t('posture.historyAck', { count: historicalCount })}</span>`
      : '';
    return `
      <button type="button" class="daemon-card${active}${attentionClass}" data-subject="${summary.subject}" aria-pressed="${summary.subject === activeSubject}">
        <span class="daemon-card-title">${summary.subject}</span>
        <span class="daemon-card-meta">${summary.namespace ?? ''}</span>
        <span class="daemon-card-stats">
          <span class="daemon-chip health-${healthClass}">${escapeHtml(formatHealthStatus(healthClass))}</span>
          <span class="daemon-chip mode-${mode}">${escapeHtml(formatEvolutionMode(mode))}</span>
          <span class="daemon-chip worker-${workerOn ? 'on' : 'off'}">${workerOn ? t('channel.workerRunning') : t('channel.workerStopped')}</span>
          <span class="daemon-chip">open ${openCycles}</span>
          <span class="daemon-chip">Q ${pending}/${running}/${failed}</span>
          ${attChip}
          ${inPending || outPending ? `<span class="daemon-chip channel-attention">Ch ${inPending}/${outPending}</span>` : ''}
        </span>
      </button>
    `;
  }).join('');

  for (const btn of subjectOverviewEl.querySelectorAll('.daemon-card')) {
    btn.addEventListener('click', () => {
      const subject = btn.dataset.subject;
      if (subject && subject !== activeSubject) void setActiveSubject(subject, { preserveHash: false });
    });
  }
}

function mergeSubjectSummaries(nextSubjects = []) {
  const previous = new Map(subjectsList.map((subject) => [subject.subject, subject]));
  subjectsList = nextSubjects
    .filter((subject) => subject?.subject)
    .map((subject) => ({
      ...(previous.get(subject.subject) ?? {}),
      ...subject,
    }));
}

let opsHomeRenderTimer = null;
const OPS_HOME_DEBOUNCE_MS = 120;

function scheduleRenderOpsHome() {
  if (viewMode !== 'ops' || !activeSubject) return;
  if (opsHomeRenderTimer) clearTimeout(opsHomeRenderTimer);
  opsHomeRenderTimer = setTimeout(() => {
    opsHomeRenderTimer = null;
    renderOpsHome();
  }, OPS_HOME_DEBOUNCE_MS);
}

function collectAttentionItems() {
  const items = [...(getObservability()?.attention?.items ?? [])];
  const order = { critical: 0, warning: 1, info: 2 };
  return items
    .sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
    .slice(0, 24);
}

function renderAttentionBoardHtml(items) {
  if (!items.length) {
    return `<p class="card-empty">${t('ops.attentionEmpty')}</p>`;
  }
  const groupDefs = [
    { id: 'current', label: t('ops.currentAttention'), items: items.filter(isActiveBlockingAttention) },
    { id: 'history', label: t('ops.historyAttention'), items: items.filter((item) => item.category === 'history' || item.status === 'needs_ack') },
    { id: 'info', label: t('ops.infoAttention'), items: items.filter((item) => !isActiveBlockingAttention(item) && item.category !== 'history' && item.status !== 'needs_ack') },
  ];
  const groups = groupDefs
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)),
    }))
    .filter((group) => group.items.length);

  return `<div class="attention-board-groups">${groups.map((group) => `
    <section class="attention-group severity-${group.items[0]?.severity ?? 'info'}">
      <h4 class="attention-group-title">
        <span>${escapeHtml(group.label)} <span>${group.items.length}</span></span>
        ${group.id === 'history' && group.items.some(isAcknowledgeableAttention)
    ? `<button type="button" class="btn btn-sm" data-ack-all-attention="1" data-ack-subject="${escapeHtml(activeSubject ?? '')}">${t('ops.acknowledgeAll')}</button>`
    : ''}
      </h4>
      <ul class="attention-board-list">${group.items.map((item) => {
        const cycleId = item.refs?.cycle_id;
        const ackable = isAcknowledgeableAttention(item);
        const clickable = cycleId ? ' attention-item-clickable' : '';
        const dataAttrs = cycleId
          ? ` data-cycle-id="${escapeHtml(cycleId)}" data-subject="${escapeHtml(item.subject ?? activeSubject ?? '')}"`
          : '';
        const ackAttrs = ackable
          ? ` data-ack-attention="1" data-ack-kind="${escapeHtml(item.kind)}" data-ack-task-id="${escapeHtml(item.refs?.task_id ?? '')}" data-ack-subject="${escapeHtml(item.subject ?? activeSubject ?? '')}"`
          : '';
        return `
          <li class="attention-board-item severity-${item.severity ?? 'info'}${clickable}"${dataAttrs} role="${cycleId ? 'button' : 'listitem'}" tabindex="${cycleId ? '0' : '-1'}">
            <div class="attention-item-head">
              <span class="attention-severity">${tDynamic('severity', item.severity, item.severity)}</span>
              ${item.status === 'needs_ack' ? `<span class="attention-subject">${t('ops.needsAck')}</span>` : ''}
              ${isMultiSubject() && item.subject ? `<span class="attention-subject">${escapeHtml(item.subject)}</span>` : ''}
              <span class="attention-item-title">${escapeHtml(item.title)}</span>
            </div>
            ${item.summary ? `<p class="attention-summary">${escapeHtml(item.summary)}</p>` : ''}
            ${item.suggested_command ? `<code class="attention-cmd">${escapeHtml(item.suggested_command)}</code>` : ''}
            ${ackable ? `<button type="button" class="btn btn-sm" ${ackAttrs}>${t('ops.acknowledge')}</button>` : ''}
          </li>`;
      }).join('')}</ul>
    </section>`).join('')}</div>`;
}

function bindAttentionBoardClicks(root) {
  if (!root) return;
  for (const btn of root.querySelectorAll('[data-ack-all-attention]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const subject = btn.dataset.ackSubject || activeSubject;
      if (!subject) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = t('ops.acknowledgingAll');
      try {
        const res = await fetch(`${subjectApiBase(subject)}/attention/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        if (!res.ok) throw new Error(`ack all failed: ${res.status}`);
        await Promise.all([
          fetchDaemonForSubject(subject),
          fetchObservabilityForSubject(subject),
        ]);
        if (subject === activeSubject && viewMode === 'ops') renderOpsHome();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        console.warn(err);
      }
    });
  }
  for (const btn of root.querySelectorAll('[data-ack-attention]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const subject = btn.dataset.ackSubject || activeSubject;
      if (!subject) return;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = t('ops.acknowledging');
      try {
        const res = await fetch(`${subjectApiBase(subject)}/attention/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: btn.dataset.ackKind,
            task_id: btn.dataset.ackTaskId || null,
          }),
        });
        if (!res.ok) throw new Error(`ack failed: ${res.status}`);
        await Promise.all([
          fetchDaemonForSubject(subject),
          fetchObservabilityForSubject(subject),
        ]);
        if (subject === activeSubject && viewMode === 'ops') renderOpsHome();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = originalText;
        // Keep the button visible; the suggested command remains available for manual fallback.
        console.warn(err);
      }
    });
  }
  for (const el of root.querySelectorAll('.attention-item-clickable')) {
    el.addEventListener('click', () => {
      const cycleId = el.dataset.cycleId;
      const subject = el.dataset.subject || activeSubject;
      if (cycleId) navigateToCycle(cycleId, subject);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  }
}

function getActiveChannel() {
  return getDaemonState()?.channel ?? getObservability()?.channel_diagnostics ?? null;
}

function renderChannelSectionHtml() {
  const channel = getActiveChannel();
  if (!channel) {
    return `<section class="ops-card ops-card-span-2"><h3 class="ops-card-title">${t('channel.title')}</h3><p class="card-empty">${t('channel.notInitialized')}</p></section>`;
  }
  return `
    <section class="ops-card ops-card-span-2 ops-card-channel">
      <h3 class="ops-card-title">${t('channel.title')}</h3>
      <channel-pipeline id="channel-pipeline"></channel-pipeline>
      <div class="channel-grid">
        <presence-reactor id="presence-reactor"></presence-reactor>
        <channel-workers id="channel-workers"></channel-workers>
      </div>
      <channel-event-feed id="channel-event-feed"></channel-event-feed>
    </section>`;
}

function updateChannelComponents({ force = false } = {}) {
  const channel = getActiveChannel();
  if (!channel) return;
  const daemon = getDaemonState();
  const fp = channelPanelFingerprint(daemon ?? { channel });
  const changed = force || fp !== channelFpBySubject[activeSubject];
  channelFpBySubject[activeSubject] = fp;

  if (changed) {
    const pipeline = document.getElementById('channel-pipeline');
    if (pipeline) {
      pipeline.subject = activeSubject;
      pipeline.channel = channel;
    }
    const reactor = document.getElementById('presence-reactor');
    if (reactor) reactor.channel = channel;
    const workers = document.getElementById('channel-workers');
    if (workers) workers.channel = channel;
  }
  const feed = document.getElementById('channel-event-feed');
  if (feed) {
    const events = getChannelEvents();
    feed.events = events.length ? events : (channel.recent_events ?? []);
  }
}

function pushChannelEventToFeed(ev) {
  const feed = document.getElementById('channel-event-feed');
  if (feed && typeof feed.pushEvent === 'function') feed.pushEvent(ev);
}

function pulseChannelPipeline(ev) {
  const pipeline = document.getElementById('channel-pipeline');
  if (pipeline && typeof pipeline.pulse === 'function') pipeline.pulse(ev);
}

function renderOpenCyclesTableHtml() {
  const cycles = getDaemonState()?.cycles?.recent ?? getObservability()?.cycle_diagnostics?.recent ?? [];
  if (!cycles.length) {
    return `<p class="card-empty">${t('ops.openCyclesEmpty')}</p>`;
  }
  return `<table class="ops-table"><thead><tr><th>${t('ops.cycleHeader')}</th><th>${t('ops.statusHeader')}</th><th>${t('ops.stepsHeader')}</th><th></th></tr></thead><tbody>
    ${cycles.map((cycle) => {
      const stepsObj = {};
      for (const [name, status] of Object.entries(cycle.steps ?? {})) {
        stepsObj[name] = { status: typeof status === 'string' ? status : (status?.status ?? 'pending') };
      }
      return `<tr>
        <td><code>${escapeHtml(cycle.cycle_id)}</code></td>
        <td>${escapeHtml(cycle.status ?? 'open')}</td>
        <td>${renderStepBadges(stepsObj, { compact: true })}</td>
        <td><button type="button" class="btn btn-sm btn-primary" data-open-cycle="${escapeHtml(cycle.cycle_id)}">${t('common.open')}</button></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function renderOperatorBriefsHtml() {
  const inputs = getObservability()?.operator_inputs;
  const briefs = inputs?.recent ?? [];
  if (!briefs.length && !(inputs?.pending_count > 0)) {
    return `<p class="card-empty">${t('ops.briefsEmpty')}</p>`;
  }
  const header = `<p class="ops-card-meta">${t('ops.pendingCount', { count: inputs?.pending_count ?? 0 })}${inputs?.stale_pending_count ? t('ops.stalePending', { count: inputs.stale_pending_count }) : ''}</p>`;
  const list = briefs.length
    ? `<ul class="brief-list">${briefs.map((b) => `
      <li><span class="brief-kind">${escapeHtml(b.kind ?? '')}</span> ${escapeHtml(b.summary ?? '')}
        <span class="brief-age">${b.age_ms != null ? `${Math.round(b.age_ms / 60000)}m` : ''}</span></li>
    `).join('')}</ul>`
    : '';
  return header + list;
}

function renderOpsPostureHtml() {
  const daemon = getDaemonState();
  const obs = getObservability();
  if (!daemon) {
    return `<p class="card-empty">${t('meta.cannotConnect')}</p>`;
  }
  const cycles = daemon.cycles?.recent ?? [];
  const current = cycles[0] ?? null;
  const steps = current ? normalizeCycleSteps(current) : {};
  const activeStep = activeStepName(steps);
  const stuck = daemon.cycles?.stuck_steps ?? obs?.cycle_diagnostics?.stuck_steps ?? [];
  const drift = daemon.cycles?.drift_steps ?? obs?.cycle_diagnostics?.drift_steps ?? [];
  const pendingBriefs = obs?.operator_inputs?.pending_count ?? 0;
  const attention = obs?.attention?.summary ?? {};
  const suggestions = obs?.cycle_diagnostics?.health_suggestions ?? [];
  const subjectAttentionItems = obs?.attention?.items ?? [];
  const activeItems = subjectAttentionItems.filter(isActiveBlockingAttention);
  const historicalAttention = attention.historical_count
    ?? subjectAttentionItems.filter((item) => item.category === 'history' || item.status === 'needs_ack').length;
  const activeFailed = activeItems.filter((item) => item.kind === 'task_failed' || item.kind === 'channel_task_failed').length;

  let nextAction = t('posture.ok');
  let tone = 'ok';
  if (activeItems.some((item) => item.severity === 'critical')) {
    nextAction = t('posture.critical');
    tone = 'critical';
  } else if (stuck.length) {
    nextAction = t('posture.stuck', { step: stuck[0].step ?? '' });
    tone = 'critical';
  } else if (drift.length) {
    nextAction = t('posture.drift', { step: drift[0].step ?? '' });
    tone = 'warning';
  } else if (activeFailed) {
    nextAction = t('posture.failed');
    tone = 'warning';
  } else if (pendingBriefs) {
    nextAction = t('posture.pendingBriefs');
    tone = 'info';
  } else if (current && activeStep) {
    nextAction = t('posture.activeStep', { step: STEP_LABELS[activeStep] ?? activeStep });
    tone = stepStatus(steps, activeStep) === 'failed' ? 'warning' : 'info';
  } else if (historicalAttention) {
    nextAction = t('posture.historicalOnly', { count: historicalAttention });
    tone = 'info';
  } else if (suggestions.length) {
    nextAction = suggestions[0];
    tone = 'info';
  }

  return `
    <div class="posture-card posture-${tone}">
      <div class="posture-main">
        <span class="posture-label">${t('posture.label')}</span>
        <strong>${escapeHtml(nextAction)}</strong>
        <span class="posture-meta">${escapeHtml(activeSubject ?? '')} · ${escapeHtml(formatEvolutionMode(daemon.evolution_mode))} · ${t('posture.attentionLabel')} ${attentionPostureSummary(attention)}</span>
      </div>
      <div class="posture-facts">
        <span><strong>${daemon.cycles?.open_count ?? 0}</strong> ${t('posture.open')}</span>
        <span><strong>${current?.cycle_id ? escapeHtml(current.cycle_id) : t('common.dash')}</strong> ${t('posture.current')}</span>
        <span><strong>${activeStep ? escapeHtml(STEP_LABELS[activeStep] ?? activeStep) : t('common.dash')}</strong> ${t('posture.step')}</span>
        <span><strong>${stuck.length}/${drift.length}</strong> ${t('posture.stuckDrift')}</span>
      </div>
    </div>`;
}

function renderKpiStripHtml() {
  const daemon = getDaemonState();
  const obs = getObservability();
  if (!daemon) {
    return `<p class="card-empty">${t('meta.cannotConnect')}</p>`;
  }
  const health = daemon.health ?? {};
  const worker = daemon.worker ?? {};
  const counts = daemon.tasks?.counts ?? {};
  const att = obs?.attention?.summary ?? {};
  const activeAtt = {
    count: att.active_count ?? att.count ?? 0,
    critical: att.active_critical ?? att.critical ?? 0,
    warning: att.active_warning ?? att.warning ?? 0,
    info: att.active_info ?? att.info ?? 0,
  };
  const mode = daemon.evolution_mode;
  const modeLabel = mode ? formatEvolutionMode(mode) : t('common.dash');
  const cycles = daemon.cycles?.recent ?? [];
  const channel = daemon.channel ?? obs?.channel_diagnostics ?? {};
  const pendingSpeech = channel.presence?.pending_speech_generation?.length ?? 0;
  const channelIn = channel.inbound?.pending_count ?? channel.inbound_pending ?? 0;
  const channelOut = channel.outbox?.pending_count ?? channel.outbox_pending ?? 0;
  return `
    <div class="kpi-strip">
      <div class="kpi-card health-${health.status ?? 'unknown'}">
        <span class="kpi-label">${t('kpi.health')}</span>
        <span class="kpi-value">${escapeHtml(formatHealthStatus(health.status ?? 'unknown'))}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${t('kpi.worker')}</span>
        <span class="kpi-value">${worker.running ? t('common.running') : t('common.stopped')}${worker.stale ? ` · ${t('kpi.workerStale')}` : ''}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${t('kpi.openCycles')}</span>
        <span class="kpi-value">${daemon.cycles?.open_count ?? 0}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${t('kpi.queue')}</span>
        <span class="kpi-value">P ${counts.pending ?? 0} / R ${counts.running ?? 0} / F ${counts.failed ?? 0}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${t('kpi.runningStep')}</span>
        <span class="kpi-value">${escapeHtml(runningStepLabel(cycles))}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">${t('kpi.evolutionMode')}</span>
        <span class="kpi-value mode-${mode ?? 'unknown'}">${escapeHtml(modeLabel)}</span>
      </div>
      <div class="kpi-card${att.highest_active_severity ? ` severity-${att.highest_active_severity}` : ''}">
        <span class="kpi-label">${t('kpi.attention')}</span>
        <span class="kpi-value">${escapeHtml(attentionPostureSummary({ ...activeAtt, historical_count: att.historical_count ?? 0 }))}</span>
      </div>
      <div class="kpi-card${channelIn || channelOut || pendingSpeech ? ' severity-warning' : ''}">
        <span class="kpi-label">${t('kpi.channel')}</span>
        <span class="kpi-value">I ${channelIn} / O ${channelOut}${pendingSpeech ? ` / S ${pendingSpeech}` : ''}</span>
      </div>
    </div>`;
}

function renderOpsHome() {
  if (!opsHomeEl || viewMode !== 'ops') return;
  const daemon = getDaemonState();
  const items = collectAttentionItems();
  const manifest = getManifest();
  const latestRound = manifest?.rounds?.[0];

  opsHomeEl.innerHTML = `
    <div class="ops-home-inner">
      <div class="ops-home-header">
        <h2 class="ops-home-title">${t('app.opsTitle')}</h2>
        <p class="ops-home-subtitle">${t('app.opsSubtitle', { subject: activeSubject ?? '' })}</p>
      </div>
      ${renderKpiStripHtml()}
      ${renderOpsPostureHtml()}
      <div class="ops-grid">
        <section class="ops-card ops-card-span-2 ops-card-attention">
          <h3 class="ops-card-title">${t('ops.attention')} <span class="ops-badge">${items.length}</span></h3>
          ${renderAttentionBoardHtml(items)}
        </section>
        ${renderChannelSectionHtml()}
        <section class="ops-card">
          <h3 class="ops-card-title">${t('ops.openCycles')}</h3>
          ${renderOpenCyclesTableHtml()}
        </section>
        <section class="ops-card">
          <h3 class="ops-card-title">${t('ops.operatorBriefs')}</h3>
          ${renderOperatorBriefsHtml()}
        </section>
        <section class="ops-card ops-card-events">
          <h3 class="ops-card-title">${t('ops.recentEvents')}</h3>
          <div class="ops-event-feed">${renderEventFeedHtml(getFeedEvents(), 25)}</div>
        </section>
        ${latestRound ? `
        <section class="ops-card ops-card-quick">
          <h3 class="ops-card-title">${t('ops.latestRound')}</h3>
          <p class="ops-quick-line"><code>${escapeHtml(latestRound.cycle_id)}</code></p>
          <p class="ops-quick-tldr">${escapeHtml(truncate(latestRound.tldr, 160))}</p>
          <button type="button" class="btn btn-sm btn-primary" data-open-cycle="${escapeHtml(latestRound.cycle_id)}">${t('ops.readReport')}</button>
        </section>` : ''}
      </div>
    </div>`;

  updateChannelComponents({ force: true });
  bindAttentionBoardClicks(opsHomeEl);
  for (const btn of opsHomeEl.querySelectorAll('[data-open-cycle]')) {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-open-cycle');
      if (id) void selectById(id);
    });
  }

  const fp = getPanelFp();
  fp.opsHome = opsHomeFingerprint({
    daemon_fp: daemonBarFingerprint(daemon),
    obs_fp: observabilityFingerprint(getObservability()),
    feed_len: getFeedEvents().length,
    manifest_count: manifest?.rounds?.length ?? 0,
  });
}

function renderActiveCycles() {
  if (!activeCyclesEl) return;
  const cycles = getDaemonState()?.cycles?.recent ?? [];
  if (!cycles.length) {
    activeCyclesEl.innerHTML = `<p class="feed-empty">${t('ops.openCyclesEmpty')}</p>`;
    return;
  }

  activeCyclesEl.innerHTML = '';
  for (const cycle of cycles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const classes = ['round-btn', 'cycle-active'];
    if (cycle.cycle_id === activeCycleId && viewMode === 'reading') classes.push('active');
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
    panelFpBySubject[subject] = { cycles: '', opsHome: '' };
  }
  observabilityBySubject[subject] = next;
  if (subject === activeSubject) scheduleRenderOpsHome();
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
    panelFpBySubject[subject] = { cycles: '', opsHome: '' };
  }
  const fp = panelFpBySubject[subject];
  const cyclesFp = activeCyclesFingerprint(next);
  const cyclesChanged = cyclesFp !== fp.cycles;

  daemonBySubject[subject] = next;
  if (subject === activeSubject) {
    if (cyclesChanged) {
      fp.cycles = cyclesFp;
      renderActiveCycles();
    }
    scheduleRenderOpsHome();
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
  if (fp) fp.opsHome = '';
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

async function loadChannelEvents(subject = activeSubject) {
  if (!subject) return;
  try {
    const res = await fetch(`${subjectApiBase(subject)}/channel/events?limit=${CHANNEL_EVENT_BUFFER}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    channelEventsBySubject[subject] = data.events ?? [];
    if (subject === activeSubject && viewMode === 'ops') updateChannelComponents();
  } catch {
    // ignore
  }
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
    if (round.cycle_id === activeCycleId && viewMode === 'reading') classes.push('active');
    if (newCycleIds.has(round.cycle_id)) classes.push('is-new');
    btn.className = classes.join(' ');
    btn.dataset.cycleId = round.cycle_id;
    btn.innerHTML = `
      <span class="cycle-id">${round.cycle_id}${newCycleIds.has(round.cycle_id) ? ` <span class="new-tag">${t('timeline.newTag')}</span>` : ''}</span>
      <span class="when">${formatWhen(round.generated_at)}</span>
      ${round.tldr ? `<span class="tldr">${truncate(round.tldr)}</span>` : ''}
      <span class="badge ${round.has_diary ? '' : 'none'}">${round.has_diary ? t('timeline.hasDiary') : t('timeline.noDiary')}</span>
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
  if (!res.ok) throw new Error(t('errors.loadManifest', { subject }));
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
  if (subject === activeSubject) {
    updateMeta();
    if (viewMode === 'ops') scheduleRenderOpsHome();
  }
  return next;
}

async function loadRecentEvents(subject = activeSubject) {
  try {
    const res = await fetch(`${subjectApiBase(subject)}/events/recent?limit=30`);
    if (!res.ok) return;
    const data = await res.json();
    feedEventsBySubject[subject] = data.events ?? [];
    if (subject === activeSubject && viewMode === 'ops') scheduleRenderOpsHome();
  } catch {
    // ignore
  }
}

async function loadRoundDetail(cycleId, subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/rounds/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(t('errors.loadRound', { status: res.status }));
  return res.json();
}

async function loadCycleDetail(cycleId, subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/cycles/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(t('errors.loadCycle', { status: res.status }));
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
    .filter((tk) => tk.cycle_id === data.cycle_id || !tk.cycle_id)
    .slice(0, 5);
  const suggestions = obs?.cycle_diagnostics?.health_suggestions ?? [];

  const parts = [];
  if (stuck.length) {
    parts.push(`<div class="diag-block diag-critical"><strong>${t('cycle.stuckStep')}</strong><ul>${stuck.map((s) => `
      <li><code>${escapeHtml(s.step)}</code> — ${escapeHtml(s.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (drift.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>${t('cycle.driftStep')}</strong><ul>${drift.map((d) => `
      <li><code>${escapeHtml(d.step)}</code> — ${escapeHtml(d.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (attention.length) {
    parts.push(`<div class="diag-block"><strong>${t('cycle.cycleAttention')}</strong><ul>${attention.map((a) => `
      <li class="severity-${a.severity}">${escapeHtml(a.title)}: ${escapeHtml(a.summary)}</li>
    `).join('')}</ul></div>`);
  }
  if (failedTasks.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>${t('cycle.failedTasks')}</strong><ul>${failedTasks.map((tk) => `
      <li><code>${escapeHtml(tk.task_id)}</code> ${escapeHtml(tk.type)} — ${escapeHtml(tk.last_error_code ?? tk.last_error ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (suggestions.length) {
    parts.push(`<div class="diag-block"><strong>${t('cycle.suggestions')}</strong><ul>${suggestions.slice(0, 3).map((s) => `
      <li><code>${escapeHtml(s)}</code></li>
    `).join('')}</ul></div>`);
  }

  if (!parts.length) return null;

  section.innerHTML = `<h3>${t('cycle.diagnosticsTitle')}</h3>${parts.join('')}`;
  return section;
}

function readerOpsMetrics(data) {
  const diag = data.diagnostics ?? {};
  const tasks = data.tasks ?? [];
  const attention = data.observability_attention ?? [];
  const obs = getObservability();
  const failedGlobal = (obs?.cycle_diagnostics?.failed_tasks ?? [])
    .filter((tk) => tk.cycle_id === data.cycle_id || !tk.cycle_id);
  const stuck = diag.stuck_steps?.length ?? 0;
  const drift = diag.drift_steps?.length ?? 0;
  const failed = tasks.filter((tk) => tk.status === 'failed').length + failedGlobal.length;
  return {
    stuck,
    drift,
    attention: attention.length,
    tasks: tasks.length,
    failed,
    suggestions: obs?.cycle_diagnostics?.health_suggestions?.length ?? 0,
  };
}

function readerOpsSummaryBadges(data) {
  const m = readerOpsMetrics(data);
  const parts = [];
  if (m.stuck) parts.push(t('cycle.opsStuck', { count: m.stuck }));
  if (m.drift) parts.push(t('cycle.opsDrift', { count: m.drift }));
  if (m.attention) parts.push(t('cycle.opsAttention', { count: m.attention }));
  if (m.failed) parts.push(t('cycle.opsFailed', { count: m.failed }));
  else if (m.tasks) parts.push(t('cycle.opsTasks', { count: m.tasks }));
  return parts.join(' · ');
}

function readerOpsHasIssue(data) {
  const m = readerOpsMetrics(data);
  return m.stuck + m.drift + m.attention + m.failed + m.suggestions > 0;
}

function buildReaderOpsPanel(data) {
  const diagPanel = buildCycleDiagnosticsPanel(data);
  const tasksPanel = data.tasks?.length
    ? buildTasksPanelElement(data.tasks, { compact: true })
    : null;
  if (!diagPanel && !tasksPanel) return null;

  const details = document.createElement('details');
  details.className = 'reader-ops-panel';
  details.open = readerOpsHasIssue(data);

  const summary = document.createElement('summary');
  summary.className = 'reader-ops-summary';
  summary.innerHTML = `
    <span class="reader-ops-title">${t('cycle.opsInfo')}</span>
    <span class="reader-ops-badges">${escapeHtml(readerOpsSummaryBadges(data))}</span>
  `;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'reader-ops-body';
  if (diagPanel) body.appendChild(diagPanel);
  if (tasksPanel) body.appendChild(tasksPanel);
  details.appendChild(body);
  return details;
}

function buildTasksPanelElement(tasks, { compact = false } = {}) {
  const section = document.createElement('section');
  section.className = 'panel tasks-panel';
  if (!tasks?.length) {
    section.innerHTML = `<h3>${t('cycle.daemonTasks')}</h3><p class="reader-ops-empty">${t('cycle.tasksEmpty')}</p>`;
    return section;
  }
  if (compact) {
    section.innerHTML = `
      <h3>${t('cycle.daemonTasks')}</h3>
      <ul class="reader-task-list">${tasks.map((tk) => `
        <li class="reader-task-item status-${String(tk.status ?? 'unknown').replace(/[^a-z0-9_-]/gi, '')}">
          <div class="reader-task-head">
            <span class="reader-task-type">${escapeHtml(tk.type)}</span>
            <span class="reader-task-status">${escapeHtml(tk.status)}</span>
          </div>
          <code class="reader-task-id">${escapeHtml(tk.task_id)}</code>
          ${tk.last_error || tk.last_error_code
            ? `<p class="reader-task-error">${escapeHtml(tk.last_error_code ?? tk.last_error ?? '')}</p>`
            : ''}
        </li>
      `).join('')}</ul>
    `;
    return section;
  }
  section.innerHTML = `
    <h3>${t('cycle.daemonTasks')}</h3>
    <table class="tasks-table">
      <thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
      <tbody>${(tasks ?? []).map((tk) => `
        <tr class="${tk.status === 'failed' ? 'task-row-failed' : ''}">
          <td><code>${escapeHtml(tk.task_id)}</code></td>
          <td>${escapeHtml(tk.type)}</td>
          <td>${escapeHtml(tk.status)}</td>
          <td>${tk.attempts ?? 0}</td>
          <td>${escapeHtml(tk.last_error_code ?? tk.last_error ?? '')}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
  return section;
}

function manifestTldr(cycleId) {
  const round = getManifest()?.rounds?.find((r) => r.cycle_id === cycleId);
  return round?.tldr ?? '';
}

function renderCycleProgressRail(data) {
  const steps = data.steps ?? {};
  const stuckSteps = new Set((data.diagnostics?.stuck_steps ?? []).map((s) => s.step));
  const driftSteps = new Set((data.diagnostics?.drift_steps ?? []).map((s) => s.step));
  const activeName = activeStepName(steps);
  const nodes = STEP_ORDER
    .filter((name) => steps[name] || data.cycle_status)
    .map((name) => {
      const status = stepStatus(steps, name);
      const flags = [
        stuckSteps.has(name) ? 'stuck' : '',
        driftSteps.has(name) ? 'drift' : '',
        activeName === name ? 'active' : '',
      ].filter(Boolean);
      const flagText = flags.filter((f) => f !== 'active').join(' / ');
      return `<div class="progress-step step-${status}${flags.map((f) => ` is-${f}`).join('')}">
        <span class="progress-step-dot"></span>
        <span class="progress-step-label">${escapeHtml(STEP_LABELS[name] ?? name)}</span>
        <span class="progress-step-status">${escapeHtml(STEP_STATUS_LABELS[status] ?? status)}</span>
        ${flagText ? `<span class="progress-step-flag">${escapeHtml(flagText)}</span>` : ''}
      </div>`;
    });
  if (!nodes.length) return t('common.dash');
  return `<div class="cycle-progress-rail" aria-label="${t('detail.progressAriaLabel')}">${nodes.join('')}</div>`;
}

function renderCycleSummaryHtml(data, mode = 'round') {
  const diaries = data.diaries ?? [];
  const tasks = data.tasks ?? [];
  const failed = failedTaskCount(tasks);
  const stuck = data.diagnostics?.stuck_steps?.length ?? 0;
  const drift = data.diagnostics?.drift_steps?.length ?? 0;
  const attention = data.observability_attention?.length ?? 0;
  const tldr = data.tldr ?? manifestTldr(data.cycle_id);
  const latestDiary = diaries[0]?.exec_id ?? '';
  const hasReport = Boolean(data.has_report ?? data.report_html);
  const summary = tldr || t('cycle.summaryFallback', {
    mode,
    report: hasReport ? t('common.yes') : t('common.no'),
    diary: diaries.length,
  });

  return `<section class="cycle-summary-card">
    <div class="cycle-summary-main">
      <span class="cycle-summary-label">${t('cycle.summaryLabel')}</span>
      <strong>${escapeHtml(truncate(summary, 220))}</strong>
      <span class="cycle-summary-meta">${escapeHtml(data.cycle_id ?? '')}${data.cycle_status ? ` · ${escapeHtml(data.cycle_status)}` : ''}</span>
    </div>
    <div class="cycle-summary-facts">
      <span><strong>${hasReport ? t('common.yes') : t('common.no')}</strong> ${t('cycle.report')}</span>
      <span><strong>${diaries.length}</strong> ${t('cycle.diaries')}</span>
      <span><strong>${failed}</strong> ${t('cycle.failedTasksShort')}</span>
      <span><strong>${stuck}/${drift}</strong> ${t('cycle.stuckDrift')}</span>
      <span><strong>${attention}</strong> ${t('cycle.attention')}</span>
      ${latestDiary ? `<span><strong>${escapeHtml(latestDiary)}</strong> ${t('cycle.latestDiary')}</span>` : ''}
    </div>
  </section>`;
}

function patchDetailHeader(data) {
  const header = detailEl.querySelector('.detail-header');
  if (!header) return;

  updateReaderNav({
    cycleId: data.cycle_id ?? activeCycleId ?? '',
    meta: data.cycle_status ?? '',
  });

  const statusTag = header.querySelector('.cycle-status-tag');
  if (statusTag) statusTag.remove();

  if (data.steps) {
    let stepsWrap = header.querySelector('.detail-steps');
    if (!stepsWrap) {
      stepsWrap = document.createElement('div');
      stepsWrap.className = 'detail-steps';
      header.appendChild(stepsWrap);
    }
    stepsWrap.innerHTML = renderStepBadges(data.steps);
  }

  const progress = detailEl.querySelector('.cycle-progress-rail');
  if (progress) progress.outerHTML = renderCycleProgressRail(data);
  const summary = detailEl.querySelector('.cycle-summary-card');
  if (summary) summary.outerHTML = renderCycleSummaryHtml(data, activeViewMode ?? 'round');
}

function patchReaderOpsPanel(data) {
  if (activeViewMode !== 'cycle') return;
  const existing = detailEl.querySelector('.reader-ops-panel');
  const next = buildReaderOpsPanel(data);
  if (next) {
    if (existing) {
      next.open = existing.open;
      existing.replaceWith(next);
    } else {
      detailEl.querySelector('.panels')?.before(next);
    }
  } else if (existing) {
    existing.remove();
  }
}

function patchDetailReportContent(data) {
  const reportContent = detailEl.querySelector('.panel.report .content');
  if (!reportContent) return;
  reportContent.innerHTML = data.report_html ?? `<p class="missing">${t('detail.noReport')}</p>`;
}

function patchDetailDiaryContent(data) {
  const diaryContent = detailEl.querySelector('.panel.diary .content');
  if (!diaryContent) return;
  const diaries = data.diaries ?? [];
  if (!diaries.length) {
    diaryContent.innerHTML = `<p class="missing">${t('detail.noDiaryThisRound')}</p>`;
    return;
  }
  diaryContent.innerHTML = diaries[0]?.html ?? `<p class="missing">${t('detail.noDiaryContent')}</p>`;
}

function patchDetailDom(data, mode, needs) {
  if (needs.header || needs.tasks || needs.diary) patchDetailHeader(data);
  if (needs.report) patchDetailReportContent(data);
  if (mode === 'cycle' && (needs.header || needs.tasks)) patchReaderOpsPanel(data);
  if (needs.diary) patchDetailDiaryContent(data);
}

async function patchActiveDetailIfNeeded() {
  if (!activeCycleId || !activeViewMode || !activeSubject) return;

  try {
    const data = activeViewMode === 'cycle'
      ? await loadCycleDetail(activeCycleId)
      : await loadRoundDetail(activeCycleId);

    const needs = detailCacheNeedsPatch(activeDetailCache, data, activeViewMode);
    if (!needs.header && !needs.report && !needs.tasks && !needs.diary) return;

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
  updateReaderNav({
    cycleId: data.cycle_id,
    meta: data.cycle_status ?? '',
  });
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
    label.textContent = t('detail.diaryLabel');
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
    span.innerHTML = `<label>${t('detail.diaryLabel')}</label> <code>${diaries[0].exec_id}</code>`;
    header.appendChild(span);
  }

  const progressWrap = document.createElement('div');
  progressWrap.innerHTML = renderCycleProgressRail(data);
  const progressRail = progressWrap.firstElementChild;

  const summaryWrap = document.createElement('div');
  summaryWrap.innerHTML = renderCycleSummaryHtml(data, mode);
  const summaryCard = summaryWrap.firstElementChild;

  const panels = document.createElement('div');
  panels.className = 'panels';

  const reportPanel = document.createElement('section');
  reportPanel.className = 'panel report';
  reportPanel.innerHTML = `<h3>${t('detail.reportTitle')}</h3>`;
  const reportContent = document.createElement('div');
  reportContent.className = 'content';
  reportContent.innerHTML = data.report_html ?? `<p class="missing">${t('detail.noReport')}</p>`;
  reportPanel.appendChild(reportContent);

  const diaryPanel = document.createElement('section');
  diaryPanel.className = 'panel diary';
  diaryPanel.innerHTML = `<h3>${t('detail.diaryTitle')}</h3>`;
  const diaryContent = document.createElement('div');
  diaryContent.className = 'content';
  diaryPanel.appendChild(diaryContent);

  function updateDiaryPanel() {
    if (!diaries.length) {
      diaryContent.innerHTML = `<p class="missing">${t('detail.noDiaryThisRound')}</p>`;
      return;
    }
    diaryContent.innerHTML = diaries[diaryIndex]?.html ?? `<p class="missing">${t('detail.noDiaryContent')}</p>`;
  }
  updateDiaryPanel();

  panels.append(reportPanel, diaryPanel);

  const opsPanel = mode === 'cycle' ? buildReaderOpsPanel(data) : null;

  detailEl.replaceChildren(
    header,
    ...(progressRail ? [progressRail] : []),
    summaryCard,
    ...(opsPanel ? [opsPanel] : []),
    panels,
  );

  activeDetailCache = buildDetailCacheFromData(data, mode);
}

async function selectCycle(cycleId, { scrollTimeline = false } = {}) {
  setViewMode('reading');
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
  updateReaderNav({ cycleId, loading: true });
  detailEl.innerHTML = `<p class="placeholder">${t('common.loading')}</p>`;
  try {
    const data = await loadCycleDetail(cycleId);
    renderDetail(data, { mode: 'cycle' });
  } catch (err) {
    activeDetailCache = null;
    updateReaderNav({ cycleId, meta: err.message });
    detailEl.innerHTML = `<p class="missing">${escapeHtml(err.message)}</p>`;
  }
}

async function selectRound(cycleId, { scrollTimeline = false } = {}) {
  setViewMode('reading');
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
  updateReaderNav({ cycleId, loading: true });
  detailEl.innerHTML = `<p class="placeholder">${t('common.loading')}</p>`;
  try {
    const data = await loadRoundDetail(cycleId);
    renderDetail(data, { mode: 'round' });
  } catch (err) {
    activeDetailCache = null;
    updateReaderNav({ cycleId, meta: err.message });
    detailEl.innerHTML = `<p class="missing">${escapeHtml(err.message)}</p>`;
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
    setLiveStatus('live.connected', null, 'connected');
    if (payload.default_subject) defaultSubject = payload.default_subject;
    if (Array.isArray(payload.subjects) && payload.subjects.length) {
      mergeSubjectSummaries(payload.subjects);
    }
    if (!activeSubject && defaultSubject) {
      void setActiveSubject(subjectFromQuery() || defaultSubject, { skipQueryUpdate: true });
    }
    updateMeta(t('live.updated'));
    return;
  }
  if (event === 'ping') return;
  if (event === 'error') {
    setLiveStatus('live.error', { message: payload.message ?? 'unknown' }, 'error');
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
  if (event === 'channel_event') {
    prependChannelEvent(payload, subject);
    scheduleLoadDaemon(subject);
    scheduleLoadObservability(subject);
    return;
  }
  if (event === 'runtime_updated') {
    scheduleLoadDaemon(subject);
    scheduleLoadObservability(subject);
    return;
  }
  if (event === 'round_added') {
    setLiveStatus('live.connected', null, 'connected');
    if (subject === activeSubject) {
      void loadManifest(subject).then(() => {
        renderTimeline(filterEl.value);
        updateMeta(t('live.updated'));
        if (viewMode === 'ops') scheduleRenderOpsHome();
      });
    } else {
      void loadManifest(subject);
    }
    return;
  }
  if (event === 'round_updated') {
    setLiveStatus('live.connected', null, 'connected');
    scheduleLoadDaemon(subject);
    if (payload.has_diary) {
      patchManifestRound(payload.cycle_id, { has_diary: true }, subject);
      if (subject === activeSubject) renderTimeline(filterEl.value);
    }
    if (subject === activeSubject && viewMode === 'ops') scheduleRenderOpsHome();
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
  setLiveStatus('live.disconnected', { seconds: Math.round(reconnectDelayMs / 1000) }, 'disconnected');
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
    setLiveStatus('live.unavailable', null, 'error');
    return;
  }

  for (const name of [
    'hello', 'round_added', 'round_updated', 'daemon_event', 'channel_event', 'runtime_updated', 'error',
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
    setLiveStatus('live.connecting', null, 'connecting');
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
  if (!res.ok) throw new Error(t('errors.loadSubjects'));
  const data = await res.json();
  defaultSubject = data.default_subject;
  mergeSubjectSummaries(data.subjects ?? []);
  return data;
}

async function refreshActiveSubjectPanels() {
  if (!activeSubject) return;
  panelFpBySubject[activeSubject] = { cycles: '', opsHome: '' };
  await loadManifest(activeSubject);
  await Promise.all([
    loadDaemon(activeSubject),
    loadObservability(activeSubject),
  ]);
  await loadRecentEvents(activeSubject);
  await loadChannelEvents(activeSubject);
  renderTimeline(filterEl?.value ?? '');
  renderActiveCycles();
  renderSubjectOverview();
  updateMeta('');
  if (viewMode === 'ops') renderOpsHome();
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
    goToOpsHome();
  }
}

async function init() {
  applyStaticI18n();
  renderLocaleSwitch();
  applyLiveStatus();
  onLocaleChange(() => rerenderAll());

  try {
    await loadSubjectsIndex();
  } catch {
    metaEl.textContent = t('meta.cannotConnect');
    return;
  }

  const querySubject = subjectFromQuery();
  const initialSubject = querySubject && subjectsList.some((s) => s.subject === querySubject)
    ? querySubject
    : defaultSubject;

  for (const s of subjectsList) {
    seenCycleIdsBySubject[s.subject] = new Set();
    newCycleIdsBySubject[s.subject] = new Set();
    panelFpBySubject[s.subject] = { cycles: '', opsHome: '' };
  }

  setViewMode(resolveViewMode(cycleFromHash(), null));
  if (backToOpsBtn) {
    backToOpsBtn.addEventListener('click', () => goToOpsHome());
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

  filterEl?.addEventListener('input', () => renderTimeline(filterEl.value));
  window.addEventListener('hashchange', () => {
    const id = cycleFromHash();
    if (!id) {
      if (viewMode === 'reading') goToOpsHome();
      return;
    }
    if (id !== activeCycleId) void selectById(id);
  });

  connectLive();
}

init();
