import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from './files.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';
import { readTaskQueue, summarizeTaskQueue } from './daemon-tasks.mjs';
import { readWorkerState, summarizeWorkerState } from './daemon-worker-state.mjs';
import { buildCycleProjection } from './cycle-dispatch.mjs';
import { findStuckSteps, findStepStateDrift, getLastClosedCycle, isCycleProgressStalled, listOpenCycles, summarizeCycleState } from './cycle-state.mjs';
import { readPendingCycleStartRequest } from './cycle-start-requests.mjs';
import { resolveEvolutionMode } from './evolution-mode.mjs';

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
    const evolutionStalled = !onDemand && noWork && pastTickWindow
      && (workerUnavailable || (worker.running && tickQuiet));

    if (requestBlockedLong) {
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
      } else if (Number.isFinite(lastClosedMs) && nowMs - lastClosedMs < tickMs) {
        reasons.push('Worker is running; last cycle closed recently — next cycle may start on tick');
      } else {
        reasons.push('Worker is fresh and no daemon task is waiting');
      }
      if (!onDemand) {
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

export function buildDaemonProjection(root, subject, { store = null, eventLimit = 20, heartbeatStaleMs = 60_000, flags = {} } = {}) {
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

  const cycles = {
    ...cycleProjection,
    stuck_steps: stuckSteps,
    drift_steps: driftSteps,
    progress_stalled: progressStalled,
    oldest_open_cycle_age_ms: oldestOpenCycleAgeMs,
    recent: openCycles.slice(0, 5).map((cycle) => summarizeCycleState(cycle, { taskQueue: queue, subject, root })),
    last_closed_cycle_id: lastClosedCycle?.cycle_id ?? null,
    last_closed_at: lastClosedCycle?.closed_at ?? null,
  };

  const evolution = resolveEvolutionMode(root, { subject, flags });
  const pendingCycleStartRequest = cycleProjection.pending_cycle_start_request
    ?? readPendingCycleStartRequest(root, subject);

  return {
    subject,
    generated_at: new Date().toISOString(),
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
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
    }),
    tasks,
    cycles,
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
  writeJsonFile(currentStatePath(root, subject), projection);
  return projection;
}
