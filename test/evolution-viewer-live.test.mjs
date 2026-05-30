import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
import {
  SseHub,
  formatSseMessage,
  createViewerApiServer,
  sseEventFromEvolutionLine,
} from '../src/intelligence/evolution-viewer/viewer-api.mjs';
import {
  daemonSseFromEvolutionLine,
  formatDaemonEventForApi,
} from '../src/intelligence/evolution-viewer/daemon-sse.mjs';
import { buildCycleDetail } from '../src/intelligence/evolution-viewer/cycle-detail.mjs';
import { buildManifest } from '../src/intelligence/evolution-viewer/round-catalog.mjs';
import { buildRoundDetail } from '../src/intelligence/evolution-viewer/round-detail.mjs';
import { evolutionViewerPublicDir } from '../src/intelligence/evolution-viewer/runtime-build.mjs';
import { resolveIntelReportPath } from '../src/intelligence/report-paths.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { createCycle } from '../src/cli/utils/cycle-state.mjs';
import { createWorkerState } from '../src/cli/utils/daemon-worker-state.mjs';
import { enqueueTask } from '../src/cli/utils/daemon-tasks.mjs';

const TEST_SUBJECT = 'live-test';

function setupViewerFixture(baseRoot, subject = TEST_SUBJECT) {
  mkdirSync(join(baseRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(baseRoot, 'policies', 'subjects', `${subject}.md`),
    `# ${subject}\n\n## Subject\n${subject}`,
    'utf-8',
  );
  writeFileSync(
    join(baseRoot, 'policies', 'active-subject.json'),
    JSON.stringify({
      active: subject,
      policy: `subjects/${subject}.md`,
      data_namespace: subject,
    }),
    'utf-8',
  );
  const runtimeRoot = join(baseRoot, 'runtime', 'subjects', subject);
  return { projectRoot: baseRoot, runtimeRoot, subject, dataNamespace: subject };
}

describe('formatSseMessage', () => {
  it('formats SSE event lines', () => {
    const msg = formatSseMessage('round_added', { cycle_id: 'cycle-x' });
    expect(msg).toContain('event: round_added\n');
    expect(msg).toContain('"cycle_id":"cycle-x"');
    expect(msg.endsWith('\n\n')).toBe(true);
  });
});

describe('sseEventFromEvolutionLine', () => {
  it('maps intel_report to round_added', () => {
    const ev = sseEventFromEvolutionLine(
      { type: 'intel_report', cycle_id: 'cycle-20260528-100000' },
      '/tmp',
    );
    expect(ev).toEqual({ type: 'round_added', cycle_id: 'cycle-20260528-100000' });
  });

  it('maps cycle_step events to round_updated', () => {
    const completed = sseEventFromEvolutionLine(
      { type: 'cycle_step_completed', cycle_id: 'cycle-20260528-100000' },
      '/tmp',
    );
    expect(completed).toEqual({ type: 'round_updated', cycle_id: 'cycle-20260528-100000' });
    const dispatched = sseEventFromEvolutionLine(
      { type: 'cycle_event_dispatched', cycle_id: 'cycle-20260528-100000' },
      '/tmp',
    );
    expect(dispatched).toEqual({ type: 'round_updated', cycle_id: 'cycle-20260528-100000' });
  });
});

describe('daemon-sse', () => {
  it('maps task_claimed to daemon_event payload', () => {
    const mapped = daemonSseFromEvolutionLine({
      type: 'task_claimed',
      task_id: 'task-1',
      task_type: 'exec',
      cycle_id: 'cycle-20260528-100000',
      recorded_at: '2026-05-28T02:00:00.000Z',
    });
    expect(mapped?.kind).toBe('daemon_event');
    expect(mapped?.payload.event_type).toBe('task_claimed');
    expect(mapped?.payload.task_type).toBe('exec');
  });

  it('formatDaemonEventForApi ignores non-daemon events', () => {
    expect(formatDaemonEventForApi({ type: 'intel_report', cycle_id: 'cycle-x' })).toBeNull();
  });

  it('formatDaemonEventForApi includes evolution mode transition fields', () => {
    const payload = formatDaemonEventForApi({
      type: 'evolution_mode_changed',
      from: 'continuous',
      to: 'on_demand',
      source: 'subjects.json',
      recorded_at: 't',
    });
    expect(payload?.from).toBe('continuous');
    expect(payload?.to).toBe('on_demand');
    expect(payload?.source).toBe('subjects.json');
  });
});

describe('SseHub', () => {
  it('broadcast writes to attached clients', () => {
    const hub = new SseHub({ pingIntervalMs: 60_000 });
    const chunks = [];
    const res = {
      write: (c) => chunks.push(c),
      on: () => {},
    };
    hub.attach(res);
    hub.broadcast('ping', {});
    expect(chunks.join('')).toContain('event: ping');
    hub.stop();
  });
});

function httpGetText(port, path, maxMs = 3000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      resolve(chunks.join(''));
    }, maxMs);
  });
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(chunks.join('')));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('round-catalog and round-detail', () => {
  let root;
  let runtimeRoot;
  let fixture;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jea-viewer-api-'));
    fixture = setupViewerFixture(root);
    runtimeRoot = fixture.runtimeRoot;
    const cycleId = 'cycle-20260528-100000';
    const reportPath = resolveIntelReportPath(runtimeRoot, cycleId);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, '# API test report\n', 'utf-8');
    const store = createIntelligenceStore({ baseDir: join(runtimeRoot, 'data', 'intelligence') });
    store.recordIntelReport({
      cycle_id: cycleId,
      generated_at: '2026-05-28T02:00:00.000Z',
      md_path: reportPath,
      tldr: 'api test',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('buildManifest and buildRoundDetail without dist', () => {
    const runtime = { runtimeRoot, subject: TEST_SUBJECT, dataNamespace: TEST_SUBJECT };
    const store = createIntelligenceStore({ baseDir: join(runtimeRoot, 'data', 'intelligence') });
    const catalog = buildManifest({ runtime, store, limit: 5 });
    const manifest = (({ _diariesByIntel, ...m }) => m)(catalog);
    expect(manifest.round_count).toBeGreaterThanOrEqual(1);
    const detail = buildRoundDetail({
      runtime,
      store,
      cycleId: 'cycle-20260528-100000',
      diariesByIntel: catalog._diariesByIntel,
    });
    expect(detail.report_html).toContain('API test report');
  });

  it('buildCycleDetail without intel report', () => {
    const openCycleId = 'cycle-20260528-open-001';
    createCycle(root, TEST_SUBJECT, { cycleId: openCycleId, meta: { driver: 'daemon' } });
    const runtime = { runtimeRoot, subject: TEST_SUBJECT, dataNamespace: TEST_SUBJECT };
    const store = createIntelligenceStore({ baseDir: join(runtimeRoot, 'data', 'intelligence') });
    const detail = buildCycleDetail({
      projectRoot: root,
      runtime,
      store,
      cycleId: openCycleId,
    });
    expect(detail.cycle_id).toBe(openCycleId);
    expect(detail.has_report).toBe(false);
    expect(detail.steps.intel.status).toBe('pending');
  });
});

describe('createViewerApiServer', () => {
  let root;
  let runtimeRoot;
  let port;
  /** @type {ReturnType<createViewerApiServer>} */
  let apiCtx;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jea-viewer-api-srv-'));
    const fixture = setupViewerFixture(root);
    runtimeRoot = fixture.runtimeRoot;
    const cycleId = 'cycle-20260528-100000';
    const reportPath = resolveIntelReportPath(runtimeRoot, cycleId);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, '# report\n', 'utf-8');
    const store = createIntelligenceStore({ baseDir: join(runtimeRoot, 'data', 'intelligence') });
    store.recordIntelReport({
      cycle_id: cycleId,
      generated_at: '2026-05-28T02:00:00.000Z',
      md_path: reportPath,
      tldr: 'live test',
    });

    port = 41730 + Math.floor(Math.random() * 100);
    apiCtx = createViewerApiServer({
      runtime: { runtimeRoot, subject: TEST_SUBJECT, dataNamespace: TEST_SUBJECT },
      projectRoot: root,
      limit: 5,
      port,
      publicDir: evolutionViewerPublicDir(projectRoot),
    });
    await new Promise((resolve) => apiCtx.server.listen(port, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    if (apiCtx) await apiCtx.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('GET /api/manifest returns rounds metadata', async () => {
    const manifest = await httpGetJson(port, '/api/manifest');
    expect(manifest.round_count).toBeGreaterThanOrEqual(1);
    expect(manifest.subject).toBe('live-test');
    expect(manifest.rounds[0].cycle_id).toBe('cycle-20260528-100000');
  });

  it('GET /api/rounds/:id returns HTML detail', async () => {
    const detail = await httpGetJson(port, '/api/rounds/cycle-20260528-100000');
    expect(detail.cycle_id).toBe('cycle-20260528-100000');
    expect(detail.report_html).toContain('report');
  });

  it('GET /api/daemon returns worker and queue projection', async () => {
    createWorkerState(root, TEST_SUBJECT, { workerId: 'viewer-worker', staleMs: 60_000 });
    const openCycle = createCycle(root, TEST_SUBJECT, { meta: { driver: 'daemon' } });
    enqueueTask(root, TEST_SUBJECT, {
      type: 'intel',
      idempotencyKey: `${TEST_SUBJECT}:${openCycle.cycle_id}:intel`,
      input: { cycle_id: openCycle.cycle_id },
    });

    const daemon = await httpGetJson(port, '/api/daemon');
    expect(daemon.subject).toBe(TEST_SUBJECT);
    expect(daemon.worker.running).toBe(true);
    expect(daemon.health.status).toBeTruthy();
    expect(daemon.tasks.counts.pending).toBeGreaterThanOrEqual(1);
    expect(daemon.cycles.open_count).toBeGreaterThanOrEqual(1);
    expect(daemon.tick_ms).toBe(300_000);
    expect(daemon.evolution_mode).toBe('continuous');
    expect(daemon.evolution_mode_source).toBeTruthy();
  });

  it('GET /api/cycles/:id returns cycle detail without report', async () => {
    const openCycle = createCycle(root, TEST_SUBJECT, { meta: { driver: 'daemon' } });
    const detail = await httpGetJson(port, `/api/cycles/${openCycle.cycle_id}`);
    expect(detail.cycle_id).toBe(openCycle.cycle_id);
    expect(detail.has_report).toBe(false);
    expect(detail.steps.intel.status).toBe('pending');
  });

  it('GET /api/events/recent returns daemon events', async () => {
    const store = createIntelligenceStore({ baseDir: join(runtimeRoot, 'data', 'intelligence') });
    store.recordEvolutionEvent({
      subject: TEST_SUBJECT,
      type: 'daemon_tick',
      status: 'ok',
      recorded_at: '2026-05-28T02:00:00.000Z',
    });
    const body = await httpGetJson(port, '/api/events/recent?limit=5');
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(body.events[0].event_type).toBe('daemon_tick');
  });

  it('serves /events with hello event', async () => {
    const body = await httpGetText(port, '/events', 1500);
    expect(body).toContain('event: hello');
    expect(body).toContain('live-test');
  });

  it('broadcasts round_added when evolution-events line appended', async () => {
    const eventsDir = join(runtimeRoot, 'data', 'intelligence', 'evolution_events');
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, 'evolution-events.jsonl');

    let seen = '';
    const waitAdded = new Promise((resolve) => {
      const orig = apiCtx.sse.broadcast.bind(apiCtx.sse);
      apiCtx.sse.broadcast = (event, data) => {
        orig(event, data);
        if (event === 'round_added') {
          seen = event;
          resolve();
        }
      };
    });

    const line = JSON.stringify({
      type: 'intel_report',
      cycle_id: 'cycle-20260528-100001',
      recorded_at: '2026-05-28T03:00:00.000Z',
    });
    writeFileSync(eventsPath, `${line}\n`, 'utf-8');
    apiCtx.tailer.readNewBytes();

    await Promise.race([
      waitAdded,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no round_added')), 5000)),
    ]);
    expect(seen).toBe('round_added');
  });

  it('broadcasts daemon_event when daemon_tick appended', async () => {
    const eventsDir = join(runtimeRoot, 'data', 'intelligence', 'evolution_events');
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, 'evolution-events.jsonl');

    let seen = '';
    const waitDaemon = new Promise((resolve) => {
      const orig = apiCtx.sse.broadcast.bind(apiCtx.sse);
      apiCtx.sse.broadcast = (event, data) => {
        orig(event, data);
        if (event === 'daemon_event') {
          seen = event;
          resolve();
        }
      };
    });

    const line = JSON.stringify({
      type: 'daemon_tick',
      status: 'ok',
      recorded_at: '2026-05-28T04:00:00.000Z',
    });
    writeFileSync(eventsPath, `${line}\n`, 'utf-8');
    apiCtx.tailer.readNewBytes();

    await Promise.race([
      waitDaemon,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no daemon_event')), 5000)),
    ]);
    expect(seen).toBe('daemon_event');
  });

  it('broadcasts round_updated after intel+exec pairing in events file', async () => {
    const eventsDir = join(runtimeRoot, 'data', 'intelligence', 'evolution_events');
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, 'evolution-events.jsonl');

    const intelLine = JSON.stringify({
      type: 'intel_report',
      cycle_id: 'cycle-20260528-100000',
      recorded_at: '2026-05-28T02:00:00.000Z',
    });
    const diaryLine = JSON.stringify({
      type: 'evolution_diary',
      cycle_id: 'exec-20260528-100100',
      status: 'ok',
      recorded_at: '2026-05-28T02:30:00.000Z',
    });
    writeFileSync(eventsPath, `${intelLine}\n`, 'utf-8');
    apiCtx.tailer.readNewBytes();

    let seen = '';
    const waitUpdated = new Promise((resolve) => {
      const orig = apiCtx.sse.broadcast.bind(apiCtx.sse);
      apiCtx.sse.broadcast = (event, data) => {
        orig(event, data);
        if (event === 'round_updated') {
          seen = event;
          resolve();
        }
      };
    });

    appendFileSync(eventsPath, `${diaryLine}\n`, 'utf-8');
    apiCtx.tailer.readNewBytes();

    await Promise.race([
      waitUpdated,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no round_updated')), 5000)),
    ]);
    expect(seen).toBe('round_updated');
  });
});
