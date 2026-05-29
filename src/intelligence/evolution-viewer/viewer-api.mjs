import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, relative } from 'node:path';
import { createIntelligenceStore } from '../store.mjs';
import { buildManifest, manifestForApi } from './round-catalog.mjs';
import { buildRoundDetail } from './round-detail.mjs';
import { buildIntelToExecMapFromRuntimeSync } from './event-pairing.mjs';

const PING_INTERVAL_MS = 25_000;
const DEFAULT_CACHE_SIZE = 30;

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
export function createEvolutionEventsTailer({ runtimeRoot, sse, onInvalidateCache }) {
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
      const sseEv = sseEventFromEvolutionLine(event, runtimeRoot);
      if (!sseEv) continue;
      if (sseEv.type === 'round_updated') {
        onInvalidateCache?.(sseEv.cycle_id);
      }
      sse.broadcast(sseEv.type, {
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

/**
 * @param {object} options
 * @param {object} options.runtime
 * @param {number} options.limit
 * @param {number} options.port
 * @param {string} options.publicDir
 */
export function createViewerApiServer({ runtime, limit, port, publicDir }) {
  const baseDir = join(runtime.runtimeRoot, 'data', 'intelligence');
  const store = createIntelligenceStore({ baseDir, timezone: 'Asia/Shanghai' });
  const sse = new SseHub();
  sse.start();

  const detailCache = new LruCache(DEFAULT_CACHE_SIZE);
  let catalogCache = null;
  let catalogCacheAt = 0;
  const CATALOG_TTL_MS = 2000;

  function getCatalog(force = false) {
    const now = Date.now();
    if (!force && catalogCache && now - catalogCacheAt < CATALOG_TTL_MS) {
      return catalogCache;
    }
    catalogCache = buildManifest({ runtime, store, limit });
    catalogCacheAt = now;
    return catalogCache;
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

  const tailer = createEvolutionEventsTailer({
    runtimeRoot: runtime.runtimeRoot,
    sse,
    onInvalidateCache: (cycleId) => {
      detailCache.delete(cycleId);
      catalogCacheAt = 0;
    },
  });
  tailer.start();

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
    invalidateAll() {
      detailCache.clear();
      catalogCacheAt = 0;
    },
    async close() {
      tailer.stop();
      sse.stop();
      await new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
