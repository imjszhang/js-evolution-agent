import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve, relative } from 'node:path';
import { createIntelligenceStore } from '../store.mjs';
import { buildDaemonProjection } from '../../daemon/daemon-projection.mjs';
import { acknowledgeTask } from '../../daemon/daemon-tasks.mjs';
import { recordDaemonEvent } from '../../daemon/daemon-events.mjs';
import { buildChannelProjection } from '../../channel/projection.mjs';
import { readChannelEvents, recordChannelEvent } from '../../channel/audit.mjs';
import { requestChannelWorkerStop } from '../../channel/worker-state.mjs';
import {
  channelInboundPendingDir,
  channelInboundProcessedDir,
  channelOutboxPendingDir,
  channelOutboxSentDir,
} from '../../channel/paths.mjs';
import { reconcilePendingSpeechGeneration } from '../../channel/state.mjs';
import { buildManifest, manifestForApi } from './round-catalog.mjs';
import { buildRoundDetail } from './round-detail.mjs';
import { buildCycleDetail } from './cycle-detail.mjs';
import {
  daemonSseFromEvolutionLine,
  readRecentDaemonEvents,
  readTickHints,
} from './daemon-sse.mjs';
import { buildIntelToExecMapFromRuntimeSync } from './event-pairing.mjs';
import {
  buildSubjectObservability,
  cycleDiagnosticsForId,
} from './observability-projection.mjs';
import {
  createJsonlTailer,
  createRuntimeWatcher as createSharedRuntimeWatcher,
  summarizeChannelDir,
  summarizeInboundFile,
  summarizeOutboxFile,
} from './runtime-watch.mjs';
import { getCachedLinkHealthSummary } from '../../infra/links/index.mjs';

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
 * @param {object} runtime
 * @param {object} daemon
 */
export function daemonSummaryFromProjection(runtime, daemon, { runtimeRoot = null } = {}) {
  const counts = daemon.tasks?.counts ?? {};
  const channel = daemon.channel ?? {};
  let attention = { count: 0, highest_severity: null, critical: 0, warning: 0, info: 0 };
  if (runtimeRoot) {
    const obs = buildSubjectObservability({
      subject: runtime.subject,
      runtimeRoot,
      daemon,
    });
    attention = obs.attention.summary;
  }
  return {
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    health: daemon.health?.status ?? 'unknown',
    health_ok: daemon.health?.ok ?? null,
    evolution_mode: daemon.evolution_mode ?? null,
    worker_running: Boolean(daemon.worker?.running),
    worker_stale: Boolean(daemon.worker?.stale),
    open_cycles: daemon.cycles?.open_count ?? 0,
    pending_tasks: counts.pending ?? 0,
    running_tasks: counts.running ?? 0,
    channel_inbound_pending: channel.inbound?.pending_count ?? 0,
    channel_outbox_pending: channel.outbox?.pending_count ?? 0,
    last_tick_at: daemon.last_tick_at ?? null,
    attention,
  };
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
 * @param {object} subjectMeta
 * @param {string} subjectMeta.subject
 * @param {string} subjectMeta.namespace
 */
function withSubjectMeta(subjectMeta, data = {}) {
  return {
    subject: subjectMeta.subject,
    namespace: subjectMeta.namespace,
    ...data,
  };
}

/**
 * Tail evolution-events.jsonl and emit SSE on new lines.
 */
export function createEvolutionEventsTailer({
  runtimeRoot,
  subjectMeta,
  sse,
  onInvalidateCache,
  onDaemonEvent,
}) {
  const path = evolutionEventsPath(runtimeRoot);
  const tailer = createJsonlTailer({
    path,
    onRecord(event) {
      const daemonEv = daemonSseFromEvolutionLine(event);
      if (daemonEv) {
        const payload = withSubjectMeta(subjectMeta, {
          event: 'daemon_event',
          ...daemonEv.payload,
        });
        sse.broadcast('daemon_event', payload);
        onDaemonEvent?.(payload);
        if (daemonEv.payload.cycle_id) {
          onInvalidateCache?.(daemonEv.payload.cycle_id);
        }
      }

      const sseEv = sseEventFromEvolutionLine(event, runtimeRoot);
      if (!sseEv) continue;
      if (sseEv.type === 'round_updated') {
        onInvalidateCache?.(sseEv.cycle_id);
      }
      sse.broadcast(sseEv.type, withSubjectMeta(subjectMeta, {
        event: sseEv.type,
        cycle_id: sseEv.cycle_id,
        ...(sseEv.has_diary != null ? { has_diary: sseEv.has_diary } : {}),
      }));
    },
  });
  return {
    start: tailer.start,
    stop: tailer.stop,
    readNewBytes: tailer.readNewBytes,
    reconcile: tailer.reconcile,
    path,
  };
}

function channelEventsFilePath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'channel', 'events.jsonl');
}

/**
 * Map a channel audit record to an SSE payload.
 * @param {object} event
 * @returns {object|null}
 */
export function formatChannelEventForApi(event) {
  if (!event?.type) return null;
  return {
    id: event.id ?? null,
    event_type: event.type,
    type: event.type,
    status: event.status ?? null,
    task_id: event.task_id ?? null,
    task_type: event.task_type ?? null,
    message_id: event.message_id ?? null,
    ingest_kind: event.ingest_kind ?? null,
    reason: event.reason ?? null,
    recorded_at: event.recorded_at ?? event.timestamp ?? null,
  };
}

/**
 * Tail channel/events.jsonl and emit channel_event SSE on new lines.
 */
export function createChannelEventsTailer({ runtimeRoot, subjectMeta, sse, onChannelEvent }) {
  const path = channelEventsFilePath(runtimeRoot);
  const tailer = createJsonlTailer({
    path,
    onRecord(event) {
      const payload = formatChannelEventForApi(event);
      if (!payload) return;
      const enriched = withSubjectMeta(subjectMeta, { event: 'channel_event', ...payload });
      sse.broadcast('channel_event', enriched);
      onChannelEvent?.(enriched);
    },
  });
  return {
    start: tailer.start,
    stop: tailer.stop,
    readNewBytes: tailer.readNewBytes,
    reconcile: tailer.reconcile,
    path,
  };
}

/**
 * Watch runtime daemon files and emit runtime_updated SSE (debounced).
 */
export function createRuntimeWatcher({
  runtimeRoot,
  projectRoot = null,
  subjectMeta,
  sse,
  onRuntimeChange,
  watchSubjectsJson = true,
}) {
  return createSharedRuntimeWatcher({
    runtimeRoot,
    projectRoot,
    subjectMeta,
    onRuntimeChange,
    watchSubjectsJson,
    onNotify: () => {
      sse.broadcast('runtime_updated', withSubjectMeta(subjectMeta, { event: 'runtime_updated' }));
    },
  });
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

function readRequestJson(req, { maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
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
 * @param {object} runtime
 * @param {string} projectRoot
 * @param {number} catalogLimit
 */
function createSubjectContext(runtime, projectRoot, catalogLimit) {
  const baseDir = join(runtime.runtimeRoot, 'data', 'intelligence');
  const store = createIntelligenceStore({ baseDir, timezone: 'Asia/Shanghai' });
  const subjectMeta = { subject: runtime.subject, namespace: runtime.dataNamespace };

  const detailCache = new LruCache(DEFAULT_CACHE_SIZE);
  const cycleDetailCache = new LruCache(DEFAULT_CACHE_SIZE);
  let catalogCache = null;
  let catalogCacheAt = 0;
  let daemonCache = null;
  let daemonCacheAt = 0;
  let observabilityCache = null;
  let observabilityCacheAt = 0;
  const CATALOG_TTL_MS = 2000;

  function invalidateRuntimeCaches(cycleId = null) {
    catalogCacheAt = 0;
    daemonCacheAt = 0;
    observabilityCacheAt = 0;
    if (cycleId) {
      detailCache.delete(cycleId);
      cycleDetailCache.delete(cycleId);
    }
  }

  function getCatalog(force = false, effectiveLimit = catalogLimit) {
    const now = Date.now();
    if (!force && catalogCache && now - catalogCacheAt < CATALOG_TTL_MS) {
      return catalogCache;
    }
    catalogCache = buildManifest({ runtime, store, limit: effectiveLimit });
    catalogCacheAt = now;
    return catalogCache;
  }

  function bumpDaemonCache() {
    daemonCacheAt = 0;
  }

  function invalidateCachesIfPendingSpeechReconciled() {
    const { changed } = reconcilePendingSpeechGeneration(projectRoot, runtime.subject);
    if (!changed) return false;
    daemonCacheAt = 0;
    observabilityCacheAt = 0;
    return true;
  }

  function getDaemon(force = false) {
    const now = Date.now();
    if (invalidateCachesIfPendingSpeechReconciled()) {
      force = true;
    }
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

  function getObservability(force = false) {
    const now = Date.now();
    if (invalidateCachesIfPendingSpeechReconciled()) {
      force = true;
    }
    if (!force && observabilityCache && now - observabilityCacheAt < CATALOG_TTL_MS) {
      return observabilityCache;
    }
    const daemon = getDaemon(force);
    observabilityCache = buildSubjectObservability({
      subject: runtime.subject,
      runtimeRoot: runtime.runtimeRoot,
      daemon,
      repo_links: getCachedLinkHealthSummary(projectRoot),
    });
    observabilityCacheAt = now;
    return observabilityCache;
  }

  function getChannel(force = false) {
    return buildChannelProjection(projectRoot, runtime.subject, { eventLimit: 30 });
  }

  function acknowledgeAttentionItem(request = {}) {
    const obs = getObservability(true);
    const kind = String(request.kind ?? '').trim();
    const taskId = request.task_id ? String(request.task_id).trim() : null;
    const item = (obs.attention?.items ?? []).find((candidate) => {
      if (candidate.kind !== kind) return false;
      if (candidate.status !== 'needs_ack' && candidate.category !== 'history') return false;
      if (taskId) return candidate.refs?.task_id === taskId;
      return kind === 'channel_health';
    });
    if (!item) {
      return { ok: false, status: 404, error: 'acknowledgeable attention item not found' };
    }

    if (kind === 'task_failed') {
      if (!taskId) return { ok: false, status: 400, error: 'task_id required' };
      const acknowledged = acknowledgeTask(projectRoot, runtime.subject, taskId, 'viewer_attention_acknowledge');
      recordDaemonEvent(projectRoot, runtime.subject, {
        type: 'task_acknowledged',
        status: 'ok',
        task_id: acknowledged.task.task_id,
        task_type: acknowledged.task.type,
        source: 'viewer',
      });
      invalidateRuntimeCaches();
      return { ok: true, action: 'daemon_task_acknowledged', task: acknowledged.task };
    }

    if (kind === 'channel_health') {
      const result = requestChannelWorkerStop(projectRoot, runtime.subject);
      recordChannelEvent(projectRoot, runtime.subject, {
        type: 'channel_attention_acknowledged',
        status: 'ok',
        attention_kind: kind,
        action: 'channel_worker_stale_marked_stopped',
        reason: result.reason,
      });
      invalidateRuntimeCaches();
      return { ok: true, action: 'channel_worker_stale_acknowledged', result };
    }

    return { ok: false, status: 400, error: `unsupported attention kind: ${kind}` };
  }

  function acknowledgeAttentionItems(request = {}) {
    if (!request.all) return acknowledgeAttentionItem(request);
    const obs = getObservability(true);
    const items = (obs.attention?.items ?? [])
      .filter((item) => (item.status === 'needs_ack' || item.category === 'history')
        && (item.kind === 'channel_health' || (item.kind === 'task_failed' && item.refs?.task_id)));
    const results = [];
    for (const item of items) {
      const result = acknowledgeAttentionItem({
        kind: item.kind,
        task_id: item.refs?.task_id ?? null,
      });
      results.push({
        kind: item.kind,
        task_id: item.refs?.task_id ?? null,
        ...result,
      });
    }
    const failed = results.filter((result) => !result.ok);
    return {
      ok: failed.length === 0,
      status: failed.length ? 207 : 200,
      action: 'attention_bulk_acknowledged',
      acknowledged: results.filter((result) => result.ok).length,
      failed: failed.length,
      results,
    };
  }

  function getChannelEvents(limit = 50) {
    return readChannelEvents(projectRoot, runtime.subject, { limit });
  }

  function listChannelInbound(status = 'pending', limit = 20) {
    const dir = status === 'processed'
      ? channelInboundProcessedDir(projectRoot, runtime.subject)
      : channelInboundPendingDir(projectRoot, runtime.subject);
    return summarizeChannelDir(dir, summarizeInboundFile, limit);
  }

  function listChannelOutbox(status = 'pending', limit = 20) {
    const dir = status === 'sent'
      ? channelOutboxSentDir(projectRoot, runtime.subject)
      : channelOutboxPendingDir(projectRoot, runtime.subject);
    return summarizeChannelDir(dir, summarizeOutboxFile, limit);
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
    if (!detail) return null;
    const obs = getObservability();
    detail.diagnostics = cycleDiagnosticsForId(cycleId, obs);
    detail.observability_attention = (obs.attention?.items ?? []).filter(
      (item) => item.refs?.cycle_id === cycleId,
    );
    cycleDetailCache.set(cycleId, detail);
    return detail;
  }

  return {
    runtime,
    store,
    subjectMeta,
    invalidateRuntimeCaches,
    getCatalog,
    getDaemon,
    getObservability,
    getRoundDetail,
    getCycleDetail,
    getChannel,
    getChannelEvents,
    acknowledgeAttentionItems,
    listChannelInbound,
    listChannelOutbox,
    bumpDaemonCache,
    clearCaches() {
      detailCache.clear();
      cycleDetailCache.clear();
      catalogCacheAt = 0;
      daemonCacheAt = 0;
      observabilityCacheAt = 0;
    },
  };
}

/**
 * @param {object} options
 * @param {object} [options.runtime] - single runtime (legacy)
 * @param {object[]} [options.runtimes] - multiple runtimes
 * @param {string} options.projectRoot
 * @param {number} options.limit
 * @param {number} options.port
 * @param {string} options.publicDir
 */
export function createViewerApiServer({ runtime, runtimes, projectRoot, limit, port, publicDir }) {
  if (!projectRoot) throw new Error('projectRoot is required');

  const runtimeList = runtimes?.length
    ? runtimes
    : runtime
      ? [runtime]
      : [];
  if (!runtimeList.length) throw new Error('runtime or runtimes is required');

  const defaultSubject = runtimeList[0].subject;
  /** @type {Map<string, ReturnType<createSubjectContext>>} */
  const contexts = new Map();
  for (const rt of runtimeList) {
    contexts.set(rt.subject, createSubjectContext(rt, projectRoot, limit));
  }

  function getContext(subjectName) {
    const ctx = contexts.get(subjectName);
    if (!ctx) return null;
    return ctx;
  }

  function resolveSubjectParam(subjectName) {
    if (subjectName && contexts.has(subjectName)) return subjectName;
    return defaultSubject;
  }

  const sse = new SseHub();
  sse.start();

  const tailers = [];
  const channelTailers = [];
  const runtimeWatchers = [];
  const multiSubject = runtimeList.length > 1;

  for (const rt of runtimeList) {
    const ctx = contexts.get(rt.subject);
    const tailer = createEvolutionEventsTailer({
      runtimeRoot: rt.runtimeRoot,
      subjectMeta: ctx.subjectMeta,
      sse,
      onInvalidateCache: (cycleId) => ctx.invalidateRuntimeCaches(cycleId),
      onDaemonEvent: () => {
        ctx.bumpDaemonCache();
      },
    });
    tailer.start();
    tailers.push(tailer);

    const channelTailer = createChannelEventsTailer({
      runtimeRoot: rt.runtimeRoot,
      subjectMeta: ctx.subjectMeta,
      sse,
      onChannelEvent: () => ctx.bumpDaemonCache(),
    });
    channelTailer.start();
    channelTailers.push(channelTailer);

    const runtimeWatcher = createRuntimeWatcher({
      runtimeRoot: rt.runtimeRoot,
      projectRoot,
      subjectMeta: ctx.subjectMeta,
      sse,
      onRuntimeChange: () => ctx.invalidateRuntimeCaches(),
      watchSubjectsJson: !multiSubject,
    });
    runtimeWatcher.start();
    runtimeWatchers.push(runtimeWatcher);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/events') {
        const defaultCtx = contexts.get(defaultSubject);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(formatSseMessage('hello', {
          event: 'hello',
          subject: defaultSubject,
          namespace: defaultCtx.runtime.dataNamespace,
          default_subject: defaultSubject,
        }));
        sse.attach(res);
        try {
          const catalog = manifestForApi(defaultCtx.getCatalog(false, limit));
          const subjectEntries = runtimeList.map((rt) => {
            const ctx = contexts.get(rt.subject);
            const daemon = ctx.getDaemon();
            const summary = daemonSummaryFromProjection(rt, daemon, { runtimeRoot: rt.runtimeRoot });
            const m = manifestForApi(ctx.getCatalog(false, limit));
            return {
              ...summary,
              round_count: m.round_count ?? m.rounds?.length ?? 0,
            };
          });
          sse.broadcast('runtime_snapshot', {
            event: 'runtime_snapshot',
            subject: defaultSubject,
            namespace: defaultCtx.runtime.dataNamespace,
            default_subject: defaultSubject,
            subjects: subjectEntries,
            round_count: catalog.round_count ?? catalog.rounds?.length ?? 0,
          });
        } catch (error) {
          sse.broadcast('error', { message: error?.message ?? String(error) });
        }
        return;
      }

      if (pathname === '/api/subjects') {
        const summaries = runtimeList.map((rt) => {
          const ctx = contexts.get(rt.subject);
          const daemon = ctx.getDaemon();
          return daemonSummaryFromProjection(rt, daemon, { runtimeRoot: rt.runtimeRoot });
        });
        jsonResponse(res, 200, {
          default_subject: defaultSubject,
          subjects: summaries,
        });
        return;
      }

      const subjectBase = pathname.match(/^\/api\/subjects\/([^/]+)\/(.+)$/);
      if (subjectBase) {
        const subjectName = decodeURIComponent(subjectBase[1]);
        const rest = subjectBase[2];
        const ctx = getContext(subjectName);
        if (!ctx) {
          jsonResponse(res, 404, { error: 'subject not found', subject: subjectName });
          return;
        }
        if (rest === 'manifest') {
          const reqLimit = Number(url.searchParams.get('limit'));
          const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : limit;
          const catalog = ctx.getCatalog(true, effectiveLimit);
          jsonResponse(res, 200, manifestForApi(catalog));
          return;
        }
        if (rest === 'daemon') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(ctx.getDaemon()));
          return;
        }
        if (rest === 'events/recent') {
          const reqLimit = Number(url.searchParams.get('limit'));
          const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 50;
          jsonResponse(res, 200, {
            subject: subjectName,
            events: readRecentDaemonEvents(ctx.store, subjectName, effectiveLimit),
          });
          return;
        }
        if (rest === 'observability') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(ctx.getObservability()));
          return;
        }
        if (rest === 'attention/ack') {
          if (req.method !== 'POST') {
            jsonResponse(res, 405, { error: 'method not allowed' });
            return;
          }
          try {
            const body = await readRequestJson(req);
            const result = ctx.acknowledgeAttentionItems(body);
            if (!result.ok) {
              jsonResponse(res, result.status ?? 400, result);
              return;
            }
            jsonResponse(res, 200, result);
          } catch (err) {
            jsonResponse(res, 400, { ok: false, error: err?.message || String(err) });
          }
          return;
        }
        if (rest === 'channel') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(ctx.getChannel()));
          return;
        }
        if (rest === 'channel/events') {
          const reqLimit = Number(url.searchParams.get('limit'));
          const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 50;
          jsonResponse(res, 200, {
            subject: subjectName,
            events: ctx.getChannelEvents(effectiveLimit),
          });
          return;
        }
        if (rest === 'channel/inbound') {
          const status = url.searchParams.get('status') === 'processed' ? 'processed' : 'pending';
          const reqLimit = Number(url.searchParams.get('limit'));
          const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 20;
          jsonResponse(res, 200, {
            subject: subjectName,
            status,
            files: ctx.listChannelInbound(status, effectiveLimit),
          });
          return;
        }
        if (rest === 'channel/outbox') {
          const status = url.searchParams.get('status') === 'sent' ? 'sent' : 'pending';
          const reqLimit = Number(url.searchParams.get('limit'));
          const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 20;
          jsonResponse(res, 200, {
            subject: subjectName,
            status,
            files: ctx.listChannelOutbox(status, effectiveLimit),
          });
          return;
        }
        const roundScoped = rest.match(/^rounds\/([^/]+)$/);
        if (roundScoped) {
          const cycleId = roundScoped[1];
          const detail = ctx.getRoundDetail(cycleId);
          if (!detail) {
            jsonResponse(res, 404, { error: 'round not found', cycle_id: cycleId, subject: subjectName });
            return;
          }
          jsonResponse(res, 200, detail);
          return;
        }
        const cycleScoped = rest.match(/^cycles\/([^/]+)$/);
        if (cycleScoped) {
          const cycleId = cycleScoped[1];
          const detail = ctx.getCycleDetail(cycleId);
          if (!detail) {
            jsonResponse(res, 404, { error: 'cycle not found', cycle_id: cycleId, subject: subjectName });
            return;
          }
          jsonResponse(res, 200, detail);
          return;
        }
      }

      const legacySubject = resolveSubjectParam(url.searchParams.get('subject'));
      const legacyCtx = contexts.get(legacySubject);

      if (pathname === '/api/manifest') {
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : limit;
        const catalog = legacyCtx.getCatalog(true, effectiveLimit);
        jsonResponse(res, 200, manifestForApi(catalog));
        return;
      }

      if (pathname === '/api/daemon') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(legacyCtx.getDaemon()));
        return;
      }

      if (pathname === '/api/observability') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(legacyCtx.getObservability()));
        return;
      }

      if (pathname === '/api/events/recent') {
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 50;
        jsonResponse(res, 200, {
          subject: legacySubject,
          events: readRecentDaemonEvents(legacyCtx.store, legacySubject, effectiveLimit),
        });
        return;
      }

      if (pathname === '/api/channel') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(legacyCtx.getChannel()));
        return;
      }

      if (pathname === '/api/channel/events') {
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 50;
        jsonResponse(res, 200, {
          subject: legacySubject,
          events: legacyCtx.getChannelEvents(effectiveLimit),
        });
        return;
      }

      if (pathname === '/api/channel/inbound') {
        const status = url.searchParams.get('status') === 'processed' ? 'processed' : 'pending';
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 20;
        jsonResponse(res, 200, {
          subject: legacySubject,
          status,
          files: legacyCtx.listChannelInbound(status, effectiveLimit),
        });
        return;
      }

      if (pathname === '/api/channel/outbox') {
        const status = url.searchParams.get('status') === 'sent' ? 'sent' : 'pending';
        const reqLimit = Number(url.searchParams.get('limit'));
        const effectiveLimit = Number.isFinite(reqLimit) && reqLimit > 0 ? reqLimit : 20;
        jsonResponse(res, 200, {
          subject: legacySubject,
          status,
          files: legacyCtx.listChannelOutbox(status, effectiveLimit),
        });
        return;
      }

      const cycleMatch = pathname.match(/^\/api\/cycles\/([^/]+)$/);
      if (cycleMatch) {
        const cycleId = cycleMatch[1];
        const detail = legacyCtx.getCycleDetail(cycleId);
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
        const detail = legacyCtx.getRoundDetail(cycleId);
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
    tailer: tailers[0],
    tailers,
    channelTailers,
    runtimeWatcher: runtimeWatchers[0],
    runtimeWatchers,
    defaultSubject,
    contexts,
    invalidateAll() {
      for (const ctx of contexts.values()) ctx.clearCaches();
    },
    async close() {
      for (const tailer of tailers) tailer.stop();
      for (const tailer of channelTailers) tailer.stop();
      for (const watcher of runtimeWatchers) watcher.stop();
      sse.stop();
      await new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    },
  };
}
