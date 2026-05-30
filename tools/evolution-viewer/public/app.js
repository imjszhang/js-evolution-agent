const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const metaEl = document.getElementById('meta');
const filterEl = document.getElementById('filter');
const liveStatusEl = document.getElementById('live-status');
const daemonBarEl = document.getElementById('daemon-bar');
const activeCyclesEl = document.getElementById('active-cycles');
const eventFeedEl = document.getElementById('event-feed');

/** @type {{ rounds: object[], subject?: string, namespace?: string, built_at?: string, limit?: number } | null} */
let manifest = null;
/** @type {object|null} */
let daemonState = null;
let activeCycleId = null;
/** @type {'cycle'|'round'|null} */
let activeViewMode = null;
/** @type {Set<string>} */
const seenCycleIds = new Set();
/** @type {Set<string>} */
const newCycleIds = new Set();
/** @type {object[]} */
let feedEvents = [];
let eventSource = null;
let reconnectDelayMs = 5000;
let reconnectTimer = null;
let daemonPollTimer = null;

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
};

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

function truncate(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function updateMeta(extra = '') {
  if (!manifest) return;
  const parts = [
    manifest.subject,
    manifest.namespace,
    `共 ${manifest.round_count ?? manifest.rounds?.length ?? 0} 轮`,
    manifest.built_at ? `更新于 ${formatWhen(manifest.built_at)}` : '',
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
      if (compact) {
        const sym = status === 'done' ? '✓' : status === 'running' ? '▶' : status === 'failed' ? '✗' : '·';
        return `<span class="step-dot step-${status}" title="${label}: ${status}">${sym}</span>`;
      }
      return `<span class="step-badge step-${status}" title="${name}">${label}: ${status}</span>`;
    });
  if (!items.length) return '';
  const cls = compact ? 'step-dots' : 'step-badges';
  return `<div class="${cls}">${items.join('')}</div>`;
}

function formatEventLabel(ev) {
  const base = EVENT_LABELS[ev.event_type] ?? ev.event_type;
  const parts = [base];
  if (ev.task_type || ev.step_type) parts.push(ev.task_type ?? ev.step_type);
  if (ev.cycle_id) parts.push(ev.cycle_id);
  return parts.join(' · ');
}

function renderEventFeed() {
  if (!eventFeedEl) return;
  if (!feedEvents.length) {
    eventFeedEl.innerHTML = '<p class="feed-empty">暂无 daemon 事件</p>';
    return;
  }
  eventFeedEl.innerHTML = feedEvents.slice(0, 30).map((ev) => {
    const time = formatTimeShort(ev.recorded_at);
    return `<div class="feed-row"><span class="feed-time">${time}</span><span class="feed-label">${formatEventLabel(ev)}</span></div>`;
  }).join('');
}

function prependFeedEvent(ev) {
  if (!ev?.event_type) return;
  feedEvents.unshift(ev);
  if (feedEvents.length > 50) feedEvents.length = 50;
  renderEventFeed();
}

function renderDaemonBar() {
  if (!daemonBarEl) return;
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

  let currentText = '无运行中任务';
  if (current) {
    const linked = stepTasks.find((t) => t.task_id === current.task_id);
    const cyclePart = linked?.cycle_id ? ` @ ${linked.cycle_id}` : '';
    currentText = `当前 ${current.type}${cyclePart}`;
  }

  const tickPart = daemonState.last_tick_at
    ? `上次 tick ${formatTimeShort(daemonState.last_tick_at)}`
    : '尚无 tick 记录';

  daemonBarEl.innerHTML = `
    <span class="daemon-chip health-${health.status ?? 'unknown'}">Health: ${health.status ?? 'unknown'}</span>
    <span class="daemon-chip worker-${worker.running ? 'on' : 'off'}">Worker: ${worker.running ? '运行中' : '未运行'}${worker.stale ? ' (stale)' : ''}</span>
    <span class="daemon-chip">队列 pending ${counts.pending ?? 0} · running ${counts.running ?? 0}</span>
    <span class="daemon-chip">${currentText}</span>
    <span class="daemon-chip muted">${tickPart}</span>
  `;
}

function renderActiveCycles() {
  if (!activeCyclesEl) return;
  const cycles = daemonState?.cycles?.recent ?? [];
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

function renderTimeline(filter = '') {
  if (!manifest?.rounds) return;
  const q = filter.trim().toLowerCase();
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

async function loadManifest() {
  const res = await fetch('/api/manifest');
  if (!res.ok) throw new Error('无法加载 /api/manifest');
  const next = await res.json();
  const prevIds = new Set(manifest?.rounds?.map((r) => r.cycle_id) ?? []);
  manifest = next;
  for (const round of manifest.rounds ?? []) {
    if (!seenCycleIds.has(round.cycle_id)) {
      seenCycleIds.add(round.cycle_id);
      if (prevIds.size > 0 && !prevIds.has(round.cycle_id)) {
        newCycleIds.add(round.cycle_id);
      }
    }
  }
  updateMeta();
  return manifest;
}

async function loadDaemon() {
  try {
    const res = await fetch('/api/daemon');
    if (!res.ok) return null;
    daemonState = await res.json();
    renderDaemonBar();
    renderActiveCycles();
    return daemonState;
  } catch {
    return null;
  }
}

async function loadRecentEvents() {
  try {
    const res = await fetch('/api/events/recent?limit=30');
    if (!res.ok) return;
    const data = await res.json();
    feedEvents = data.events ?? [];
    renderEventFeed();
  } catch {
    // ignore
  }
}

async function loadRoundDetail(cycleId) {
  const res = await fetch(`/api/rounds/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`无法加载轮次详情: ${res.status}`);
  return res.json();
}

async function loadCycleDetail(cycleId) {
  const res = await fetch(`/api/cycles/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`无法加载 cycle 详情: ${res.status}`);
  return res.json();
}

function renderTasksList(tasks) {
  if (!tasks?.length) return '';
  const rows = tasks.map((t) => `
    <tr>
      <td><code>${t.task_id}</code></td>
      <td>${t.type}</td>
      <td>${t.status}</td>
      <td>${t.attempts ?? 0}</td>
    </tr>
  `).join('');
  return `
    <section class="panel tasks-panel">
      <h3>Daemon 任务</h3>
      <table class="tasks-table">
        <thead><tr><th>Task</th><th>Type</th><th>Status</th><th>Attempts</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  `;
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

  const tasksHtml = mode === 'cycle' ? renderTasksList(data.tasks) : '';
  const tasksEl = document.createElement('div');
  if (tasksHtml) {
    tasksEl.innerHTML = tasksHtml;
    detailEl.replaceChildren(header, panels, tasksEl.firstElementChild);
  } else {
    detailEl.replaceChildren(header, panels);
  }
}

async function selectCycle(cycleId, { scrollTimeline = false } = {}) {
  activeCycleId = cycleId;
  activeViewMode = 'cycle';
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
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

async function selectRound(cycleId, { scrollTimeline = false } = {}) {
  activeCycleId = cycleId;
  activeViewMode = 'round';
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
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

async function selectById(cycleId, opts = {}) {
  const cycleRes = await fetch(`/api/cycles/${encodeURIComponent(cycleId)}`);
  if (cycleRes.ok) {
    await selectCycle(cycleId, opts);
    return;
  }
  await selectRound(cycleId, opts);
}

function patchManifestRound(cycleId, patch) {
  const round = manifest?.rounds?.find((r) => r.cycle_id === cycleId);
  if (round) Object.assign(round, patch);
}

function refreshActiveView() {
  if (!activeCycleId) return;
  if (activeViewMode === 'cycle') {
    void selectCycle(activeCycleId);
  } else if (activeViewMode === 'round') {
    void selectRound(activeCycleId);
  }
}

function handleSsePayload(payload) {
  const event = payload?.event;
  if (event === 'hello') {
    setLiveStatus('实时已连接', 'connected');
    updateMeta('实时');
    return;
  }
  if (event === 'ping') return;
  if (event === 'error') {
    setLiveStatus(`错误: ${payload.message ?? 'unknown'}`, 'error');
    return;
  }
  if (event === 'daemon_event') {
    prependFeedEvent(payload);
    void loadDaemon();
    if (activeCycleId && payload.cycle_id === activeCycleId) {
      refreshActiveView();
    }
    return;
  }
  if (event === 'runtime_updated') {
    void loadDaemon();
    refreshActiveView();
    return;
  }
  if (event === 'round_added') {
    setLiveStatus('实时已连接', 'connected');
    void loadManifest().then(() => {
      renderTimeline(filterEl.value);
      updateMeta('实时');
    });
    return;
  }
  if (event === 'round_updated') {
    setLiveStatus('实时已连接', 'connected');
    void loadDaemon();
    if (payload.has_diary) {
      patchManifestRound(payload.cycle_id, { has_diary: true });
      renderTimeline(filterEl.value);
    }
    if (activeCycleId === payload.cycle_id) {
      refreshActiveView();
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
    void loadDaemon();
  }, 15_000);
  if (daemonPollTimer.unref) daemonPollTimer.unref();
}

async function init() {
  try {
    await loadManifest();
  } catch {
    metaEl.textContent = '无法连接 viewer API，请运行 jea intel viewer serve';
    return;
  }

  for (const round of manifest.rounds ?? []) {
    seenCycleIds.add(round.cycle_id);
  }
  updateMeta('');

  await loadDaemon();
  await loadRecentEvents();
  startDaemonPolling();

  filterEl.addEventListener('input', () => renderTimeline(filterEl.value));
  window.addEventListener('hashchange', () => {
    const id = cycleFromHash();
    if (id && id !== activeCycleId) void selectById(id);
  });

  renderTimeline();
  renderActiveCycles();

  const initial = cycleFromHash();
  if (initial) {
    await selectById(initial);
  } else if (daemonState?.cycles?.recent?.[0]?.cycle_id) {
    await selectCycle(daemonState.cycles.recent[0].cycle_id);
  } else if (manifest.rounds?.[0]?.cycle_id) {
    await selectRound(manifest.rounds[0].cycle_id);
  }

  connectLive();
}

init();
