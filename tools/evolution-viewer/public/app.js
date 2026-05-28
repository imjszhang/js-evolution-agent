const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const metaEl = document.getElementById('meta');
const filterEl = document.getElementById('filter');
const liveStatusEl = document.getElementById('live-status');

/** @type {{ rounds: object[], subject?: string, namespace?: string, built_at?: string, limit?: number } | null} */
let manifest = null;
let activeCycleId = null;
/** @type {Set<string>} */
const seenCycleIds = new Set();
/** @type {Set<string>} */
const newCycleIds = new Set();
let eventSource = null;
let reconnectDelayMs = 5000;
let reconnectTimer = null;

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
    if (round.cycle_id === activeCycleId) classes.push('active');
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

async function loadRoundDetail(cycleId) {
  const res = await fetch(`/api/rounds/${encodeURIComponent(cycleId)}`);
  if (!res.ok) throw new Error(`无法加载轮次详情: ${res.status}`);
  return res.json();
}

function renderDetail(data) {
  const diaries = data.diaries ?? [];
  let diaryIndex = 0;

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `<h2>${data.cycle_id}</h2>`;

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
  detailEl.replaceChildren(header, panels);
}

async function selectRound(cycleId, { scrollTimeline = false } = {}) {
  activeCycleId = cycleId;
  setHash(cycleId);
  renderTimeline(filterEl.value);
  if (scrollTimeline) {
    const btn = timelineEl.querySelector(`[data-cycle-id="${cycleId}"]`);
    btn?.scrollIntoView({ block: 'nearest' });
  }
  detailEl.innerHTML = '<p class="placeholder">加载中…</p>';
  try {
    const data = await loadRoundDetail(cycleId);
    renderDetail(data);
  } catch (err) {
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

function patchManifestRound(cycleId, patch) {
  const round = manifest?.rounds?.find((r) => r.cycle_id === cycleId);
  if (round) Object.assign(round, patch);
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
    if (payload.has_diary) {
      patchManifestRound(payload.cycle_id, { has_diary: true });
      renderTimeline(filterEl.value);
    }
    if (activeCycleId === payload.cycle_id) {
      void selectRound(payload.cycle_id);
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

  for (const name of ['hello', 'round_added', 'round_updated', 'error']) {
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

  filterEl.addEventListener('input', () => renderTimeline(filterEl.value));
  window.addEventListener('hashchange', () => {
    const id = cycleFromHash();
    if (id && id !== activeCycleId) selectRound(id);
  });

  renderTimeline();
  const initial = cycleFromHash() || manifest.rounds?.[0]?.cycle_id;
  if (initial) await selectRound(initial);

  connectLive();
}

init();
