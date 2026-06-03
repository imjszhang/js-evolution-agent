import {
  PATCH_WORTHY_DAEMON_EVENTS,
  activeCyclesFingerprint,
  buildDetailCacheFromData,
  daemonBarFingerprint,
  detailCacheNeedsPatch,
  observabilityFingerprint,
  opsHomeFingerprint,
  resolveViewMode,
} from './live-state.js';

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
/** @type {Record<string, { cycles: string, opsHome: string }>} */
const panelFpBySubject = {};

/** @type {'ops'|'reading'} */
let viewMode = 'ops';

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

const CHANNEL_ROLES = ['notify', 'control', 'presence', 'speech', 'classifier'];

const EVENT_LABELS = {
  worker_started: 'Worker \u542f\u52a8',
  worker_stopped: 'Worker \u505c\u6b62',
  worker_start_failed: 'Worker \u542f\u52a8\u5931\u8d25',
  daemon_tick: '\u5fc3\u8df3 tick',
  cycle_due: '\u5230\u70b9 cycle',
  cycle_step_enqueued: '\u6b65\u9aa4\u5165\u961f',
  cycle_event_dispatched: '\u4e8b\u4ef6\u5206\u53d1',
  cycle_step_completed: '\u6b65\u9aa4\u5b8c\u6210',
  cycle_reconciled: 'Reconcile',
  cycle_abandoned: 'Cycle \u653e\u5f03',
  task_enqueued: '\u4efb\u52a1\u5165\u961f',
  task_claimed: '\u4efb\u52a1\u9886\u53d6',
  task_completed: '\u4efb\u52a1\u5b8c\u6210',
  task_failed: '\u4efb\u52a1\u5931\u8d25',
  task_lease_renewed: '\u79df\u7ea6\u7eed\u671f',
  task_lease_renew_failed: '\u79df\u7ea6\u7eed\u671f\u5931\u8d25',
  stale_lease_reclaimed: '\u8fc7\u671f\u79df\u7ea6\u56de\u6536',
  evolution_mode_changed: '\u6f14\u5316\u6a21\u5f0f\u53d8\u66f4',
  cycle_start_requested: '\u5f00\u8f6e\u8bf7\u6c42\u5165\u961f',
  cycle_start_consumed: '\u5f00\u8f6e\u8bf7\u6c42\u5df2\u6d88\u8d39',
  cycle_start_deferred: '\u5f00\u8f6e\u8bf7\u6c42\u6682\u7f13',
};

const CHANNEL_EVENT_LABELS = {
  channel_worker_started: 'Channel Worker \u542f\u52a8',
  channel_worker_stop_requested: 'Channel Worker \u505c\u6b62\u8bf7\u6c42',
  channel_tick: 'Channel tick',
  channel_task_enqueued: 'Channel \u4efb\u52a1\u5165\u961f',
  channel_task_claimed: 'Channel \u4efb\u52a1\u9886\u53d6',
  channel_task_completed: 'Channel \u4efb\u52a1\u5b8c\u6210',
  channel_inbound_completed: '\u5165\u7ad9\u8f6e\u8be2\u5b8c\u6210',
  channel_message_ingested: '\u6d88\u606f\u5df2\u5206\u7c7b\u5165\u5e93',
  channel_message_ingest_failed: '\u6d88\u606f\u5206\u7c7b\u5931\u8d25',
  channel_expression_recompute_requested: '\u8868\u8fbe\u91cd\u7b97\u8bf7\u6c42',
  channel_expression_planned: '\u8868\u8fbe\u8ba1\u5212',
  channel_expression_noop: '\u8868\u8fbe\u65e0\u52a8\u4f5c',
  channel_expression_silenced: '\u8868\u8fbe\u6c89\u9ed8',
  channel_presence_completed: 'Presence \u5b8c\u6210',
  channel_presence_timeout: 'Presence \u8d85\u65f6',
  channel_speech_generated: '\u8bdd\u672f\u5df2\u751f\u6210',
  channel_speech_generation_failed: '\u8bdd\u672f\u751f\u6210\u5931\u8d25',
  channel_deprecated_tasks_purged: '\u5e9f\u5f03\u4efb\u52a1\u5df2\u6e05\u9664',
  channel_message_sent: '\u6d88\u606f\u5df2\u53d1\u9001',
  channel_message_send_failed: '\u6d88\u606f\u53d1\u9001\u5931\u8d25',
  channel_message_received: 'Channel \u6536\u5230\u6d88\u606f',
  feishu_listener_started: 'Feishu \u76d1\u542c\u542f\u52a8',
  feishu_listener_stopped: 'Feishu \u76d1\u542c\u505c\u6b62',
  feishu_listener_connected: 'Feishu \u5df2\u8fde\u63a5',
  feishu_listener_disconnected: 'Feishu \u5df2\u65ad\u5f00',
  feishu_listener_start_failed: 'Feishu \u76d1\u542c\u542f\u52a8\u5931\u8d25',
};

const EVOLUTION_MODE_LABELS = {
  continuous: '\u6301\u7eed',
  on_demand: '\u6309\u9700',
};

const EVOLUTION_MODE_SOURCE_LABELS = {
  'runtime-registry.json': 'runtime/subjects/registry.json',
  'subjects.json': 'subjects.json',
  cli: 'CLI \u542f\u52a8\u53c2\u6570',
  env: '\u73af\u5883\u53d8\u91cf',
  default: '\u9ed8\u8ba4',
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
  if (!activeSubject) return { cycles: '', opsHome: '' };
  if (!panelFpBySubject[activeSubject]) {
    panelFpBySubject[activeSubject] = { cycles: '', opsHome: '' };
  }
  return panelFpBySubject[activeSubject];
}

function updateReaderNav({ cycleId = '', meta = '', loading = false } = {}) {
  if (readerNavCycleEl) {
    readerNavCycleEl.textContent = cycleId || (loading ? '\u2026' : '');
  }
  if (readerNavMetaEl) {
    const text = loading ? '\u52a0\u8f7d\u4e2d\u2026' : meta;
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

const ATTENTION_SEVERITY_LABELS = {
  critical: '\u4e25\u91cd',
  warning: '\u8b66\u544a',
  info: '\u63d0\u793a',
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
  if (!iso) return '\u2014';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function formatTimeShort(iso) {
  if (!iso) return '\u2014';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function escapeHtml(text) {
  if (text == null) return '\u2014';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\u2026`;
}

function updateMeta(extra = '') {
  const manifest = getManifest();
  if (!manifest) return;
  const parts = [
    manifest.subject,
    manifest.namespace,
    `\u5171 ${manifest.round_count ?? manifest.rounds?.length ?? 0} \u8f6e`,
    manifest.built_at ? `\u66f4\u65b0\u4e8e ${formatWhen(manifest.built_at)}` : '',
    isMultiSubject() ? `${subjectsList.length} \u4e2a subject` : '',
    extra,
  ].filter(Boolean);
  metaEl.textContent = parts.join(' \u00b7 ');
}

function setLiveStatus(text, state = '') {
  if (!liveStatusEl) return;
  liveStatusEl.textContent = text;
  liveStatusEl.className = `live-status${state ? ` ${state}` : ''}`;
}

function renderStepBadges(steps, { compact = false } = {}) {
  if (!steps || typeof steps !== 'object') return '\u2014';
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
  if (!items.length) return '\u2014';
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
  return '\u2014';
}

function failedTaskCount(tasks) {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => t.status === 'failed').length;
}

function severitySummary(summary = {}) {
  if (!summary.count) return '0';
  const parts = [];
  if (summary.critical) parts.push(`${summary.critical} \u4e25\u91cd`);
  if (summary.warning) parts.push(`${summary.warning} \u8b66\u544a`);
  if (summary.info) parts.push(`${summary.info} \u63d0\u793a`);
  return parts.length ? parts.join(' / ') : String(summary.count);
}

function formatEventLabel(ev) {
  const base = EVENT_LABELS[ev.event_type] ?? ev.event_type;
  if (ev.event_type === 'evolution_mode_changed' && ev.from && ev.to) {
    return `${base}: ${formatEvolutionMode(ev.from)} \u2192 ${formatEvolutionMode(ev.to)}`;
  }
  const parts = [base];
  if (ev.task_type || ev.step_type) parts.push(ev.task_type ?? ev.step_type);
  if (ev.cycle_id) parts.push(ev.cycle_id);
  return parts.join(' \u00b7 ');
}

function formatChannelEventLabel(ev) {
  const type = ev.type ?? ev.event_type;
  const base = CHANNEL_EVENT_LABELS[type] ?? type ?? 'channel';
  const parts = [base];
  if (ev.task_type) parts.push(ev.task_type);
  if (ev.message_id) parts.push(ev.message_id);
  if (ev.ingest_kind) parts.push(ev.ingest_kind);
  if (ev.status && ev.status !== 'ok') parts.push(ev.status);
  return parts.join(' \u00b7 ');
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
    return '<p class="feed-empty">\u6682\u65e0 daemon \u4e8b\u4ef6</p>';
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
    const failed = daemon?.tasks?.counts?.failed ?? summary.failed_tasks ?? 0;
    const inPending = daemon?.channel?.inbound?.pending_count ?? summary.channel_inbound_pending ?? 0;
    const outPending = daemon?.channel?.outbox?.pending_count ?? summary.channel_outbox_pending ?? 0;
    const att = summary.attention
      ?? observabilityBySubject[summary.subject]?.attention?.summary
      ?? null;
    const mode = daemon?.evolution_mode ?? summary.evolution_mode ?? 'unknown';
    const attentionClass = att?.highest_severity ? ` has-attention attention-${att.highest_severity}` : '';
    const attChip = att?.count > 0 && att.highest_severity
      ? `<span class="daemon-chip attention-${att.highest_severity}" title="${att.critical ?? 0} \u4e25\u91cd \u00b7 ${att.warning ?? 0} \u8b66\u544a \u00b7 ${att.info ?? 0} \u63d0\u793a">\u5f85\u5173\u6ce8 ${att.count}</span>`
      : '';
    return `
      <button type="button" class="daemon-card${active}${attentionClass}" data-subject="${summary.subject}" aria-pressed="${summary.subject === activeSubject}">
        <span class="daemon-card-title">${summary.subject}</span>
        <span class="daemon-card-meta">${summary.namespace ?? ''}</span>
        <span class="daemon-card-stats">
          <span class="daemon-chip health-${healthClass}">${healthClass}</span>
          <span class="daemon-chip mode-${mode}">${escapeHtml(formatEvolutionMode(mode))}</span>
          <span class="daemon-chip worker-${workerOn ? 'on' : 'off'}">${workerOn ? 'Worker \u8fd0\u884c' : 'Worker \u505c\u6b62'}</span>
          <span class="daemon-chip">open ${openCycles}</span>
          <span class="daemon-chip${failed ? ' attention-warning' : ''}">Q ${pending}/${running}/${failed}</span>
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

function renderAttentionBoardHtml(items) {
  if (!items.length) {
    return '<p class="card-empty">\u5f53\u524d\u65e0\u5f85\u5173\u6ce8\u4e8b\u9879</p>';
  }
  const groups = ['critical', 'warning', 'info']
    .map((severity) => ({
      severity,
      items: items.filter((item) => (item.severity ?? 'info') === severity),
    }))
    .filter((group) => group.items.length);

  return `<div class="attention-board-groups">${groups.map((group) => `
    <section class="attention-group severity-${group.severity}">
      <h4 class="attention-group-title">${ATTENTION_SEVERITY_LABELS[group.severity] ?? group.severity} <span>${group.items.length}</span></h4>
      <ul class="attention-board-list">${group.items.map((item) => {
        const cycleId = item.refs?.cycle_id;
        const clickable = cycleId ? ' attention-item-clickable' : '';
        const dataAttrs = cycleId
          ? ` data-cycle-id="${escapeHtml(cycleId)}" data-subject="${escapeHtml(item.subject ?? activeSubject ?? '')}"`
          : '';
        return `
          <li class="attention-board-item severity-${item.severity ?? 'info'}${clickable}"${dataAttrs} role="${cycleId ? 'button' : 'listitem'}" tabindex="${cycleId ? '0' : '-1'}">
            <div class="attention-item-head">
              <span class="attention-severity">${ATTENTION_SEVERITY_LABELS[item.severity] ?? item.severity}</span>
              ${isMultiSubject() && item.subject ? `<span class="attention-subject">${escapeHtml(item.subject)}</span>` : ''}
              <span class="attention-item-title">${escapeHtml(item.title)}</span>
            </div>
            ${item.summary ? `<p class="attention-summary">${escapeHtml(item.summary)}</p>` : ''}
            ${item.suggested_command ? `<code class="attention-cmd">${escapeHtml(item.suggested_command)}</code>` : ''}
          </li>`;
      }).join('')}</ul>
    </section>`).join('')}</div>`;
}

function bindAttentionBoardClicks(root) {
  if (!root) return;
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

function formatChannelRoleWorkers(workers) {
  const roles = workers?.roles ?? [];
  if (!roles.length) return '<p class="channel-detail-muted">\u65e0 role worker \u8bb0\u5f55</p>';
  return roles.map((r) => {
    const stale = r.stale ? ' stale' : '';
    const zombie = r.zombie ? ' zombie' : '';
    return `<div class="channel-role-row"><span class="channel-role-name">${escapeHtml(r.role)}</span> <span class="channel-role-meta${stale}${zombie}">${r.running ? '\u8fd0\u884c' : '\u505c\u6b62'} \u00b7 pid ${r.pid_alive ? '\u5b58\u6d3b' : '\u6b7b'}${stale ? ' \u00b7 stale' : ''}${zombie ? ' \u00b7 zombie' : ''}</span></div>`;
  }).join('');
}

function renderChannelRoleChips(channel) {
  const roles = channel?.workers?.roles ?? [];
  const byRole = new Map(roles.map((role) => [role.role, role]));
  return `<div class="channel-role-chips">${CHANNEL_ROLES.map((roleName) => {
    const role = byRole.get(roleName);
    const state = role?.running ? 'on' : role?.zombie ? 'zombie' : role?.stale ? 'stale' : 'off';
    const title = role
      ? `${roleName}: ${state}${role.pid_alive === false ? ' ? pid dead' : ''}`
      : `${roleName}: no worker record`;
    return `<span class="channel-role-chip role-${state}" title="${escapeHtml(title)}">${roleName}</span>`;
  }).join('')}</div>`;
}

function renderChannelPresenceDetails(channel) {
  if (!channel) return '\u2014';
  const workers = channel.workers ?? {};
  const classifier = channel.classifier ?? {};
  const presence = channel.presence ?? {};
  const reactor = presence.reactor ?? null;
  const pendingSpeech = presence.pending_speech_generation ?? [];
  const feishu = channel.feishu ?? {};
  const listener = feishu.listener ?? {};
  const reload = feishu.reload ?? {};

  const classifierLine = classifier.enabled === false
    ? 'Classifier: \u5df2\u7981\u7528'
    : `Classifier: ${classifier.mode ?? '\u9ed8\u8ba4'} \u00b7 \u95f4\u9694 ${classifier.interval_ms ?? '\u2014'}ms \u00b7 batch ${classifier.batch_size ?? '\u2014'}`;

  const reactorStatus = reactor?.status ?? 'idle';
  const reactorDeadline = reactor?.deadline_at
    ? ` \u00b7 \u622a\u6b62 ${formatTimeShort(reactor.deadline_at)}`
    : '';

  const listenerLine = listener.running
    ? `Feishu WS: \u8fd0\u884c\u4e2d${listener.fingerprint_stale ? ' (\u914d\u7f6e\u8fc7\u671f)' : ''}`
    : 'Feishu WS: \u672a\u8fde\u63a5';
  const reloadLine = reload.pending
    ? `\u70ed\u52a0\u8f7d pending: ${escapeHtml(reload.request?.reason ?? 'reload')}`
    : reload.last_error
      ? `\u4e0a\u6b21\u70ed\u52a0\u8f7d\u9519\u8bef: ${escapeHtml(String(reload.last_error).slice(0, 80))}`
      : '';

  return `
    <details class="channel-details">
      <summary>Presence / Classifier / Feishu</summary>
      <div class="channel-details-body">
        <div class="channel-subheading">Role workers (${workers.running_count ?? 0} \u8fd0\u884c\u4e2d)</div>
        ${formatChannelRoleWorkers(workers)}
        <div class="channel-subheading">Classifier</div>
        <p class="channel-detail-line">${escapeHtml(classifierLine)}</p>
        <div class="channel-subheading">Presence reactor</div>
        <p class="channel-detail-line">${escapeHtml(reactorStatus)}${reactorDeadline}</p>
        ${pendingSpeech.length ? `<p class="channel-detail-line channel-stat-warn">\u5f85\u751f\u6210\u8bdd\u672f ${pendingSpeech.length}</p>` : ''}
        <div class="channel-subheading">Feishu</div>
        <p class="channel-detail-line">${escapeHtml(listenerLine)}</p>
        ${reloadLine ? `<p class="channel-detail-line">${reloadLine}</p>` : ''}
      </div>
    </details>
  `;
}

function renderChannelSummaryCardHtml() {
  const channel = getDaemonState()?.channel ?? getObservability()?.channel_diagnostics;
  if (!channel) {
    return '<section class="ops-card"><h3 class="ops-card-title">Channel</h3><p class="card-empty">Channel \u672a\u521d\u59cb\u5316</p></section>';
  }
  const health = channel.health ?? {};
  const worker = channel.worker ?? {};
  const counts = channel.tasks?.counts ?? {};
  const inPending = channel.inbound?.pending_count ?? channel.inbound_pending ?? 0;
  const outPending = channel.outbox?.pending_count ?? channel.outbox_pending ?? 0;
  const presence = channel.presence ?? getObservability()?.channel_diagnostics?.presence;
  const pendingSpeech = presence?.pending_speech_generation?.length ?? 0;
  const failed = counts.failed ?? channel.tasks?.failed?.length ?? 0;
  const reactorStatus = presence?.reactor?.status ?? 'idle';
  const listener = channel.feishu?.listener ?? {};
  const reload = channel.feishu?.reload ?? {};
  const presenceDetails = renderChannelPresenceDetails(getDaemonState()?.channel ?? null);
  return `
    <section class="ops-card ops-card-channel">
      <h3 class="ops-card-title">Channel</h3>
      <div class="kpi-row kpi-row-compact">
        <span class="kpi-pill health-${health.status ?? 'unknown'}">${escapeHtml(health.status ?? 'unknown')}</span>
        <span class="kpi-pill">${worker.running ? 'Worker \u8fd0\u884c' : 'Worker \u505c\u6b62'}${worker.stale ? ' \u00b7 stale' : ''}</span>
        <span class="kpi-pill${failed ? ' kpi-warn' : ''}">Q ${counts.pending ?? 0}/${counts.running ?? 0}/${failed}</span>
        <span class="kpi-pill${inPending ? ' kpi-warn' : ''}">\u5165\u7ad9 ${inPending}</span>
        <span class="kpi-pill${outPending ? ' kpi-warn' : ''}">\u51fa\u7ad9 ${outPending}</span>
        ${pendingSpeech ? `<span class="kpi-pill kpi-warn">\u8bdd\u672f pending ${pendingSpeech}</span>` : ''}
        <span class="kpi-pill reactor-${reactorStatus}">Presence ${escapeHtml(reactorStatus)}</span>
        <span class="kpi-pill${listener.running ? '' : ' kpi-warn'}">Feishu ${listener.running ? 'WS on' : 'WS off'}</span>
        ${reload.pending ? '<span class="kpi-pill kpi-warn">reload pending</span>' : ''}
      </div>
      ${renderChannelRoleChips(getDaemonState()?.channel ?? channel)}
      ${presenceDetails}
    </section>`;
}

function renderOpenCyclesTableHtml() {
  const cycles = getDaemonState()?.cycles?.recent ?? getObservability()?.cycle_diagnostics?.recent ?? [];
  if (!cycles.length) {
    return '<p class="card-empty">\u6682\u65e0 open cycle</p>';
  }
  return `<table class="ops-table"><thead><tr><th>Cycle</th><th>\u72b6\u6001</th><th>Steps</th><th></th></tr></thead><tbody>
    ${cycles.map((cycle) => {
      const stepsObj = {};
      for (const [name, status] of Object.entries(cycle.steps ?? {})) {
        stepsObj[name] = { status: typeof status === 'string' ? status : (status?.status ?? 'pending') };
      }
      return `<tr>
        <td><code>${escapeHtml(cycle.cycle_id)}</code></td>
        <td>${escapeHtml(cycle.status ?? 'open')}</td>
        <td>${renderStepBadges(stepsObj, { compact: true })}</td>
        <td><button type="button" class="btn btn-sm btn-primary" data-open-cycle="${escapeHtml(cycle.cycle_id)}">\u6253\u5f00</button></td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

function renderOperatorBriefsHtml() {
  const inputs = getObservability()?.operator_inputs;
  const briefs = inputs?.recent ?? [];
  if (!briefs.length && !(inputs?.pending_count > 0)) {
    return '<p class="card-empty">\u6682\u65e0 pending brief</p>';
  }
  const header = `<p class="ops-card-meta">Pending ${inputs?.pending_count ?? 0}${inputs?.stale_pending_count ? ` \u00b7 \u542b\u8fc7\u671f ${inputs.stale_pending_count}` : ''}</p>`;
  const list = briefs.length
    ? `<ul class="brief-list">${briefs.map((b) => `
      <li><span class="brief-kind">${escapeHtml(b.kind ?? '')}</span> ${escapeHtml(b.summary ?? '')}
        <span class="brief-age">${b.age_ms != null ? `${Math.round(b.age_ms / 60000)}m` : ''}</span></li>
    `).join('')}</ul>`
    : '';
  return header + list;
}

function renderOpsPostureHtml(items) {
  const daemon = getDaemonState();
  const obs = getObservability();
  if (!daemon) {
    return '<p class="card-empty">\u65e0\u6cd5\u52a0\u8f7d daemon \u72b6\u6001</p>';
  }
  const cycles = daemon.cycles?.recent ?? [];
  const current = cycles[0] ?? null;
  const steps = current ? normalizeCycleSteps(current) : {};
  const activeStep = activeStepName(steps);
  const stuck = daemon.cycles?.stuck_steps ?? obs?.cycle_diagnostics?.stuck_steps ?? [];
  const drift = daemon.cycles?.drift_steps ?? obs?.cycle_diagnostics?.drift_steps ?? [];
  const failed = daemon.tasks?.counts?.failed ?? 0;
  const pendingBriefs = obs?.operator_inputs?.pending_count ?? 0;
  const attention = obs?.attention?.summary ?? {};
  const suggestions = obs?.cycle_diagnostics?.health_suggestions ?? [];

  let nextAction = '\u7cfb\u7edf\u8fd0\u884c\u6b63\u5e38\uff0c\u53ef\u67e5\u770b\u6700\u65b0\u8f6e\u6b21\u6216\u4e8b\u4ef6\u6d41\u3002';
  let tone = 'ok';
  if (items.some((item) => item.severity === 'critical')) {
    nextAction = '\u5b58\u5728\u4e25\u91cd\u5f85\u5173\u6ce8\u9879\uff0c\u8bf7\u5148\u5904\u7406\u3002';
    tone = 'critical';
  } else if (stuck.length) {
    nextAction = `\u68c0\u67e5\u5361\u4f4f\u7684 step\uff1a${stuck[0].step ?? ''}\u3002`;
    tone = 'critical';
  } else if (drift.length) {
    nextAction = `\u4fee\u590d drift step\uff1a${drift[0].step ?? ''}\u3002`;
    tone = 'warning';
  } else if (failed) {
    nextAction = '\u5904\u7406\u5931\u8d25\u4efb\u52a1\uff1a\u67e5\u770b daemon \u4efb\u52a1\u961f\u5217\u3002';
    tone = 'warning';
  } else if (pendingBriefs) {
    nextAction = '\u6709\u5f85\u5904\u7406 operator brief\uff0c\u53ef\u5728\u9605\u8bfb\u89c6\u56fe\u6216\u4e0b\u4e00\u8f6e\u6d88\u8d39\u3002';
    tone = 'info';
  } else if (current && activeStep) {
    nextAction = `\u7ee7\u7eed\u5173\u6ce8\u5f53\u524d cycle \u7684 ${STEP_LABELS[activeStep] ?? activeStep} \u9636\u6bb5\u3002`;
    tone = stepStatus(steps, activeStep) === 'failed' ? 'warning' : 'info';
  } else if (suggestions.length) {
    nextAction = suggestions[0];
    tone = 'info';
  }

  return `
    <div class="posture-card posture-${tone}">
      <div class="posture-main">
        <span class="posture-label">\u5f53\u524d\u6001\u52bf</span>
        <strong>${escapeHtml(nextAction)}</strong>
        <span class="posture-meta">${escapeHtml(activeSubject ?? '')} \u00b7 ${escapeHtml(formatEvolutionMode(daemon.evolution_mode))} \u00b7 \u5f85\u5173\u6ce8 ${severitySummary(attention)}</span>
      </div>
      <div class="posture-facts">
        <span><strong>${daemon.cycles?.open_count ?? 0}</strong> open</span>
        <span><strong>${current?.cycle_id ? escapeHtml(current.cycle_id) : '\u2014'}</strong> current</span>
        <span><strong>${activeStep ? escapeHtml(STEP_LABELS[activeStep] ?? activeStep) : '\u2014'}</strong> step</span>
        <span><strong>${stuck.length}/${drift.length}</strong> stuck/drift</span>
      </div>
    </div>`;
}

function renderKpiStripHtml() {
  const daemon = getDaemonState();
  const obs = getObservability();
  if (!daemon) {
    return '<p class="card-empty">\u65e0\u6cd5\u52a0\u8f7d daemon \u72b6\u6001</p>';
  }
  const health = daemon.health ?? {};
  const worker = daemon.worker ?? {};
  const counts = daemon.tasks?.counts ?? {};
  const att = obs?.attention?.summary ?? {};
  const mode = daemon.evolution_mode;
  const modeLabel = mode ? formatEvolutionMode(mode) : '\u2014';
  const cycles = daemon.cycles?.recent ?? [];
  const channel = daemon.channel ?? obs?.channel_diagnostics ?? {};
  const pendingSpeech = channel.presence?.pending_speech_generation?.length ?? 0;
  const channelIn = channel.inbound?.pending_count ?? channel.inbound_pending ?? 0;
  const channelOut = channel.outbox?.pending_count ?? channel.outbox_pending ?? 0;
  return `
    <div class="kpi-strip">
      <div class="kpi-card health-${health.status ?? 'unknown'}">
        <span class="kpi-label">Health</span>
        <span class="kpi-value">${escapeHtml(health.status ?? 'unknown')}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Worker</span>
        <span class="kpi-value">${worker.running ? '\u8fd0\u884c' : '\u505c\u6b62'}${worker.stale ? ' \u00b7 stale' : ''}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Open cycles</span>
        <span class="kpi-value">${daemon.cycles?.open_count ?? 0}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">\u961f\u5217</span>
        <span class="kpi-value">P ${counts.pending ?? 0} / R ${counts.running ?? 0} / F ${counts.failed ?? 0}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Running step</span>
        <span class="kpi-value">${escapeHtml(runningStepLabel(cycles))}</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">\u6f14\u5316\u6a21\u5f0f</span>
        <span class="kpi-value mode-${mode ?? 'unknown'}">${escapeHtml(modeLabel)}</span>
      </div>
      <div class="kpi-card${att.highest_severity ? ` severity-${att.highest_severity}` : ''}">
        <span class="kpi-label">\u961f\u5217</span>
        <span class="kpi-value">${escapeHtml(severitySummary(att))}</span>
      </div>
      <div class="kpi-card${channelIn || channelOut || pendingSpeech ? ' severity-warning' : ''}">
        <span class="kpi-label">Channel</span>
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
        <h2 class="ops-home-title">\u8fd0\u7ef4\u603b\u89c8</h2>
        <p class="ops-home-subtitle">${escapeHtml(activeSubject ?? '')} \u00b7 \u9009\u62e9\u5de6\u4fa7\u8f6e\u6b21\u6216\u4e0b\u65b9\u6761\u76ee\u8fdb\u5165\u9605\u8bfb\u89c6\u56fe</p>
      </div>
      ${renderKpiStripHtml()}
      ${renderOpsPostureHtml(items)}
      <div class="ops-grid">
        <section class="ops-card ops-card-span-2 ops-card-attention">
          <h3 class="ops-card-title">\u5f85\u5173\u6ce8 <span class="ops-badge">${items.length}</span></h3>
          ${renderAttentionBoardHtml(items)}
        </section>
        <section class="ops-card">
          <h3 class="ops-card-title">\u8fdb\u884c\u4e2d Cycle</h3>
          ${renderOpenCyclesTableHtml()}
        </section>
        ${renderChannelSummaryCardHtml()}
        <section class="ops-card">
          <h3 class="ops-card-title">Operator Briefs</h3>
          ${renderOperatorBriefsHtml()}
        </section>
        <section class="ops-card ops-card-events">
          <h3 class="ops-card-title">\u6700\u8fd1 Daemon \u4e8b\u4ef6</h3>
          <div class="ops-event-feed">${renderEventFeedHtml(getFeedEvents(), 25)}</div>
        </section>
        ${latestRound ? `
        <section class="ops-card ops-card-quick">
          <h3 class="ops-card-title">\u6700\u8fd1\u5b8c\u6210\u8f6e\u6b21</h3>
          <p class="ops-quick-line"><code>${escapeHtml(latestRound.cycle_id)}</code></p>
          <p class="ops-quick-tldr">${escapeHtml(truncate(latestRound.tldr, 160))}</p>
          <button type="button" class="btn btn-sm btn-primary" data-open-cycle="${escapeHtml(latestRound.cycle_id)}">\u9605\u8bfb\u62a5\u544a</button>
        </section>` : ''}
      </div>
    </div>`;

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
    activeCyclesEl.innerHTML = '<p class="feed-empty">\u6682\u65e0 open cycle</p>';
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
      <span class="when">${formatWhen(cycle.opened_at)} \u00b7 ${cycle.status ?? 'open'}</span>
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
      <span class="cycle-id">${round.cycle_id}${newCycleIds.has(round.cycle_id) ? ' <span class="new-tag">\u65b0</span>' : ''}</span>
      <span class="when">${formatWhen(round.generated_at)}</span>
      ${round.tldr ? `<span class="tldr">${truncate(round.tldr)}</span>` : ''}
      <span class="badge ${round.has_diary ? '' : 'none'}">${round.has_diary ? '\u6709\u65e5\u8bb0' : '\u65e0\u65e5\u8bb0'}</span>
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
  if (!res.ok) throw new Error(`\u65e0\u6cd5\u52a0\u8f7d manifest: ${subject}`);
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
  if (!res.ok) throw new Error(`\u65e0\u6cd5\u52a0\u8f7d\u8f6e\u6b21\u8be6\u60c5: ${res.status}`);
  return res.json();
}

async function loadCycleDetail(cycleId, subject = activeSubject) {
  const res = await fetch(`${subjectApiBase(subject)}/cycles/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`\u65e0\u6cd5\u52a0\u8f7d cycle \u8be6\u60c5: ${res.status}`);
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
    parts.push(`<div class="diag-block diag-critical"><strong>\u5361\u4f4f step</strong><ul>${stuck.map((s) => `
      <li><code>${escapeHtml(s.step)}</code> \u2014 ${escapeHtml(s.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (drift.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>Drift step</strong><ul>${drift.map((d) => `
      <li><code>${escapeHtml(d.step)}</code> \u2014 ${escapeHtml(d.reason ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (attention.length) {
    parts.push(`<div class="diag-block"><strong>\u672c cycle \u76f8\u5173\u5173\u6ce8</strong><ul>${attention.map((a) => `
      <li class="severity-${a.severity}">${escapeHtml(a.title)}: ${escapeHtml(a.summary)}</li>
    `).join('')}</ul></div>`);
  }
  if (failedTasks.length) {
    parts.push(`<div class="diag-block diag-warning"><strong>\u5931\u8d25\u4efb\u52a1</strong><ul>${failedTasks.map((t) => `
      <li><code>${escapeHtml(t.task_id)}</code> ${escapeHtml(t.type)} \u2014 ${escapeHtml(t.last_error_code ?? t.last_error ?? '')}</li>
    `).join('')}</ul></div>`);
  }
  if (suggestions.length) {
    parts.push(`<div class="diag-block"><strong>\u5efa\u8bae</strong><ul>${suggestions.slice(0, 3).map((s) => `
      <li><code>${escapeHtml(s)}</code></li>
    `).join('')}</ul></div>`);
  }

  if (!parts.length) return null;

  section.innerHTML = `<h3>Cycle \u8bca\u65ad</h3>${parts.join('')}`;
  return section;
}

function readerOpsMetrics(data) {
  const diag = data.diagnostics ?? {};
  const tasks = data.tasks ?? [];
  const attention = data.observability_attention ?? [];
  const obs = getObservability();
  const failedGlobal = (obs?.cycle_diagnostics?.failed_tasks ?? [])
    .filter((t) => t.cycle_id === data.cycle_id || !t.cycle_id);
  const stuck = diag.stuck_steps?.length ?? 0;
  const drift = diag.drift_steps?.length ?? 0;
  const failed = tasks.filter((t) => t.status === 'failed').length + failedGlobal.length;
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
  if (m.stuck) parts.push(`${m.stuck} \u5361\u4f4f`);
  if (m.drift) parts.push(`${m.drift} drift`);
  if (m.attention) parts.push(`${m.attention} \u5173\u6ce8`);
  if (m.failed) parts.push(`${m.failed} \u5931\u8d25`);
  else if (m.tasks) parts.push(`${m.tasks} \u4efb\u52a1`);
  return parts.join(' \u00b7 ');
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
    <span class="reader-ops-title">\u8fd0\u7ef4\u4fe1\u606f</span>
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
    section.innerHTML = '<h3>Daemon \u4efb\u52a1</h3><p class="reader-ops-empty">\u6682\u65e0\u4efb\u52a1</p>';
    return section;
  }
  if (compact) {
    section.innerHTML = `
      <h3>Daemon \u4efb\u52a1</h3>
      <ul class="reader-task-list">${tasks.map((t) => `
        <li class="reader-task-item status-${String(t.status ?? 'unknown').replace(/[^a-z0-9_-]/gi, '')}">
          <div class="reader-task-head">
            <span class="reader-task-type">${escapeHtml(t.type)}</span>
            <span class="reader-task-status">${escapeHtml(t.status)}</span>
          </div>
          <code class="reader-task-id">${escapeHtml(t.task_id)}</code>
          ${t.last_error || t.last_error_code
            ? `<p class="reader-task-error">${escapeHtml(t.last_error_code ?? t.last_error ?? '')}</p>`
            : ''}
        </li>
      `).join('')}</ul>
    `;
    return section;
  }
  section.innerHTML = `
    <h3>Daemon \u4efb\u52a1</h3>
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
  if (!nodes.length) return '\u2014';
  return `<div class="cycle-progress-rail" aria-label="Cycle progress">${nodes.join('')}</div>`;
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
  const summary = tldr || `${mode} \u00b7 \u62a5\u544a ${hasReport ? '\u6709' : '\u65e0'} \u00b7 \u65e5\u8bb0 ${diaries.length}`;

  return `<section class="cycle-summary-card">
    <div class="cycle-summary-main">
      <span class="cycle-summary-label">\u8f6e\u6b21\u6458\u8981</span>
      <strong>${escapeHtml(truncate(summary, 220))}</strong>
      <span class="cycle-summary-meta">${escapeHtml(data.cycle_id ?? '')}${data.cycle_status ? ` \u00b7 ${escapeHtml(data.cycle_status)}` : ''}</span>
    </div>
    <div class="cycle-summary-facts">
      <span><strong>${hasReport ? 'yes' : 'no'}</strong> report</span>
      <span><strong>${diaries.length}</strong> diaries</span>
      <span><strong>${failed}</strong> failed tasks</span>
      <span><strong>${stuck}/${drift}</strong> stuck/drift</span>
      <span><strong>${attention}</strong> attention</span>
      ${latestDiary ? `<span><strong>${escapeHtml(latestDiary)}</strong> latest diary</span>` : ''}
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
  reportContent.innerHTML = data.report_html ?? '<p class="missing">\u65e0\u62a5\u544a\u5185\u5bb9</p>';
}

function patchDetailDiaryContent(data) {
  const diaryContent = detailEl.querySelector('.panel.diary .content');
  if (!diaryContent) return;
  const diaries = data.diaries ?? [];
  if (!diaries.length) {
    diaryContent.innerHTML = '<p class="missing">\u672c\u8f6e\u65e0\u5173\u8054\u65e5\u8bb0</p>';
    return;
  }
  diaryContent.innerHTML = diaries[0]?.html ?? '<p class="missing">\u65e0\u65e5\u8bb0\u5185\u5bb9</p>';
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
    label.textContent = '\u65e5\u8bb0';
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
    span.innerHTML = `<label>\u65e5\u8bb0</label> <code>${diaries[0].exec_id}</code>`;
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
  reportPanel.innerHTML = '<h3>\u60c5\u62a5\u62a5\u544a</h3>';
  const reportContent = document.createElement('div');
  reportContent.className = 'content';
  reportContent.innerHTML = data.report_html ?? '<p class="missing">\u65e0\u62a5\u544a\u5185\u5bb9</p>';
  reportPanel.appendChild(reportContent);

  const diaryPanel = document.createElement('section');
  diaryPanel.className = 'panel diary';
  diaryPanel.innerHTML = '<h3>\u8fdb\u5316\u65e5\u8bb0</h3>';
  const diaryContent = document.createElement('div');
  diaryContent.className = 'content';
  diaryPanel.appendChild(diaryContent);

  function updateDiaryPanel() {
    if (!diaries.length) {
      diaryContent.innerHTML = '<p class="missing">\u672c\u8f6e\u65e0\u5173\u8054\u65e5\u8bb0</p>';
      return;
    }
    diaryContent.innerHTML = diaries[diaryIndex]?.html ?? '<p class="missing">\u65e0\u65e5\u8bb0\u5185\u5bb9</p>';
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
  detailEl.innerHTML = '<p class="placeholder">\u52a0\u8f7d\u4e2d\u2026</p>';
  try {
    const data = await loadCycleDetail(cycleId);
    renderDetail(data, { mode: 'cycle' });
  } catch (err) {
    activeDetailCache = null;
    updateReaderNav({ cycleId, meta: err.message });
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
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
  detailEl.innerHTML = '<p class="placeholder">\u52a0\u8f7d\u4e2d\u2026</p>';
  try {
    const data = await loadRoundDetail(cycleId);
    renderDetail(data, { mode: 'round' });
  } catch (err) {
    activeDetailCache = null;
    updateReaderNav({ cycleId, meta: err.message });
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
    setLiveStatus('\u5b9e\u65f6\u5df2\u8fde\u63a5', 'connected');
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
    updateMeta('\u5df2\u66f4\u65b0');
    return;
  }
  if (event === 'ping') return;
  if (event === 'error') {
    setLiveStatus(`\u9519\u8bef: ${payload.message ?? 'unknown'}`, 'error');
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
    setLiveStatus('\u5b9e\u65f6\u5df2\u8fde\u63a5', 'connected');
    if (subject === activeSubject) {
      void loadManifest(subject).then(() => {
        renderTimeline(filterEl.value);
        updateMeta('\u5df2\u66f4\u65b0');
        if (viewMode === 'ops') scheduleRenderOpsHome();
      });
    } else {
      void loadManifest(subject);
    }
    return;
  }
  if (event === 'round_updated') {
    setLiveStatus('\u5b9e\u65f6\u5df2\u8fde\u63a5', 'connected');
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
  setLiveStatus(`\u5df2\u65ad\u5f00\uff0c${Math.round(reconnectDelayMs / 1000)}s \u540e\u91cd\u8fde`, 'disconnected');
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
    setLiveStatus('\u5b9e\u65f6\u4e0d\u53ef\u7528', 'error');
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
    setLiveStatus('\u5b9e\u65f6\u8fde\u63a5\u4e2d\u2026', 'connecting');
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
  if (!res.ok) throw new Error('\u65e0\u6cd5\u52a0\u8f7d /api/subjects');
  const data = await res.json();
  defaultSubject = data.default_subject;
  subjectsList = data.subjects ?? [];
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
  try {
    await loadSubjectsIndex();
  } catch {
    metaEl.textContent = '\u65e0\u6cd5\u8fde\u63a5 viewer API\uff0c\u8bf7\u8fd0\u884c jea intel viewer serve';
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
