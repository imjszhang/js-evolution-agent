const timelineEl = document.getElementById('timeline');
const detailEl = document.getElementById('detail');
const metaEl = document.getElementById('meta');
const filterEl = document.getElementById('filter');

/** @type {{ rounds: object[], subject?: string, namespace?: string, built_at?: string, limit?: number } | null} */
let manifest = null;
let activeCycleId = null;

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

function renderTimeline(filter = '') {
  if (!manifest?.rounds) return;
  const q = filter.trim().toLowerCase();
  timelineEl.innerHTML = '';

  for (const round of manifest.rounds) {
    const hay = `${round.cycle_id} ${round.tldr ?? ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `round-btn${round.cycle_id === activeCycleId ? ' active' : ''}`;
    btn.dataset.cycleId = round.cycle_id;
    btn.innerHTML = `
      <span class="cycle-id">${round.cycle_id}</span>
      <span class="when">${formatWhen(round.generated_at)}</span>
      ${round.tldr ? `<span class="tldr">${truncate(round.tldr)}</span>` : ''}
      <span class="badge ${round.has_diary ? '' : 'none'}">${round.has_diary ? '有日记' : '无日记'}</span>
    `;
    btn.addEventListener('click', () => selectRound(round.cycle_id));
    timelineEl.appendChild(btn);
  }
}

async function loadRoundDetail(cycleId) {
  const res = await fetch(`rounds/${encodeURIComponent(cycleId)}.json`);
  if (!res.ok) throw new Error(`无法加载轮次详情: ${res.status}`);
  return res.json();
}

function renderDetail(data) {
  const diaries = data.diaries ?? [];
  let diaryIndex = 0;

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `<h2>${data.cycle_id}</h2>`;

  let selectWrap = null;
  if (diaries.length > 1) {
    selectWrap = document.createElement('div');
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

async function selectRound(cycleId) {
  activeCycleId = cycleId;
  setHash(cycleId);
  renderTimeline(filterEl.value);
  detailEl.innerHTML = '<p class="placeholder">加载中…</p>';
  try {
    const data = await loadRoundDetail(cycleId);
    renderDetail(data);
  } catch (err) {
    detailEl.innerHTML = `<p class="missing">${err.message}</p>`;
  }
}

async function init() {
  const res = await fetch('manifest.json');
  if (!res.ok) {
    metaEl.textContent = '未找到 manifest.json，请先运行 jea intel viewer build';
    return;
  }
  manifest = await res.json();
  metaEl.textContent = [
    manifest.subject,
    manifest.namespace,
    `共 ${manifest.round_count ?? manifest.rounds?.length ?? 0} 轮`,
    manifest.built_at ? `构建于 ${formatWhen(manifest.built_at)}` : '',
  ].filter(Boolean).join(' · ');

  filterEl.addEventListener('input', () => renderTimeline(filterEl.value));
  window.addEventListener('hashchange', () => {
    const id = cycleFromHash();
    if (id && id !== activeCycleId) selectRound(id);
  });

  renderTimeline();
  const initial = cycleFromHash() || manifest.rounds?.[0]?.cycle_id;
  if (initial) await selectRound(initial);
}

init();
