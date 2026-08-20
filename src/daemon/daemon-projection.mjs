import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { writeJson } from '../infra/json-store.mjs';
import { createRuntimeContext } from '../infra/jea-home.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';
import { pendingTasksPath, readTaskQueue, summarizeTaskQueue } from './daemon-tasks.mjs';
import { readWorkerState, summarizeWorkerState, workerStatePath } from './daemon-worker-state.mjs';
import { buildCycleProjection } from './cycle-dispatch.mjs';
import { findStuckSteps, findStepStateDrift, getLastClosedCycle, isCycleProgressStalled, listOpenCycles, summarizeCycleState } from './cycle-state.mjs';
import { readPendingCycleStartRequest } from './cycle-start-requests.mjs';
import { resolveEvolutionMode } from './evolution-mode.mjs';
import { resolveCyclePipeline } from './cycle-pipeline-mode.mjs';
import { isReactorPipeline } from './cycle-pipeline-mode.mjs';
import { buildReactorHealthProjection } from './reactor-health.mjs';
import { isTickOpenCycleEnabled } from './cycle-dispatch.mjs';
import { buildChannelProjection } from '../channel/projection.mjs';
import { channelEventsPath, channelTasksDir, channelWorkerStatePath } from '../channel/paths.mjs';
import { claimsPath } from '../evolution/reactor/paths.mjs';
import {
  dirIdentitySignature,
  evidenceSourceSignature,
  fileIdentitySignature,
} from '../intelligence/evidence-stream.mjs';

export const DAEMON_PROJECTION_CACHE_LIMIT = 8;
export const DAEMON_PROJECTION_WORKER_TIMEOUT_MS = 30_000;

export function daemonViewsDir(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'views');
}

export function currentStatePath(root, subject) {
  return join(daemonViewsDir(root, subject), 'current-state.json');
}

export const DEFAULT_TICK_MS = 5 * 60 * 1000;

const TICK_ACTIVITY_EVENT_TYPES = new Set([
  'daemon_tick',
  'cycle_due',
  'cycle_step_enqueued',
]);

function hasRecentTickActivity(events, tickMs, nowMs = Date.now()) {
  for (const event of events) {
    if (!TICK_ACTIVITY_EVENT_TYPES.has(event.type)) continue;
    const recorded = Date.parse(event.recorded_at ?? '');
    if (Number.isFinite(recorded) && nowMs - recorded < tickMs) {
      return true;
    }
  }
  return false;
}

function buildDaemonHealth({
  worker,
  tasks,
  cycles = {},
  lastClosedCycle = null,
  recentEvents = [],
  tickMs = DEFAULT_TICK_MS,
  evolutionMode = 'continuous',
  pendingCycleStartRequest = null,
  progressStalled = false,
  driftSteps = [],
  tickOpenEnabled = false,
  reactorHealth = null,
  pipeline = null,
  nowMs = Date.now(),
}) {
  const counts = tasks.counts || {};
  const pending = counts.pending || 0;
  const running = counts.running || 0;
  const failed = counts.failed || 0;
  const active = pending + running;
  const openCount = cycles.open_count ?? 0;
  const reasons = [];
  const suggestions = [];
  let status = 'healthy';
  let ok = true;

  if (tasks.expired_running_count > 0) {
    status = 'blocked';
    ok = false;
    reasons.push(`${tasks.expired_running_count} running task lease(s) have expired`);
    suggestions.push('Run `jea daemon work --once` or restart the daemon worker to reclaim expired leases.');
  } else if (worker.zombie) {
    status = 'worker_zombie';
    ok = false;
    reasons.push(`Worker state shows running (pid=${worker.pid}) but the process is not alive`);
    suggestions.push('Run `jea daemon start` to start a fresh worker.');
  } else if (worker.stale) {
    status = 'stale';
    ok = false;
    reasons.push('Worker heartbeat is stale');
    suggestions.push('Run `jea daemon doctor` for details, or start a fresh daemon worker if the old process is gone.');
  } else if (pending > 0 && !worker.running) {
    status = 'blocked';
    ok = false;
    reasons.push(`${pending} pending task(s) are waiting but no fresh worker is running`);
    suggestions.push('Run `jea daemon start` in a foreground terminal, or use `jea daemon work --once`.');
  } else {
    const lastClosedMs = lastClosedCycle?.closed_at ? Date.parse(lastClosedCycle.closed_at) : NaN;
    const pastTickWindow = Number.isFinite(lastClosedMs) && (nowMs - lastClosedMs >= tickMs);
    const noWork = openCount === 0 && active === 0;
    const tickQuiet = !hasRecentTickActivity(recentEvents, tickMs, nowMs);
    const workerUnavailable = !worker.running;
    const onDemand = evolutionMode === 'on_demand';
    const pendingRequest = pendingCycleStartRequest;
    const requestUpdatedMs = pendingRequest?.updated_at ? Date.parse(pendingRequest.updated_at) : NaN;
    const requestBlockedLong = onDemand && pendingRequest
      && Number.isFinite(requestUpdatedMs)
      && (nowMs - requestUpdatedMs >= tickMs * 2)
      && (pendingRequest.deferred_count ?? 0) > 0;
    const evolutionStalled = tickOpenEnabled && !onDemand && noWork && pastTickWindow
      && (workerUnavailable || (worker.running && tickQuiet));

    if (isReactorPipeline(pipeline) && reactorHealth) {
      if (reactorHealth.ok === false) {
        status = reactorHealth.status === 'blocked' ? 'blocked' : 'reactor_backlog_stalled';
        ok = false;
        reasons.push(...(reactorHealth.reasons ?? []));
        suggestions.push(...(reactorHealth.suggestions ?? []));
      } else {
        status = reactorHealth.status === 'idle' ? 'idle' : 'healthy';
        ok = true;
        reasons.push(...(reactorHealth.reasons?.length
          ? reactorHealth.reasons
          : ['Reactor projection is the production health source']));
        suggestions.push(...(reactorHealth.suggestions ?? []));
      }
    } else if (requestBlockedLong) {
      status = 'cycle_start_blocked';
      ok = false;
      reasons.push('Pending cycle start request could not be consumed within 2 tick windows');
      suggestions.push('Check open cycles, pending tasks, or worker logs; use `jea daemon status --json` for details.');
    } else if (progressStalled || (openCount > 0 && driftSteps.length > 0 && worker.running)) {
      status = 'cycle_progress_stalled';
      ok = false;
      reasons.push('Open cycle exists but no step progress within the expected tick window');
      if (driftSteps.length) {
        reasons.push(`${driftSteps.length} step state drift item(s) detected (terminal cycle-state with running task)`);
      }
      suggestions.push('Wait for watchdog recovery, inspect with `jea daemon doctor`, or restart the worker if stuck persists.');
    } else if (evolutionStalled) {
      status = 'evolution_stalled';
      ok = false;
      reasons.push('No open cycle or queued work, and no new cycle started within the heartbeat tick window');
      suggestions.push('Run `jea daemon start` (or check worker logs for queue_write_failed / crashes).');
    } else if (worker.running && active === 0) {
      status = 'idle';
      ok = true;
      if (onDemand && pendingRequest) {
        reasons.push('On-demand mode: cycle start request is pending');
        suggestions.push('Ensure the daemon worker is running; the request will be consumed when preconditions pass.');
      } else if (onDemand) {
        reasons.push('On-demand mode: no cycle start request queued');
        suggestions.push('Use `jea daemon cycle request` or `jea intel brief put` to queue a cycle.');
      } else if (!tickOpenEnabled) {
        reasons.push('Reactor idle: tick does not auto-open cycles');
        suggestions.push('Use `jea daemon cycle request` or `jea intel brief put` to queue a cycle.');
      } else if (Number.isFinite(lastClosedMs) && nowMs - lastClosedMs < tickMs) {
        reasons.push('Worker is running; last cycle closed recently — next cycle may start on tick');
      } else {
        reasons.push('Worker is fresh and no daemon task is waiting');
      }
      if (!onDemand && tickOpenEnabled) {
        suggestions.push('Wait for the next heartbeat tick, or use `jea daemon cycle request` to queue a cycle.');
      }
    } else if (!worker.running && active === 0) {
      status = 'idle';
      ok = true;
      reasons.push('No daemon worker is running and no task is queued');
      suggestions.push('Run `jea daemon start` when background evolution should run.');
    } else {
      status = 'healthy';
      ok = true;
      reasons.push('Daemon worker and task queue are progressing normally');
    }
  }

  if (failed > 0) {
    suggestions.push('Historical failed task(s) are retained for audit. Use `jea daemon tasks acknowledge <task_id>` after inspection.');
  }

  return {
    status,
    ok,
    reasons,
    suggestions,
  };
}

export function buildDaemonProjectionUncached(root, subject, { store = null, eventLimit = 20, heartbeatStaleMs = 60_000, flags = {} } = {}) {
  const queue = readTaskQueue(root, subject);
  const summary = summarizeTaskQueue(queue);
  const queueTasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const rawWorker = readWorkerState(root, subject);
  const worker = summarizeWorkerState(rawWorker, { staleMs: heartbeatStaleMs });
  const tickMs = worker.tick_ms ?? rawWorker?.tick_ms ?? DEFAULT_TICK_MS;
  const events = store?.readEvolutionEvents
    ? store.readEvolutionEvents({ limit: Math.max(eventLimit, 50) }).filter((event) => !event.subject || event.subject === subject)
    : [];
  const lastClosedCycle = getLastClosedCycle(root, subject);
  const tasks = {
    total: summary.total,
    counts: summary.counts,
    expired_running_count: summary.expired_running.length,
    step_tasks: queueTasks.filter((t) => t.input?.cycle_id).slice(0, 20).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      cycle_id: task.input.cycle_id,
      status: task.status,
      attempts: task.attempts,
    })),
    next_task: summary.next_task ? {
      task_id: summary.next_task.task_id,
      type: summary.next_task.type,
      attempts: summary.next_task.attempts,
      priority: summary.next_task.priority,
      idempotency_key: summary.next_task.idempotency_key,
    } : null,
    running: summary.running.map((task) => ({
      task_id: task.task_id,
      type: task.type,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
      expired: summary.expired_running.some((expired) => expired.task_id === task.task_id),
    })),
    expired_running: summary.expired_running.map((task) => ({
      task_id: task.task_id,
      type: task.type,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
    })),
    failed: summary.failed.slice(0, 10).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      attempts: task.attempts,
      last_error_code: task.last_error_code,
      last_error: task.last_error,
    })),
    acknowledged: summary.acknowledged.slice(0, 10).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      attempts: task.attempts,
      last_error_code: task.last_error_code,
      acknowledged_at: task.acknowledged_at,
      acknowledged_reason: task.acknowledged_reason,
    })),
  };
  const openCycles = listOpenCycles(root, subject);
  const cycleProjection = buildCycleProjection(root, subject);
  const stuckSteps = [];
  const driftSteps = [];
  let progressStalled = false;
  let oldestOpenCycleAgeMs = null;
  for (const cycle of openCycles) {
    for (const item of findStuckSteps(cycle, { taskQueue: queue, subject })) {
      stuckSteps.push({ cycle_id: cycle.cycle_id, ...item });
    }
    for (const item of findStepStateDrift(cycle, { taskQueue: queue, subject, root })) {
      driftSteps.push({ cycle_id: cycle.cycle_id, ...item });
    }
    if (isCycleProgressStalled(cycle, { taskQueue: queue, subject, root, tickMs })) {
      progressStalled = true;
    }
    if (cycle.opened_at) {
      const opened = Date.parse(cycle.opened_at);
      if (Number.isFinite(opened)) {
        const ageMs = Date.now() - opened;
        if (oldestOpenCycleAgeMs == null || ageMs > oldestOpenCycleAgeMs) {
          oldestOpenCycleAgeMs = ageMs;
        }
      }
    }
  }

  const evolution = resolveEvolutionMode(root, { subject, flags });
  const pipeline = resolveCyclePipeline(root, { subject, flags }).pipeline;
  const reactorPrimary = isReactorPipeline(pipeline);
  const cycles = {
    ...cycleProjection,
    stuck_steps: reactorPrimary ? [] : stuckSteps,
    drift_steps: reactorPrimary ? [] : driftSteps,
    progress_stalled: reactorPrimary ? false : progressStalled,
    oldest_open_cycle_age_ms: oldestOpenCycleAgeMs,
    recent: openCycles.slice(0, 5).map((cycle) => summarizeCycleState(cycle, { taskQueue: queue, subject, root })),
    last_closed_cycle_id: lastClosedCycle?.cycle_id ?? null,
    last_closed_at: lastClosedCycle?.closed_at ?? null,
  };
  const pendingCycleStartRequest = cycleProjection.pending_cycle_start_request
    ?? readPendingCycleStartRequest(root, subject);
  const reactor = buildReactorHealthProjection(root, subject, { worker });
  const wakePolicy = isReactorPipeline(pipeline) ? 'evidence_driven' : evolution.mode;

  return {
    subject,
    generated_at: new Date().toISOString(),
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
    evolution_mode_deprecated: isReactorPipeline(pipeline),
    wake_policy: wakePolicy,
    pipeline,
    reactor,
    worker,
    health: buildDaemonHealth({
      worker,
      tasks,
      cycles: cycleProjection,
      lastClosedCycle,
      recentEvents: events,
      tickMs,
      evolutionMode: evolution.mode,
      pendingCycleStartRequest,
      progressStalled,
      driftSteps,
      tickOpenEnabled: isTickOpenCycleEnabled(),
      reactorHealth: reactor,
      pipeline,
    }),
    tasks,
    cycles,
    channel: buildChannelProjection(root, subject, { heartbeatStaleMs, eventLimit }),
    recent_events: events.slice(0, eventLimit).map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      task_id: event.task_id,
      recorded_at: event.recorded_at,
      error_code: event.error_code,
    })),
  };
}

export function writeDaemonProjection(root, subject, projection) {
  mkdirSync(daemonViewsDir(root, subject), { recursive: true });
  writeJson(currentStatePath(root, subject), projection);
  return projection;
}

function hashSignature(parts) {
  return createHash('sha1').update(parts.filter(Boolean).join('\n')).digest('hex');
}

export function daemonProjectionHeavySignature(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return hashSignature([
    evidenceSourceSignature(runtime.dataRoot),
    fileIdentitySignature(claimsPath(runtime.dataRoot)),
    fileIdentitySignature(join(runtime.evolutionDir, 'pending_decisions.json')),
    fileIdentitySignature(join(runtime.dataRoot, 'evolution', 'reactor', 'exec-intents.json')),
    dirIdentitySignature(join(runtime.dataRoot, 'evolution', 'reactor', 'exec-results'), { suffix: '.json' }),
    dirIdentitySignature(join(runtime.evolutionDir, 'cycle-state'), { suffix: '.json' }),
    dirIdentitySignature(join(runtime.evolutionDir, 'operator_briefs', 'pending'), { suffix: '.json' }),
    dirIdentitySignature(join(runtime.evolutionDir, 'operator_facts', 'pending'), { suffix: '.json' }),
    dirIdentitySignature(join(runtime.evolutionDir, 'operator_questions', 'pending'), { suffix: '.json' }),
  ]);
}

export function daemonProjectionCoreLightSignature(root, subject) {
  return hashSignature([
    fileIdentitySignature(workerStatePath(root, subject)),
    fileIdentitySignature(pendingTasksPath(root, subject)),
  ]);
}

export function daemonProjectionChannelLightSignature(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return hashSignature([
    fileIdentitySignature(channelWorkerStatePath(root, subject)),
    fileIdentitySignature(join(channelTasksDir(root, subject), 'pending_tasks.json')),
    fileIdentitySignature(channelEventsPath(root, subject)),
    dirIdentitySignature(join(runtime.dataRoot, 'channel', 'inbound'), { recursive: true, suffix: '.json' }),
    dirIdentitySignature(join(runtime.dataRoot, 'channel', 'outbox'), { recursive: true, suffix: '.json' }),
    dirIdentitySignature(join(runtime.dataRoot, 'channel', 'desktop', 'sessions'), { suffix: '.json' }),
  ]);
}

export function daemonProjectionLightSignature(root, subject) {
  return hashSignature([
    daemonProjectionCoreLightSignature(root, subject),
    daemonProjectionChannelLightSignature(root, subject),
  ]);
}

export function daemonProjectionInputSignature(root, subject) {
  return hashSignature([
    daemonProjectionHeavySignature(root, subject),
    daemonProjectionLightSignature(root, subject),
  ]);
}

function projectionCacheKey(root, subject, eventLimit, heartbeatStaleMs) {
  const runtime = runtimeForSubject(root, subject);
  return [
    runtime.jeaHome,
    runtime.dataNamespace,
    subject,
    `eventLimit=${eventLimit}`,
    `heartbeatStaleMs=${heartbeatStaleMs}`,
  ].join('::');
}

const projectionCache = new Map();
const pendingRebuilds = new Map();
const liveWorkers = new Set();
const rebuildListeners = new Set();
let cacheGeneration = 0;

function evictProjectionCache() {
  while (projectionCache.size > DAEMON_PROJECTION_CACHE_LIMIT) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of projectionCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = key;
      }
    }
    if (oldestKey == null) break;
    projectionCache.delete(oldestKey);
  }
}

export function resetDaemonProjectionCache() {
  cacheGeneration += 1;
  projectionCache.clear();
  pendingRebuilds.clear();
  for (const worker of liveWorkers) {
    try {
      worker.terminate();
    } catch {
      // Reset must stay idempotent when a worker is already exiting.
    }
  }
  liveWorkers.clear();
}

function attachProjectionMeta(projection, fingerprint, revision) {
  return {
    ...projection,
    fingerprint,
    revision,
  };
}

function projectionIdentity(root, subject, eventLimit, heartbeatStaleMs) {
  const heavy = daemonProjectionHeavySignature(root, subject);
  const coreLight = daemonProjectionCoreLightSignature(root, subject);
  const channelLight = daemonProjectionChannelLightSignature(root, subject);
  const light = hashSignature([coreLight, channelLight]);
  const settings = hashSignature([
    `eventLimit=${eventLimit}`,
    `heartbeatStaleMs=${heartbeatStaleMs}`,
  ]);
  return {
    heavy,
    coreLight,
    channelLight,
    light,
    settings,
    fingerprint: hashSignature([
      heavy,
      light,
      settings,
    ]),
  };
}

function serializeProjectionRoot(root) {
  const context = createRuntimeContext(root);
  return {
    sourceRoot: context.sourceRoot,
    jeaHome: context.jeaHome,
  };
}

export function resolveDaemonProjectionWorkerPath() {
  try {
    const candidate = join(dirname(fileURLToPath(import.meta.url)), 'daemon-projection-worker.mjs');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function workerPathFromOptions(options) {
  if (options.workerPath === null || options.workerPath === false) return null;
  if (typeof options.workerPath === 'string') {
    return existsSync(options.workerPath) ? options.workerPath : null;
  }
  return resolveDaemonProjectionWorkerPath();
}

export function onDaemonProjectionRebuild(listener) {
  if (typeof listener !== 'function') return () => {};
  rebuildListeners.add(listener);
  return () => rebuildListeners.delete(listener);
}

function emitDaemonProjectionRebuild(subject) {
  for (const listener of rebuildListeners) {
    try {
      listener({ subject });
    } catch {
      // A UI listener must not poison the shared projection cache.
    }
  }
}

function runProjectionWorker({
  workerPath,
  root,
  subject,
  eventLimit,
  heartbeatStaleMs,
  flags,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerPath, {
      workerData: {
        root: serializeProjectionRoot(root),
        subject,
        eventLimit,
        heartbeatStaleMs,
        flags: flags && typeof flags === 'object' ? { ...flags } : {},
      },
    });
    liveWorkers.add(worker);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveWorkers.delete(worker);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        // Timeout terminate is best-effort.
      }
      finish(new Error('daemon projection worker timed out'));
    }, DAEMON_PROJECTION_WORKER_TIMEOUT_MS);
    worker.once('message', (message) => {
      if (message?.ok) finish(null, message.projection);
      else finish(new Error(message?.error || 'daemon projection worker failed'));
    });
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish(new Error(`daemon projection worker exited ${code}`));
      }
    });
  });
}

function storeBuiltProjection(
  root,
  subject,
  {
    eventLimit,
    heartbeatStaleMs,
    flags,
    fullBuilder = buildDaemonProjectionUncached,
  },
  cached,
) {
  const built = fullBuilder(root, subject, {
    eventLimit,
    heartbeatStaleMs,
    flags,
  });
  return rememberBuiltProjection(root, subject, { eventLimit, heartbeatStaleMs }, built, cached);
}

function rememberBuiltProjection(root, subject, { eventLimit, heartbeatStaleMs }, built, cached) {
  const identity = projectionIdentity(root, subject, eventLimit, heartbeatStaleMs);
  const revision = cached ? cached.revision + 1 : 1;
  const projection = attachProjectionMeta(built, identity.fingerprint, revision);
  const key = projectionCacheKey(root, subject, eventLimit, heartbeatStaleMs);
  if (!cached) evictProjectionCache();
  projectionCache.set(key, {
    fingerprint: identity.fingerprint,
    heavy: identity.heavy,
    coreLight: identity.coreLight,
    channelLight: identity.channelLight,
    light: identity.light,
    settings: identity.settings,
    projection,
    revision,
    at: Date.now(),
  });
  evictProjectionCache();
  return { projection, identity };
}

function refreshCachedChannelProjection(
  root,
  subject,
  { eventLimit, heartbeatStaleMs },
  cached,
) {
  const channel = buildChannelProjection(root, subject, { heartbeatStaleMs, eventLimit });
  const identity = projectionIdentity(root, subject, eventLimit, heartbeatStaleMs);

  // A concurrent cycle/evidence update invalidates the sections we intended to
  // reuse. Let the caller choose the normal full/deferred path in that case.
  if (
    cached.heavy !== identity.heavy
    || cached.coreLight !== identity.coreLight
    || cached.settings !== identity.settings
  ) {
    return { projection: null, identity };
  }
  if (cached.fingerprint === identity.fingerprint) {
    cached.at = Date.now();
    return { projection: cached.projection, identity };
  }

  const revision = cached.revision + 1;
  const projection = attachProjectionMeta({
    ...cached.projection,
    generated_at: new Date().toISOString(),
    channel,
  }, identity.fingerprint, revision);
  const key = projectionCacheKey(root, subject, eventLimit, heartbeatStaleMs);
  projectionCache.set(key, {
    fingerprint: identity.fingerprint,
    heavy: identity.heavy,
    coreLight: identity.coreLight,
    channelLight: identity.channelLight,
    light: identity.light,
    settings: identity.settings,
    projection,
    revision,
    at: Date.now(),
  });
  evictProjectionCache();
  return { projection, identity };
}

function scheduleDeferredRebuild({
  root,
  subject,
  eventLimit,
  heartbeatStaleMs,
  flags,
  key,
  generation,
  workerPath,
}) {
  const existing = pendingRebuilds.get(key);
  if (existing) {
    existing.dirty = true;
    return existing.promise;
  }
  const job = { dirty: false, promise: null };
  job.promise = (async () => {
    try {
      const built = await runProjectionWorker({
        workerPath,
        root,
        subject,
        eventLimit,
        heartbeatStaleMs,
        flags,
      });
      if (generation !== cacheGeneration) return;
      const cached = projectionCache.get(key);
      const stored = rememberBuiltProjection(
        root,
        subject,
        { eventLimit, heartbeatStaleMs },
        built,
        cached,
      );
      const current = projectionIdentity(root, subject, eventLimit, heartbeatStaleMs);
      if (current.fingerprint !== stored.identity.fingerprint) job.dirty = true;
      emitDaemonProjectionRebuild(subject);
    } catch {
      // Keep the last successful snapshot. The next watch burst retries.
    } finally {
      pendingRebuilds.delete(key);
      if (job.dirty && generation === cacheGeneration) {
        const latest = projectionCache.get(key);
        const current = projectionIdentity(root, subject, eventLimit, heartbeatStaleMs);
        if (!latest || latest.fingerprint !== current.fingerprint) {
          scheduleDeferredRebuild({
            root,
            subject,
            eventLimit,
            heartbeatStaleMs,
            flags,
            key,
            generation: cacheGeneration,
            workerPath,
          });
        }
      }
    }
  })();
  pendingRebuilds.set(key, job);
  return job.promise;
}

export function pendingDaemonProjectionRebuildCount() {
  return pendingRebuilds.size;
}

export async function waitForPendingDaemonProjectionRebuilds() {
  const seen = new Set();
  while (pendingRebuilds.size > 0) {
    const jobs = [...pendingRebuilds.values()].filter((job) => !seen.has(job));
    if (jobs.length === 0) break;
    for (const job of jobs) seen.add(job);
    await Promise.all(jobs.map((job) => job.promise.catch(() => {})));
  }
}

/**
 * Subject-scoped projection reader. Same input revision is built once and
 * reused by Main, Client API, and readiness.
 *
 * `deferRebuild: true` (Desktop/Web hot path): when Evidence/Reactor inputs
 * changed and a last successful snapshot exists, return that snapshot and
 * rebuild on a worker thread. Heartbeat / Channel light fields still rebuild
 * synchronously. CLI, Vitest, and `store` reads stay synchronous.
 */
export function readDaemonProjection(root, subject, options = {}) {
  const eventLimit = options.eventLimit ?? 20;
  const heartbeatStaleMs = options.heartbeatStaleMs ?? 60_000;
  const flags = options.flags ?? {};
  const key = projectionCacheKey(root, subject, eventLimit, heartbeatStaleMs);
  let identity = projectionIdentity(root, subject, eventLimit, heartbeatStaleMs);
  const cached = projectionCache.get(key);
  if (cached && cached.fingerprint === identity.fingerprint) {
    cached.at = Date.now();
    return cached.projection;
  }
  const canRefreshChannelOnly = Boolean(cached?.projection)
    && cached.heavy === identity.heavy
    && cached.coreLight === identity.coreLight
    && cached.channelLight !== identity.channelLight
    && cached.settings === identity.settings;
  if (canRefreshChannelOnly) {
    const refreshed = refreshCachedChannelProjection(
      root,
      subject,
      { eventLimit, heartbeatStaleMs },
      cached,
    );
    if (refreshed.projection) return refreshed.projection;
    identity = refreshed.identity;
  }
  const workerPath = workerPathFromOptions(options);
  const canDeferHeavy = options.deferRebuild === true
    && Boolean(cached?.projection)
    && cached.heavy !== identity.heavy
    && Boolean(workerPath);
  if (canDeferHeavy) {
    scheduleDeferredRebuild({
      root,
      subject,
      eventLimit,
      heartbeatStaleMs,
      flags,
      key,
      generation: cacheGeneration,
      workerPath,
    });
    return cached.projection;
  }
  return storeBuiltProjection(root, subject, {
    eventLimit,
    heartbeatStaleMs,
    flags,
    fullBuilder: options.fullBuilder,
  }, cached).projection;
}

export function buildDaemonProjection(root, subject, options = {}) {
  if (options.cache === false || options.store) {
    const built = buildDaemonProjectionUncached(root, subject, options);
    return attachProjectionMeta(built, daemonProjectionInputSignature(root, subject), 0);
  }
  return readDaemonProjection(root, subject, options);
}
