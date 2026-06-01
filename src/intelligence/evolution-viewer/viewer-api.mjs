import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, relative } from 'node:path';
import { createIntelligenceStore } from '../store.mjs';
import { buildDaemonProjection } from '../../cli/utils/daemon-projection.mjs';
import { buildManifest, manifestForApi } from './round-catalog.mjs';
import { buildRoundDetail } from './round-detail.mjs';
import { buildCycleDetail } from './cycle-detail.mjs';
import {
  daemonSseFromEvolutionLine,
  readRecentDaemonEvents,
  readTickHints,
} from './daemon-sse.mjs';
import { buildIntelToExecMapFromRuntimeSync } from './event-pairing.mjs';

const PING_INTERVAL_MS = 25_000;
const DEFAULT_CACHE_SIZE = 30;
const RUNTIME_WATCH_DEBOUNCE_MS = 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * @param {string} event
 * @param {object} data
 * @returns {string}
 */
export function formatSseMessage(event, data = {}) {
  const payload = JSON.stringify({ event, ...data });
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export class SseHub {
  /** @type {Set<import('node:http').ServerResponse>} */
  clients = new Set();
  /** @type {ReturnType<typeof setInterval> | null} */
  pingTimer = null;

  constructor({ pingIntervalMs = PING_INTERVAL_MS } = {}) {
    this.pingIntervalMs = pingIntervalMs;
  }

  start() {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  attach(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  ping() {
    this.broadcast('ping', {});
  }

  broadcast(event, data = {}) {
    const chunk = formatSseMessage(event, data);
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

class LruCache {
  /**
   * @param {number} maxSize
   */
  constructor(maxSize) {
    this.maxSize = maxSize;
    /** @type {Map<string, object>} */
    this.map = new Map();
  }

  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

function evolutionEventsPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
}

/**
 * Resolve intel cycle_id for an exec_id using event pairing map.
 * @param {string} runtimeRoot
 * @param {string} execId
 * @returns {string|null}
 */
function intelCycleForExec(runtimeRoot, execId) {
  const map = buildIntelToExecMapFromRuntimeSync(runtimeRoot);
  for (const [intelId, execIds] of map) {
    if (execIds.includes(execId)) return intelId;
  }
  return null;
}

/**
 * @param {object} event - parsed JSONL line
 * @returns {{ type: 'round_added'|'round_updated', cycle_id: string, has_diary?: boolean }|null}
 */
export function sseEventFromEvolutionLine(event, runtimeRoot) {
  const cycleId = event?.cycle_id;
  if (!cycleId) return null;

  if (event.type === 'intel_report' && cycleId.startsWith('cycle-')) {
    return { type: 'round_added', cycle_id: cycleId };
  }

  if (
    event.type === 'evolution_diary'
    && cycleId.startsWith('exec-')
    && (event.status === 'ok' || event.status == null)
  ) {
    const intelId = intelCycleForExec(runtimeRoot, cycleId);
    if (!intelId) return null;
    return { type: 'round_updated', cycle_id: intelId, has_diary: true };
  }

  if (
    (event.type === 'cycle_step_completed' || event.type === 'cycle_event_dispatched')
    && cycleId.startsWith('cycle-')
  ) {
    return { type: 'round_updated', cycle_id: cycleId };
  }

  return null;
}

/**
 * Tail evolution-events.jsonl and emit SSE on new lines.
 */
export function createEvolutionEventsTailer({ runtimeRoot, sse, onInvalidateCache, onDaemonEvent }) {
  const path = evolutionEventsPath(runtimeRoot);
  let offset = 0;
  let partial = '';
  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null;

  function syncOffsetToEnd() {
    if (!existsSync(path)) {
      offset = 0;
      return;
    }
    try {
      offset = statSync(path).size;
    } catch {
      offset = 0;
    }
  }

  function processChunk(chunk) {
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const daemonEv = daemonSseFromEvolutionLine(event);
      if (daemonEv) {
        sse.broadcast('daemon_event', { event: 'daemon_event', ...daemonEv.payload });
        onDaemonEvent?.(daemonEv.payload);
        if (daemonEv.payload.cycle_id) {
          onInvalidateCache?.(daemonEv.payload.cycle_id);
        }
      }

      const sseEv = sseEventFromEvolutionLine(event, runtimeRoot);
      if (!sseEv) continue;
      if (sseEv.type === 'round_updated') {
        onInvalidateCache?.(sseEv.cycle_id);
      }
      sse.broadcast(sseEv.type, {
        event: sseEv.type,
        cycle_id: sseEv.cycle_id,
        ...(sseEv.has_diary != null ? { has_diary: sseEv.has_diary } : {}),
      });
    }
  }

  function readNewBytes() {
    if (!existsSync(path)) return;
    try {
      const size = statSync(path).size;
      if (size < offset) {
        offset = 0;
        partial = '';
      }
      if (size <= offset) return;
      const fd = readFileSync(path);
      const slice = fd.subarray(offset, size);
      offset = size;
      processChunk(slice.toString('utf-8'));
    } catch {
      // ignore read races
    }
  }

  function start() {
    syncOffsetToEnd();
    if (!existsSync(path)) return;
    try {
      watcher = watch(path, () => readNewBytes());
    } catch {
      // ignore
    }
  }

  function stop() {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watcher = null;
    }
  }

  return { start, stop, readNewBytes, path };
}

/**
 * Watch runtime daemon files and emit runtime_updated SSE (debounced).
 */
export function createRuntimeWatcher({ runtimeRoot, projectRoot = null, sse, onRuntimeChange }) {
  const paths = [
    join(runtimeRoot, 'data', 'evolution', 'tasks', 'pending_tasks.json'),
    join(runtimeRoot, 'data', 'evolution', 'daemon', 'worker-state.json'),
    join(runtimeRoot, 'data', 'evolution', 'views', 'current-state.json'),
    join(runtimeRoot, 'data', 'evolution', 'cycle-state'),
    join(runtimeRoot, 'data', 'channel', 'worker-state.json'),
    join(runtimeRoot, 'data', 'channel', 'tasks', 'pending_tasks.json'),
    join(runtimeRoot, 'data', 'channel', 'events.jsonl'),
    join(runtimeRoot, 'data', 'channel', 'inbound'),
    join(runtimeRoot, 'data', 'channel', 'outbox'),
  ];
  if (projectRoot) {
    paths.push(join(projectRoot, 'policies', 'subjects.json'));
  }

  /** @type {import('node:fs').FSWatcher[]} */
  const watchers = [];
  let debounceTimer = null;

  function notify() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onRuntimeChange?.();
      sse.broadcast('runtime_updated', { event: 'runtime_updated' });
    }, RUNTIME_WATCH_DEBOUNCE_MS);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  function start() {
    for (const target of paths) {
      if (!existsSync(target)) continue;
      try {
        const watcher = watch(target, notify);
        watchers.push(watcher);
      } catch {
        // ignore
      }
    }
  }

  function stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.length = 0;
  }

  return { start, stop };
}

async function serveStatic(publicDir, pathname, res) {
  let path = pathname;
  if (path === '/') path = '/index.html';
  const filePath = resolve(publicDir, path.replace(/^\/+/, ''));
  const rel = relative(resolve(publicDir), filePath);
  if (rel.startsWith('..') || rel.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const body = await readFile(filePath);
  const ext = extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  res.end(body);
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function buildDaemonApiResponse(projectRoot, runtime, store) {
  const projection = buildDaemonProjection(projectRoot, runtime.subject, {
    store,
    eventLimit: 30,
  });
  const tickHints = readTickHints(store, runtime.subject, 50);
  return {
    ...projection,
    tick_ms: tickHints.tick_ms,
    last_tick_at: tickHints.last_tick_at,
  };
}

/**
 * @param {object} options
 * @param {object} options.runtime
 * @param {string} options.projectRoot
 * @param {number} options.limit
 * @param {number} options.port
 * @param {string} options.publicDir
 */
export function createViewerApiServer({ runtime, projectRoot, limit, port, publicDir }) {
  if (!projectRoot) throw new Error('projectRoot is required');

  const baseDir = join(runtime.runtimeRoot, 'data', 'intelligence');
  const store = createIntelligenceStore({ baseDir, timezone: 'Asia/Shanghai' });
  const sse = new SseHub();
  sse.start();

  const detailCache = new LruCache(DEFAULT_CACHE_SIZE);
  const cycleDetailCache = new LruCache(DEFAULT_CACHE_SIZE);
  let catalogCache = null;
  let catalogCacheAt = 0;
  let daemonCache = null;
  let daemonCacheAt = 0;
  const CATALOG_TTL_MS = 2000;

  function invalidateRuntimeCaches(cycleId = null) {
    catalogCacheAt = 0;
    daemonCacheAt = 0;
    if (cycleId) {
      detailCache.delete(cycleId);
      cycleDetailCache.delete(cycleId);
    }
  }

  function getCatalog(force = false) {
    const now = Date.now();
    if (!force && catalogCache && now - catalogCacheAt < CATALOG_TTL_MS) {
      return catalogCache;
    }
    catalogCache = buildManifest({ runtime, store, limit });
    catalogCacheAt = now;
    return catalogCache;
  }

  function getDaemon(force = false) {
    const now = Date.now();
    if (!force && daemonCache && now - daemonCacheAt < CATALOG_TTL_MS) {
      return daemonCache;
    }
    daemonCache = buildDaemonApiResponse(projectRoot, runtime, store);
    daemonCacheAt = now;
    return daemonCache;
  }

  function getRoundDetail(cycleId) {
    const cached = detailCache.get(cycleId);
    if (cached) return cached;
    const catalog = getCatalog();
    const detail = buildRoundDetail({
      runtime,
      store,
      cycleId,
      diariesByIntel: catalog._diariesByIntel,
    });
    if (detail) detailCache.set(cycleId, detail);
    return detail;
  }

  function getCycleDetail(cycleId) {
    const cached = cycleDetailCache.get(cycleId);
    if (cached) return cached;
    const catalog = getCatalog();
    const detail = buildCycleDetail({
      projectRoot,
      runtime,
      store,
      cycleId,
      diariesByIntel: catalog._diariesByIntel,
    });
    if (detail) cycleDetailCache.set(cycleId, detail);
    return detail;
  }

  const tailer = createEvolutionEventsTailer({
    runtimeRoot: runtime.runtimeRoot,
    sse,
    onInvalidateCache: (cycleId) => invalidateRuntimeCaches(cycleId),
    onDaemonEvent: () => {
      daemonCacheAt = 0;
    },
  });
  tailer.start();

  const runtimeWatcher = createRuntimeWatcher({
    runtimeRoot: runtime.runtimeRoot,
    projectRoot,
    sse,
    onRuntimeChange: () => invalidateRuntimeCaches(),
  });
  runtimeWatcher.start();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/events') {
        const catalog = manifestForApi(getCatalog());
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(formatSseMessage('hello', {
          event: 'hello',
          subject: runtime.subject,
          namespace: runtime.dataNamespace,
          round_count: catalog.round_count ?? catalog.rounds?.length ?? 0,
        }));
        sse.attach(res);
        return;
      }

      if (pathname === '/api/manifest') {
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : limit;
        const catalog = buildManifest({ runtime, store, limit: effectiveLimit });
        catalogCache = catalog;
        catalogCacheAt = Date.now();
        jsonResponse(res, 200, manifestForApi(catalog));
        return;
      }

      if (pathname === '/api/daemon') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(getDaemon()));
        return;
      }

      if (pathname === '/api/events/recent') {
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 50;
        jsonResponse(res, 200, {
          events: readRecentDaemonEvents(store, runtime.subject, effectiveLimit),
        });
        return;
      }

      const cycleMatch = pathname.match(/^\/api\/cycles\/([^/]+)$/);
      if (cycleMatch) {
        const cycleId = cycleMatch[1];
        const detail = getCycleDetail(cycleId);
        if (!detail) {
          jsonResponse(res, 404, { error: 'cycle not found', cycle_id: cycleId });
          return;
        }
        jsonResponse(res, 200, detail);
        return;
      }

      const roundMatch = pathname.match(/^\/api\/rounds\/([^/]+)$/);
      if (roundMatch) {
        const cycleId = roundMatch[1];
        const detail = getRoundDetail(cycleId);
        if (!detail) {
          jsonResponse(res, 404, { error: 'round not found', cycle_id: cycleId });
          return;
        }
        jsonResponse(res, 200, detail);
        return;
      }

      await serveStatic(publicDir, pathname, res);
    } catch (err) {
      sse.broadcast('error', { message: err?.message ?? String(err) });
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  });

  return {
    server,
    sse,
    tailer,
    runtimeWatcher,
    invalidateAll() {
      detailCache.clear();
      cycleDetailCache.clear();
      catalogCacheAt = 0;
      daemonCacheAt = 0;
    },
    async close() {
      tailer.stop();
      runtimeWatcher.stop();
      sse.stop();
      await new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
