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
import { buildManifest } from '../src/intelligence/evolution-viewer/round-catalog.mjs';
import { buildRoundDetail } from '../src/intelligence/evolution-viewer/round-detail.mjs';
import { evolutionViewerPublicDir } from '../src/intelligence/evolution-viewer/runtime-build.mjs';
import { resolveIntelReportPath } from '../src/intelligence/report-paths.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jea-viewer-api-'));
    runtimeRoot = join(root, 'runtime');
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
    const runtime = { runtimeRoot, subject: 'api-test', dataNamespace: 'api-test' };
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
});

describe('createViewerApiServer', () => {
  let root;
  let runtimeRoot;
  let port;
  /** @type {ReturnType<createViewerApiServer>} */
  let apiCtx;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jea-viewer-api-srv-'));
    runtimeRoot = join(root, 'runtime');
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
      runtime: { runtimeRoot, subject: 'live-test', dataNamespace: 'live-test' },
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
