import { getProjectRoot, loadProjectEnv } from '../infra/project.mjs';
import {
  acquireSubjectLock,
  describeSubjectLockHealth,
  isSubjectLocked,
  parsePositiveInt,
  withSubjectLock,
} from './evolve-runs.mjs';
import { hasMultiSubjectSelection, selectSubjects } from '../infra/subject-selection.mjs';
import { buildSubjectArtifactOverview } from '../daemon/subject-artifacts.mjs';
import { buildLinkHealthSummary } from '../infra/links/index.mjs';
import {
  acknowledgeTask,
  cancelTask,
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  isQueueWriteError,
  parseLeaseMs,
  reclaimExpiredLeases,
  readTaskQueue,
  renewTaskLease,
  releaseTaskForRetry,
  retryTask,
} from './daemon-tasks.mjs';
import { buildDaemonProjection, writeDaemonProjection } from './daemon-projection.mjs';
import { recordDaemonEvent, storeForSubject } from './daemon-events.mjs';
import {
  createWorkerState,
  defaultWorkerId,
  markWorkerStopped,
  parseHeartbeatMs,
  parseHeartbeatStaleMs,
  readWorkerState,
  requestWorkerStop,
  updateWorkerHeartbeat,
} from './daemon-worker-state.mjs';
import {
  checkSubjectLaneReady,
  printSubjectLaneGuardFailure,
} from '../infra/subject-lane-guard.mjs';
import { ALL_CYCLE_STEP_TYPES } from './cycle-reducer.mjs';
import {
  enqueueReactionRequest,
  processCycleOnce,
  processOnceCommandExitCode,
  processCycleStartRequests,
  runHeartbeatTick,
} from './cycle-dispatch.mjs';
import { resolveEvolutionMode } from './evolution-mode.mjs';
import { applyEvolutionModeChange } from './evolution-mode-apply.mjs';
import { isEvolutionPaused, resolveEvolutionState } from '../product/evolution-state.mjs';
import { applyEvolutionStateChange } from './evolution-state-apply.mjs';
import { runChannelTick } from '../channel/dispatch.mjs';
import {
  resolveChannelDomainRoles,
  runChannelDomainWorkerMulti,
  runChannelListenerSupervisor,
} from '../channel/domain-worker.mjs';
import { recordChannelEvent } from '../channel/audit.mjs';
import { isChannelTaskType } from '../channel/types.mjs';
import { runChannelTask } from '../channel/tasks.mjs';
import {
  claimNextChannelTask,
  completeChannelTask,
  failChannelTask,
  reclaimExpiredChannelLeases,
  releaseChannelTaskForAbort,
  releaseChannelTaskForRetry,
  renewChannelTaskLease,
} from '../channel/task-queue.mjs';
import {
  createChannelWorkerState,
  defaultWorkerId as defaultChannelWorkerId,
  markChannelWorkerStopped,
  parseHeartbeatMs as parseChannelHeartbeatMs,
  parseHeartbeatStaleMs as parseChannelHeartbeatStaleMs,
  readChannelWorkerState,
  reconcileChannelWorkerState,
  requestChannelWorkerStop,
  safeUpdateChannelSupervisorState,
  safeUpdateChannelWorkerHeartbeat,
  updateChannelWorkerHeartbeat,
} from '../channel/worker-state.mjs';
import { runDomainWorkerLoop } from '../infra/worker-loop.mjs';
import {
  isPausedBlockedReactorType,
  isReactorTaskType,
  PAUSED_ALLOWED_REACTOR_TYPES,
  runReactorDaemonTask,
  scanWakeBacklog,
} from '../evolution/reactor/reactor-tasks.mjs';
import { enqueueWakeIntent } from '../evolution/reactor/wake-store.mjs';
import { classifyReactorError } from '../evolution/reactor/rule-resilience.mjs';
import {
  createSupervisorLeaseGuard,
  supervisorLeaseConfigFromEnv,
  supervisorStateMirror,
} from '../product/supervisor-lease.mjs';

function sleep(ms, signal = null) {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function heartbeatDefaults(flags = {}) {
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const heartbeatMs = parseHeartbeatMs(flags['heartbeat-ms']);
  const heartbeatStaleMs = parseHeartbeatStaleMs(
    flags['heartbeat-stale-ms'],
    Math.max(leaseMs * 2, heartbeatMs * 3, 60_000),
  );
  return { leaseMs, heartbeatMs, heartbeatStaleMs };
}

function supervisorLeaseRuntime(flags = {}) {
  const config = flags.supervisorLeaseConfig ?? supervisorLeaseConfigFromEnv();
  const guard = createSupervisorLeaseGuard(config, flags.supervisorLeaseGuardOptions);
  const observation = guard.check();
  return {
    config,
    guard,
    observation,
    checkIntervalMs: config ? Math.max(250, Math.min(config.renewMs, 1000)) : null,
  };
}

export function enqueueDaemonTask(root, subject, {
  type = 'cognitive_reaction',
  idempotencyKey = null,
  input = {},
  priority = 100,
} = {}) {
  const result = enqueueTask(root, subject, {
    type,
    priority,
    idempotencyKey,
    input,
  });
  if (result.created) {
    recordDaemonEvent(root, subject, {
      type: 'task_enqueued',
      status: 'ok',
      task_id: result.task.task_id,
      task_type: result.task.type,
      idempotency_key: result.task.idempotency_key,
    });
  }
  return result;
}

function printTask(task, { created = null } = {}) {
  console.log(`${created === false ? 'existing' : 'task'}: ${task.task_id}`);
  console.log(`type: ${task.type}`);
  console.log(`subject: ${task.subject}`);
  console.log(`status: ${task.status}`);
  console.log(`idempotency_key: ${task.idempotency_key}`);
}

function parseLimit(value, defaultValue = 20) {
  return parsePositiveInt(value, { name: 'limit', defaultValue, min: 1 });
}

function readDaemonEvents(root, subject, { limit = 20 } = {}) {
  const store = storeForSubject(root, subject);
  return store.readEvolutionEvents({ limit })
    .filter((event) => !event.subject || event.subject === subject);
}

function buildProjection(root, subject, flags = {}) {
  const store = storeForSubject(root, subject);
  const projection = buildDaemonProjection(root, subject, {
    store,
    heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    flags,
  });
  writeDaemonProjection(root, subject, projection);
  return projection;
}

function projectionSummary(root, subject, projection) {
  return {
    subject,
    health: projection.health,
    worker: projection.worker,
    tasks: projection.tasks,
    locked: isSubjectLocked(root, subject),
    latest_event: projection.recent_events?.[0] ?? null,
    reactor_progress: projection.reactor_progress ?? null,
  };
}

function printEvents(events) {
  if (!events.length) {
    console.log('No daemon events found.');
    return;
  }
  for (const event of events) {
    const parts = [
      event.recorded_at || 'unknown-time',
      event.type || 'unknown_event',
      event.status ? `status=${event.status}` : null,
      event.task_id ? `task=${event.task_id}` : null,
      event.error_code ? `error=${event.error_code}` : null,
    ].filter(Boolean);
    console.log(parts.join(' '));
  }
}

function printMultiEvents(items) {
  const any = items.some((item) => item.events.length);
  if (!any) {
    console.log('No daemon events found.');
    return;
  }
  for (const item of items) {
    console.log(`# ${item.subject}`);
    printEvents(item.events);
  }
}

function buildDaemonDiagnostics(root, subject, projection) {
  const diagnostics = [];
  const locked = isSubjectLocked(root, subject);
  if (projection.health?.status === 'worker_zombie' || projection.worker.zombie) {
    diagnostics.push({
      severity: 'error',
      code: 'worker_zombie',
      message: 'Daemon worker is marked running but its process (PID) is not alive.',
      action: 'Run `jea daemon start` to start a fresh worker.',
    });
  }
  if (projection.health?.status === 'cycle_progress_stalled' && projection.pipeline !== 'reactor') {
    diagnostics.push({
      severity: 'error',
      code: 'cycle_progress_stalled',
      message: 'An open cycle exists but no step progress occurred within the expected tick window.',
      action: 'Wait for watchdog recovery, inspect drift with `jea daemon status --json`, or restart the worker if stuck persists.',
    });
  }
  if (projection.health?.status === 'reactor_backlog_stalled' || projection.reactor?.ok === false) {
    diagnostics.push({
      severity: 'error',
      code: projection.reactor?.status === 'blocked' ? 'reactor_blocked' : 'reactor_backlog_stalled',
      message: (projection.reactor?.reasons ?? projection.health?.reasons ?? []).join(' ')
        || 'Reactor evidence/claim backlog is stalled.',
      action: (projection.reactor?.suggestions ?? projection.health?.suggestions ?? [])[0]
        || 'Inspect `jea daemon status --json` reactor projection and run `jea daemon work --once`.',
      reactor: projection.reactor ?? null,
    });
  }
  const driftSteps = projection.pipeline === 'reactor' ? [] : (projection.cycles?.drift_steps ?? []);
  if (driftSteps.length > 0) {
    const summary = driftSteps
      .slice(0, 5)
      .map((item) => `${item.cycle_id}:${item.step}`)
      .join(', ');
    diagnostics.push({
      severity: driftSteps.some((item) => item.artifact_complete) ? 'warning' : 'error',
      code: 'step_state_drift',
      message: `${driftSteps.length} cycle step(s) have terminal state but a running daemon task (${summary}).`,
      action: 'Watchdog should abort hung step runners when checkpoints exist. Artifact-complete reconcile is off for reactor.',
      drift_steps: driftSteps,
    });
  }
  if (projection.health?.status === 'evolution_stalled') {
    diagnostics.push({
      severity: 'error',
      code: 'evolution_stalled',
      message: 'Evolution should have started a new cycle on tick but none is open or queued.',
      action: 'Run `jea daemon start` and inspect daemon events for queue_write_failed or worker_crashed.',
    });
  }
  if (projection.worker.stale) {
    diagnostics.push({
      severity: 'warning',
      code: 'worker_stale',
      message: 'Daemon worker heartbeat is stale.',
      action: 'Start a fresh worker or use daemon stop to mark stale state stopped.',
    });
  }
  if (projection.worker.stop_requested_at && projection.worker.running) {
    diagnostics.push({
      severity: 'info',
      code: 'worker_stopping',
      message: 'Daemon worker has a pending stop request.',
      action: 'Wait for the current task to finish or check daemon events for stop propagation.',
    });
  }
  if (projection.tasks.expired_running_count > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'expired_running_leases',
      message: `${projection.tasks.expired_running_count} running task lease(s) have expired.`,
      action: 'Run daemon work --once or restart the worker to reclaim expired leases.',
    });
  }
  if ((projection.tasks.counts.pending || 0) > 0 && !projection.worker.running) {
    diagnostics.push({
      severity: 'warning',
      code: 'pending_without_worker',
      message: `${projection.tasks.counts.pending} pending task(s) have no fresh worker.`,
      action: 'Run daemon start in a foreground terminal or daemon work --once.',
    });
  }
  if ((projection.tasks.counts.failed || 0) > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'failed_tasks',
      message: `${projection.tasks.counts.failed} historical daemon task(s) have failed.`,
      action: 'Inspect and acknowledge failed tasks after the underlying error is understood.',
    });
  }
  if (locked) {
    const lockHealth = describeSubjectLockHealth(root, subject);
    if (lockHealth.code === 'lock_held_by_foreground') {
      diagnostics.push({
        severity: 'info',
        code: lockHealth.code,
        message: lockHealth.message,
        action: 'Wait for the foreground run or evolve process to finish before starting daemon for this subject.',
      });
    } else if (lockHealth.code === 'lock_held_by_daemon' && !projection.worker.running) {
      diagnostics.push({
        severity: 'warning',
        code: 'lock_without_fresh_worker',
        message: 'Evolve lock is held but daemon worker projection is not running.',
        action: 'Check worker heartbeat or wait for lock stale expiry.',
      });
    } else {
      diagnostics.push({
        severity: 'info',
        code: 'subject_evolve_lock_present',
        message: lockHealth.message,
        action: 'This is expected while daemon or foreground evolve is running; avoid concurrent evolve for the same subject.',
      });
    }
  }
  const stuckSteps = projection.pipeline === 'reactor' ? [] : (projection.cycles?.stuck_steps ?? []);
  if (stuckSteps.length > 0) {
    const summary = stuckSteps
      .slice(0, 5)
      .map((item) => `${item.cycle_id}:${item.step}`)
      .join(', ');
    diagnostics.push({
      severity: stuckSteps.some((item) => item.reason === 'lease_expired' || (item.age_ms ?? 0) >= 120_000)
        ? 'error'
        : 'warning',
      code: 'stuck_cycle_step',
      message: `${stuckSteps.length} cycle step(s) appear stuck in running state (${summary}).`,
      action: 'Inspect cycle-state, reclaim expired task leases with `jea daemon work --once`, or retry/cancel the stuck task.',
      stuck_steps: stuckSteps,
    });
  }
  if (!diagnostics.length) {
    diagnostics.push({
      severity: 'ok',
      code: 'daemon_ok',
      message: 'No daemon operational issues detected.',
      action: 'No action required.',
    });
  }
  return {
    subject,
    health: projection.health,
    locked,
    diagnostics,
  };
}

function printDiagnostics(report) {
  console.log(`# Daemon Doctor: ${report.subject}`);
  console.log(`health: ${report.health.status}`);
  console.log(`evolve_lock: ${report.locked ? 'held' : 'free'}`);
  for (const item of report.diagnostics) {
    console.log(`${item.severity}: ${item.code} - ${item.message}`);
    console.log(`  action: ${item.action}`);
  }
}

function printMultiDiagnostics(reports) {
  for (const report of reports) {
    printDiagnostics(report);
  }
}

function taskSummary(task) {
  return {
    task_id: task.task_id,
    type: task.type,
    subject: task.subject,
    status: task.status,
    run_id: task.input?.run_id ?? null,
    round_index: task.input?.round_index ?? null,
    attempts: task.attempts,
    priority: task.priority,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    idempotency_key: task.idempotency_key,
    created_at: task.created_at,
    updated_at: task.updated_at,
    last_error_code: task.last_error_code,
    last_error: task.last_error,
    acknowledged_at: task.acknowledged_at,
    acknowledged_reason: task.acknowledged_reason,
  };
}

function sortedTasks(tasks) {
  return [...tasks].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
}

function printTaskList(tasks) {
  if (!tasks.length) {
    console.log('No daemon tasks found.');
    return;
  }
  for (const task of tasks) {
    const error = task.last_error_code ? ` error=${task.last_error_code}` : '';
    console.log(`${task.task_id} ${task.status} ${task.type} attempts=${task.attempts ?? 0}${error}`);
  }
}

function printMultiTaskList(items) {
  const any = items.some((item) => item.tasks.length);
  if (!any) {
    console.log('No daemon tasks found.');
    return;
  }
  for (const item of items) {
    console.log(`# ${item.subject}`);
    printTaskList(item.tasks);
  }
}

function printTaskDetails(task) {
  const summary = taskSummary(task);
  for (const [key, value] of Object.entries(summary)) {
    console.log(`${key}: ${value ?? ''}`);
  }
  if (task.input) console.log(`input: ${JSON.stringify(task.input)}`);
  if (task.result) console.log(`result: ${JSON.stringify(task.result)}`);
}

function baseTaskInputFromFlags(flags) {
  return {
    mock: Boolean(flags.mock),
    deepseek: Boolean(flags.deepseek),
    skip_goals_assess: Boolean(flags['skip-goals-assess']),
    skip_belief_update: Boolean(flags['skip-belief-update']),
    exec_limit: flags['exec-limit'] == null || flags['exec-limit'] === true
      ? null
      : parsePositiveInt(flags['exec-limit'], { name: 'exec-limit', min: 1 }),
    retries: parsePositiveInt(flags.retries, { name: 'retries', defaultValue: 3, min: 0 }),
  };
}

function taskInputFromFlags(flags, root, subject) {
  const base = baseTaskInputFromFlags(flags);
  if (!root || !subject) return base;
  const evolution = resolveEvolutionMode(root, { subject, flags });
  return {
    ...base,
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
  };
}

export function refreshWorkerEvolutionMode(root, subject, flags, { workerId, pid, lastMode = null } = {}) {
  const resolved = resolveEvolutionMode(root, { subject, flags });
  if (lastMode != null && resolved.mode !== lastMode) {
    recordDaemonEvent(root, subject, {
      type: 'evolution_mode_changed',
      status: 'ok',
      worker_id: workerId,
      pid,
      from: lastMode,
      to: resolved.mode,
      source: resolved.source,
    });
    updateWorkerHeartbeat(root, subject, {
      worker_id: workerId,
      pid,
      evolution_mode: resolved.mode,
      evolution_mode_source: resolved.source,
    });
  }
  return resolved;
}

function runtimeTaskInput(base, evolution) {
  return {
    ...base,
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
  };
}

function parseTickMs(flags = {}) {
  return parsePositiveInt(flags['tick-ms'], {
    name: 'tick-ms',
    defaultValue: 5 * 60 * 1000,
    min: 1000,
  });
}

function isRetiredTrainTaskType(type) {
  return type === 'run_cycle' || ALL_CYCLE_STEP_TYPES.includes(type);
}

export function failReactorTask(root, subject, task, failure) {
  const maxAttempts = Math.max(1, (task.input?.retries ?? 3) + 1);
  if (failure.retryable !== false && task.attempts < maxAttempts) {
    const released = releaseTaskForRetry(root, subject, task.task_id, failure);
    recordDaemonEvent(root, subject, {
      type: 'task_failed',
      status: 'retry_scheduled',
      task_id: task.task_id,
      task_type: task.type,
      error_code: failure.code,
      error_reason: failure.reason,
    });
    return { ok: false, retryable: true, task: released.task, failure };
  }
  const failed = failTask(root, subject, task.task_id, failure);
  recordDaemonEvent(root, subject, {
    type: 'task_failed',
    status: 'failed',
    task_id: task.task_id,
    task_type: task.type,
    error_code: failure.code,
    error_reason: failure.reason,
  });
  return { ok: false, retryable: false, task: failed.task, failure };
}

export async function withTaskLeaseWatchdog(root, subject, task, flags, work) {
  const workerId = task.lease_owner || flags.worker || `worker-${process.pid}`;
  const { leaseMs, heartbeatMs } = heartbeatDefaults(flags);
  let lastLeaseRenewEventAt = 0;
  let watchdog = null;
  let leaseLost = false;
  const tick = () => {
    const state = readWorkerState(root, subject);
    const stopping = Boolean(state?.stop_requested_at);
    if (flags.watchdog) {
      updateWorkerHeartbeat(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        status: stopping ? 'stopping' : 'running',
        current_task_id: task.task_id,
      });
    }
    const renewed = renewTaskLease(root, subject, task.task_id, { workerId, leaseMs });
    if (!renewed.renewed) {
      leaseLost = true;
      recordDaemonEvent(root, subject, {
        type: 'task_lease_renew_failed',
        status: renewed.reason,
        task_id: task.task_id,
        task_type: task.type,
        lease_owner: workerId,
      });
      return;
    }
    const now = Date.now();
    if (now - lastLeaseRenewEventAt >= Math.max(heartbeatMs * 10, 60_000)) {
      lastLeaseRenewEventAt = now;
      recordDaemonEvent(root, subject, {
        type: 'task_lease_renewed',
        status: 'ok',
        task_id: task.task_id,
        task_type: task.type,
        lease_owner: workerId,
        lease_expires_at: renewed.task.lease_expires_at,
      });
    }
  };
  if (flags.watchdog !== false) {
    tick();
    watchdog = setInterval(tick, heartbeatMs);
  }
  try {
    return await work({ leaseLost: () => leaseLost, workerId, leaseMs });
  } finally {
    if (watchdog) clearInterval(watchdog);
  }
}

async function workReactorTask(root, subject, task, flags) {
  return withTaskLeaseWatchdog(root, subject, task, flags, async ({ leaseLost }) => {
    try {
      const outcome = await runReactorDaemonTask(root, subject, task, {
        ...flags,
        canCommit: () => !leaseLost(),
      });
      if (leaseLost()) {
        const released = releaseTaskForRetry(root, subject, task.task_id, {
          code: 'lease_lost',
          reason: 'task_lease_renew_failed',
          message: 'Reactor task lease was lost before commit',
          retryable: true,
        });
        return { ok: false, retryable: true, task: released.task, reason: 'lease_lost' };
      }
      if (outcome?.ok === false) {
        return failReactorTask(root, subject, task, {
          code: outcome?.code ?? 'reactor_task_failed',
          reason: outcome?.reason || outcome?.result?.error || 'reactor task returned ok=false',
          message: outcome?.reason || outcome?.result?.error || 'reactor task returned ok=false',
          retryable: outcome?.retryable !== false,
        });
      }
      const completed = completeTask(root, subject, task.task_id, {
        ok: true,
        result: outcome?.result ?? outcome,
      });
      recordDaemonEvent(root, subject, {
        type: 'task_completed',
        status: 'ok',
        task_id: task.task_id,
        task_type: task.type,
      });
      return { ok: true, task: completed.task, result: outcome };
    } catch (err) {
      const classification = classifyReactorError(err);
      return failReactorTask(root, subject, task, {
        code: err?.code ?? classification.code ?? 'reactor_task_failed',
        reason: err?.message || String(err),
        message: err?.message || String(err),
        retryable: err?.retryable ?? classification.retryable,
      });
    }
  });
}

async function runWorkOnceBody(root, subject, flags = {}) {
  const workerId = flags.worker || `worker-${process.pid}`;
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const claim = claimNextTask(root, subject, {
    workerId,
    leaseMs,
    type: flags.type && flags.type !== true ? flags.type : null,
    types: Array.isArray(flags.types) ? flags.types : null,
  });
  for (const task of claim.reclaimed || []) {
    recordDaemonEvent(root, subject, {
      type: 'stale_lease_reclaimed',
      status: 'ok',
      task_id: task.task_id,
      task_type: task.type,
      lease_owner: task.previous?.lease_owner,
      lease_expires_at: task.previous?.lease_expires_at,
    });
  }
  if (!claim.task) {
    return { worked: false, task: null };
  }
  recordDaemonEvent(root, subject, {
    type: 'task_claimed',
    status: 'ok',
    task_id: claim.task.task_id,
    task_type: claim.task.type,
    lease_owner: claim.task.lease_owner,
    lease_expires_at: claim.task.lease_expires_at,
  });
  if (isReactorTaskType(claim.task.type)) {
    const outcome = await workReactorTask(root, subject, claim.task, flags);
    return { worked: true, ...outcome };
  }
  if (isRetiredTrainTaskType(claim.task.type)) {
    const failed = failTask(root, subject, claim.task.task_id, {
      code: claim.task.type === 'run_cycle' ? 'run_cycle_removed' : 'train_step_removed',
      reason: claim.task.type === 'run_cycle' ? 'run_cycle_removed' : 'train_step_removed',
      message: `${claim.task.type} was removed in S9. Use cognitive_reaction / jea run (reactor).`,
      retryable: false,
    });
    return { worked: true, ok: false, task: failed.task };
  }
  const failed = failTask(root, subject, claim.task.task_id, {
    code: 'unsupported_task_type',
    reason: claim.task.type,
    message: `Unsupported task type: ${claim.task.type}`,
  });
  return { worked: true, ok: false, task: failed.task };
}

function applyPausedClaimFilter(root, subject, flags = {}) {
  if (!isEvolutionPaused(root, subject)) return flags;
  const explicitType = flags.type && flags.type !== true ? flags.type : null;
  const explicitTypes = Array.isArray(flags.types) ? flags.types : null;
  if (explicitTypes?.length) {
    return {
      ...flags,
      types: explicitTypes.filter((type) => !isPausedBlockedReactorType(type)),
    };
  }
  if (explicitType && !isPausedBlockedReactorType(explicitType)) return flags;
  return {
    ...flags,
    type: null,
    types: [...PAUSED_ALLOWED_REACTOR_TYPES],
  };
}

export async function workOnce(root, subject, flags = {}) {
  const execute = () => runWorkOnceBody(root, subject, applyPausedClaimFilter(root, subject, flags));
  if (flags['subject-lock-held']) {
    return execute();
  }
  const staleMs = parseHeartbeatStaleMs(flags['heartbeat-stale-ms']);
  try {
    return await withSubjectLock(root, subject, execute, { mode: 'daemon', staleMs });
  } catch (err) {
    return {
      worked: false,
      ok: false,
      task: null,
      lockError: err?.message || String(err),
    };
  }
}

async function runChannelWorkOnceBody(root, subject, flags = {}) {
  const workerId = flags.worker || `channel-worker-${process.pid}`;
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const types = flags.types ?? (flags['channel-task-types'] && flags['channel-task-types'] !== true
    ? String(flags['channel-task-types']).split(',').map((s) => s.trim()).filter(Boolean)
    : null);
  const claim = claimNextChannelTask(root, subject, {
    workerId,
    leaseMs,
    type: flags.type && flags.type !== true ? flags.type : null,
    types,
  });
  for (const task of claim.reclaimed || []) {
    recordChannelEvent(root, subject, {
      type: 'channel_stale_lease_reclaimed',
      status: 'ok',
      task_id: task.task_id,
      task_type: task.type,
      lease_owner: task.previous?.lease_owner,
      lease_expires_at: task.previous?.lease_expires_at,
    });
  }
  if (!claim.task) {
    return { worked: false, task: null };
  }
  recordChannelEvent(root, subject, {
    type: 'channel_task_claimed',
    status: 'ok',
    task_id: claim.task.task_id,
    task_type: claim.task.type,
    lease_owner: claim.task.lease_owner,
    lease_expires_at: claim.task.lease_expires_at,
  });
  if (!isChannelTaskType(claim.task.type)) {
    const failed = failChannelTask(root, subject, claim.task.task_id, {
      code: 'unsupported_channel_task_type',
      reason: claim.task.type,
      message: `Unsupported channel task type: ${claim.task.type}`,
    });
    return { worked: true, ok: false, task: failed.task };
  }
  try {
    const result = await runChannelTask(root, subject, claim.task, {
      signal: flags.signal ?? null,
      adapterOptions: flags.adapterOptions ?? null,
    });
    const completed = completeChannelTask(root, subject, claim.task.task_id, result);
    recordChannelEvent(root, subject, {
      type: 'channel_task_completed',
      status: 'ok',
      task_id: claim.task.task_id,
      task_type: claim.task.type,
    });
    return { worked: true, ok: true, task: completed.task, result };
  } catch (err) {
    const failure = {
      code: err?.code ?? 'channel_task_failed',
      reason: err?.message || String(err),
      message: err?.message || String(err),
      retryable: err?.retryable ?? true,
    };
    if (failure.code === 'channel_aborted') {
      const released = releaseChannelTaskForAbort(root, subject, claim.task.task_id, failure);
      recordChannelEvent(root, subject, {
        type: 'channel_task_aborted',
        status: 'cancelled',
        task_id: claim.task.task_id,
        task_type: claim.task.type,
        error_code: failure.code,
        error_reason: failure.reason,
      });
      return { worked: true, ok: false, retryable: true, task: released.task, failure };
    }
    const maxAttempts = Math.max(1, (claim.task.input?.retries ?? 3) + 1);
    if (failure.retryable && claim.task.attempts < maxAttempts) {
      const released = releaseChannelTaskForRetry(root, subject, claim.task.task_id, failure);
      recordChannelEvent(root, subject, {
        type: 'channel_task_failed',
        status: 'retry_scheduled',
        task_id: claim.task.task_id,
        task_type: claim.task.type,
        error_code: failure.code,
        error_reason: failure.reason,
      });
      return { worked: true, ok: false, retryable: true, task: released.task, failure };
    }
    const failed = failChannelTask(root, subject, claim.task.task_id, failure);
    recordChannelEvent(root, subject, {
      type: 'channel_task_failed',
      status: 'failed',
      task_id: claim.task.task_id,
      task_type: claim.task.type,
      error_code: failure.code,
      error_reason: failure.reason,
    });
    return { worked: true, ok: false, retryable: false, task: failed.task, failure };
  }
}

export async function channelWorkOnce(root, subject, flags = {}) {
  return runChannelWorkOnceBody(root, subject, flags);
}

function workResultSummary(result) {
  return {
    worked: Boolean(result.worked),
    ok: result.ok ?? null,
    retryable: result.retryable ?? null,
    task_id: result.task?.task_id ?? null,
    task_status: result.task?.status ?? null,
    error_code: result.failure?.code ?? result.task?.last_error_code ?? null,
  };
}

async function reclaimStaleLeasesForWorker(root, subject) {
  const { reclaimed } = reclaimExpiredLeases(root, subject);
  for (const task of reclaimed) {
    recordDaemonEvent(root, subject, {
      type: 'stale_lease_reclaimed',
      status: 'ok',
      task_id: task.task_id,
      task_type: task.type,
      lease_owner: task.previous?.lease_owner,
      lease_expires_at: task.previous?.lease_expires_at,
    });
  }
  return reclaimed;
}

function recordLoopFailure(root, subject, { operation, err }) {
  const errorCode = err?.code ?? (isQueueWriteError(err) ? 'queue_write_failed' : 'unknown');
  recordDaemonEvent(root, subject, {
    type: isQueueWriteError(err) ? 'queue_write_failed' : 'heartbeat_tick_failed',
    status: 'error',
    operation,
    error_code: errorCode,
    error: err?.message || String(err),
  });
}

async function safeReclaimStaleLeasesForWorker(root, subject) {
  try {
    return await reclaimStaleLeasesForWorker(root, subject);
  } catch (err) {
    recordLoopFailure(root, subject, { operation: 'reclaim', err });
    return [];
  }
}

function safeRunHeartbeatTick(root, subject, taskInput) {
  try {
    return runHeartbeatTick(root, subject, taskInput);
  } catch (err) {
    recordLoopFailure(root, subject, { operation: 'heartbeat_tick', err });
    return null;
  }
}

function safeProcessCycleStartRequests(root, subject, taskInput) {
  try {
    return processCycleStartRequests(root, subject, taskInput);
  } catch (err) {
    recordLoopFailure(root, subject, { operation: 'cycle_start_process', err });
    return null;
  }
}

export async function runDaemonWorker(root, subject, flags = {}) {
  const workerId = flags.worker && flags.worker !== true ? flags.worker : defaultWorkerId();
  const { leaseMs, heartbeatMs, heartbeatStaleMs } = heartbeatDefaults(flags);
  const supervisorLease = supervisorLeaseRuntime(flags);
  let supervisorObservation = supervisorLease.observation;
  const tickMs = parseTickMs(flags);
  const workIntervalMs = parsePositiveInt(flags['interval-ms'], { name: 'interval-ms', defaultValue: 1000, min: 0 });
  const idleIntervalMs = parsePositiveInt(flags['idle-interval-ms'], { name: 'idle-interval-ms', defaultValue: 5000, min: 0 });
  const maxIterations = flags['max-iterations'] == null || flags['max-iterations'] === true
    ? null
    : parsePositiveInt(flags['max-iterations'], { name: 'max-iterations', min: 1 });
  const evolution = resolveEvolutionMode(root, { subject, flags });
  const created = createWorkerState(root, subject, {
    workerId,
    staleMs: heartbeatStaleMs,
    tickMs,
    evolutionMode: evolution.mode,
    evolutionModeSource: evolution.source,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });
  if (!created.created) {
    return { started: false, reason: created.reason, state: created.state };
  }
  if (supervisorObservation.stop) {
    const stopped = markWorkerStopped(root, subject, {
      worker_id: workerId,
      pid: process.pid,
      stop_reason: supervisorObservation.reason,
      supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
    });
    recordDaemonEvent(root, subject, {
      type: 'worker_start_failed',
      status: supervisorObservation.reason,
      worker_id: workerId,
      pid: process.pid,
      reason: supervisorObservation.reason,
    });
    return { started: false, reason: supervisorObservation.reason, state: stopped };
  }

  let lockHandle = null;
  let fatalExit = false;
  const handleFatal = (label, err) => {
    if (fatalExit) return;
    fatalExit = true;
    try {
      recordDaemonEvent(root, subject, {
        type: 'worker_crashed',
        status: 'error',
        worker_id: workerId,
        pid: process.pid,
        reason: label,
        error: err?.message || String(err),
        error_code: err?.code ?? null,
      });
      markWorkerStopped(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        stop_reason: 'crashed',
      });
    } catch {
      // best effort
    }
    if (lockHandle) {
      lockHandle.release().catch(() => {});
    }
    process.exit(1);
  };
  const onUncaughtException = (err) => handleFatal('uncaughtException', err);
  const onUnhandledRejection = (reason) => {
    handleFatal('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  };
  process.once('uncaughtException', onUncaughtException);
  process.once('unhandledRejection', onUnhandledRejection);

  try {
    lockHandle = await acquireSubjectLock(root, subject, {
      staleMs: heartbeatStaleMs,
      mode: 'daemon',
      retries: 0,
    });
  } catch (err) {
    markWorkerStopped(root, subject, {
      worker_id: workerId,
      pid: process.pid,
      stop_reason: 'subject_lock_held',
    });
    recordDaemonEvent(root, subject, {
      type: 'worker_start_failed',
      status: 'subject_lock_held',
      worker_id: workerId,
      error: err?.message || String(err),
    });
    return { started: false, reason: 'subject_lock_held', error: err?.message || String(err), state: readWorkerState(root, subject) };
  }

  recordDaemonEvent(root, subject, {
    type: 'worker_started',
    status: 'ok',
    worker_id: workerId,
    pid: process.pid,
    heartbeat_ms: heartbeatMs,
    lease_ms: leaseMs,
    tick_ms: tickMs,
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
    supervisor_required: supervisorLease.guard.required,
  });
  updateWorkerHeartbeat(root, subject, {
    worker_id: workerId,
    pid: process.pid,
    tick_ms: tickMs,
    evolution_mode: evolution.mode,
    evolution_mode_source: evolution.source,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });

  let stopping = false;
  let stopReason = 'stopped';
  const localStopController = new AbortController();
  const requestLocalStop = (reason = 'signal') => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    localStopController.abort();
    requestWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);
  let iterations = 0;
  const baseTaskInput = baseTaskInputFromFlags(flags);
  let lastEvolutionMode = evolution.mode;
  let tickTimer = null;
  let supervisorTimer = null;
  let supervisorFingerprint = JSON.stringify(supervisorStateMirror(
    supervisorLease.config,
    supervisorObservation,
  ));
  const checkSupervisorLease = () => {
    if (!supervisorLease.guard.required || stopping) return supervisorObservation;
    supervisorObservation = supervisorLease.guard.check();
    const supervisor = supervisorStateMirror(supervisorLease.config, supervisorObservation);
    const nextFingerprint = JSON.stringify(supervisor);
    if (nextFingerprint !== supervisorFingerprint) {
      supervisorFingerprint = nextFingerprint;
      updateWorkerHeartbeat(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        status: supervisorObservation.stop ? 'stopping' : 'running',
        supervisor,
      });
    }
    if (supervisorObservation.stop) {
      recordDaemonEvent(root, subject, {
        type: 'supervisor_lease_lost',
        status: 'stopping',
        worker_id: workerId,
        pid: process.pid,
        reason: supervisorObservation.reason,
      });
      requestLocalStop(supervisorObservation.reason);
    }
    return supervisorObservation;
  };
  if (supervisorLease.checkIntervalMs) {
    supervisorTimer = setInterval(checkSupervisorLease, supervisorLease.checkIntervalMs);
    supervisorTimer.unref?.();
  }
  const runScheduledTick = () => {
    if (stopping) return;
    try {
      const resolvedEvolution = refreshWorkerEvolutionMode(root, subject, flags, {
        workerId,
        pid: process.pid,
        lastMode: lastEvolutionMode,
      });
      lastEvolutionMode = resolvedEvolution.mode;
      const runtimeInput = runtimeTaskInput(baseTaskInput, resolvedEvolution);
      safeRunHeartbeatTick(root, subject, {
        ...runtimeInput,
        tick_ms: tickMs,
      });
    } catch (err) {
      recordLoopFailure(root, subject, { operation: 'heartbeat_tick', err });
    }
  };
  runScheduledTick();
  tickTimer = setInterval(runScheduledTick, tickMs);
  try {
    await runDomainWorkerLoop({
      shouldStop: () => {
        checkSupervisorLease();
        if (stopping) return true;
        if (maxIterations && iterations >= maxIterations) return true;
        const current = readWorkerState(root, subject);
        return Boolean(current?.stop_requested_at);
      },
      heartbeat: () => {
        updateWorkerHeartbeat(root, subject, {
          worker_id: workerId,
          pid: process.pid,
          status: 'running',
        });
      },
      claim: async () => {
        if (stopping) return null;
        const current = readWorkerState(root, subject);
        if (current?.stop_requested_at) return null;
        const resolvedEvolution = refreshWorkerEvolutionMode(root, subject, flags, {
          workerId,
          pid: process.pid,
          lastMode: lastEvolutionMode,
        });
        lastEvolutionMode = resolvedEvolution.mode;
        await safeReclaimStaleLeasesForWorker(root, subject);
        return workOnce(root, subject, {
          ...flags,
          worker: workerId,
          'lease-ms': leaseMs,
          'heartbeat-ms': heartbeatMs,
          watchdog: true,
          signal: localStopController.signal,
          'subject-lock-held': true,
        });
      },
      execute: async (result) => {
        iterations += 1;
        const summary = workResultSummary(result);
        updateWorkerHeartbeat(root, subject, {
          worker_id: workerId,
          pid: process.pid,
          status: 'running',
          last_work_result: summary,
          last_error: summary.error_code ? {
            code: summary.error_code,
            task_id: summary.task_id,
            task_status: summary.task_status,
          } : null,
        });
        if (maxIterations && iterations >= maxIterations) {
          stopping = true;
          stopReason = 'max_iterations';
        }
        const afterWork = readWorkerState(root, subject);
        if (afterWork?.stop_requested_at) {
          stopping = true;
          stopReason = 'stop_requested';
        } else if (stopping && stopReason === 'stopped') {
          stopReason = 'signal';
        }
      },
      afterExecute: async (result) => {
        if (result?.worked) return workIntervalMs;
        const resolvedEvolution = refreshWorkerEvolutionMode(root, subject, flags, {
          workerId,
          pid: process.pid,
          lastMode: lastEvolutionMode,
        });
        lastEvolutionMode = resolvedEvolution.mode;
        safeProcessCycleStartRequests(root, subject, {
          ...runtimeTaskInput(baseTaskInput, resolvedEvolution),
          tick_ms: tickMs,
        });
        try {
          scanWakeBacklog(root, subject, { enqueueTask });
        } catch (err) {
          recordLoopFailure(root, subject, { operation: 'wake_backlog_scan', err });
        }
        return idleIntervalMs;
      },
      idleMs: idleIntervalMs,
    });
    if (!stopping && stopReason === 'stopped') {
      const current = readWorkerState(root, subject);
      if (current?.stop_requested_at) stopReason = 'stop_requested';
    }
  } finally {
    if (tickTimer) clearInterval(tickTimer);
    if (supervisorTimer) clearInterval(supervisorTimer);
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('SIGINT', requestLocalStop);
    process.removeListener('SIGTERM', requestLocalStop);
    if (lockHandle) {
      await lockHandle.release();
    }
  }
  const stopped = markWorkerStopped(root, subject, {
    worker_id: workerId,
    pid: process.pid,
    stop_reason: stopReason,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });
  recordDaemonEvent(root, subject, {
    type: 'worker_stopped',
    status: 'ok',
    worker_id: workerId,
    pid: process.pid,
    reason: stopReason,
  });
  return { started: true, reason: stopReason, state: stopped, iterations };
}

async function runChannelDomainWorkerSingle(root, subject, flags = {}) {
  const workerId = flags.worker && flags.worker !== true ? String(flags.worker).replace(/^worker-/, 'channel-worker-') : defaultChannelWorkerId().replace(/^worker-/, 'channel-worker-');
  const supervisorLease = supervisorLeaseRuntime(flags);
  let supervisorObservation = supervisorLease.observation;
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const heartbeatMs = parseChannelHeartbeatMs(flags['channel-heartbeat-ms'] ?? flags['heartbeat-ms']);
  const heartbeatStaleMs = parseChannelHeartbeatStaleMs(
    flags['channel-heartbeat-stale-ms'] ?? flags['heartbeat-stale-ms'],
    Math.max(leaseMs * 2, heartbeatMs * 3, 60_000),
  );
  const tickMs = parseTickMs(flags);
  const workIntervalMs = parsePositiveInt(flags['channel-interval-ms'] ?? flags['interval-ms'], { name: 'channel-interval-ms', defaultValue: 1000, min: 0 });
  const idleIntervalMs = parsePositiveInt(flags['channel-idle-interval-ms'] ?? flags['idle-interval-ms'], { name: 'channel-idle-interval-ms', defaultValue: 5000, min: 0 });
  const maxIterations = flags['max-iterations'] == null || flags['max-iterations'] === true
    ? null
    : parsePositiveInt(flags['max-iterations'], { name: 'max-iterations', min: 1 });
  reconcileChannelWorkerState(root, subject, { staleMs: heartbeatStaleMs });
  const created = createChannelWorkerState(root, subject, {
    workerId,
    staleMs: heartbeatStaleMs,
    tickMs,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });
  if (!created.created) {
    return { started: false, reason: created.reason, state: created.state };
  }
  if (supervisorObservation.stop) {
    const stopped = markChannelWorkerStopped(root, subject, {
      worker_id: workerId,
      pid: process.pid,
      stop_reason: supervisorObservation.reason,
      supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
    });
    recordChannelEvent(root, subject, {
      type: 'channel_worker_start_failed',
      status: supervisorObservation.reason,
      worker_id: workerId,
      pid: process.pid,
      reason: supervisorObservation.reason,
    });
    return { started: false, reason: supervisorObservation.reason, state: stopped };
  }
  recordChannelEvent(root, subject, {
    type: 'channel_worker_started',
    status: 'ok',
    worker_id: workerId,
    pid: process.pid,
    heartbeat_ms: heartbeatMs,
    lease_ms: leaseMs,
    tick_ms: tickMs,
    supervisor_required: supervisorLease.guard.required,
  });
  updateChannelWorkerHeartbeat(root, subject, {
    worker_id: workerId,
    pid: process.pid,
    tick_ms: tickMs,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });

  let stopping = false;
  let stopReason = 'stopped';
  const stopController = new AbortController();
  const requestLocalStop = (reason = 'signal') => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    if (!stopController.signal.aborted) stopController.abort(new Error('channel worker stopping'));
    requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);

  let iterations = 0;
  let tickTimer = null;
  let stopPollTimer = null;
  let supervisorTimer = null;
  let supervisorFingerprint = JSON.stringify(supervisorStateMirror(
    supervisorLease.config,
    supervisorObservation,
  ));
  const checkSupervisorLease = () => {
    if (!supervisorLease.guard.required || stopping) return supervisorObservation;
    supervisorObservation = supervisorLease.guard.check();
    const supervisor = supervisorStateMirror(supervisorLease.config, supervisorObservation);
    const nextFingerprint = JSON.stringify(supervisor);
    if (nextFingerprint !== supervisorFingerprint) {
      supervisorFingerprint = nextFingerprint;
      safeUpdateChannelSupervisorState(root, subject, supervisor);
    }
    if (supervisorObservation.stop) {
      recordChannelEvent(root, subject, {
        type: 'channel_supervisor_lease_lost',
        status: 'stopping',
        worker_id: workerId,
        pid: process.pid,
        reason: supervisorObservation.reason,
      });
      requestLocalStop(supervisorObservation.reason);
    }
    return supervisorObservation;
  };
  if (supervisorLease.checkIntervalMs) {
    supervisorTimer = setInterval(checkSupervisorLease, supervisorLease.checkIntervalMs);
    supervisorTimer.unref?.();
  }
  const runScheduledTick = () => {
    if (stopping) return;
    try {
      runChannelTick(root, subject, { tick_ms: tickMs });
    } catch (err) {
      recordChannelEvent(root, subject, {
        type: 'channel_tick_failed',
        status: 'error',
        error_code: err?.code ?? null,
        error: err?.message || String(err),
      });
    }
  };
  runScheduledTick();
  tickTimer = setInterval(runScheduledTick, tickMs);
  stopPollTimer = setInterval(() => {
    if (readChannelWorkerState(root, subject)?.stop_requested_at) requestLocalStop();
  }, 250);
  stopPollTimer.unref?.();
  const listenerSupervisor = runChannelListenerSupervisor(root, subject, flags, {
    signal: stopController.signal,
    refreshIntervalMs: Math.max(workIntervalMs, 1000),
  });

  try {
    for (;;) {
      checkSupervisorLease();
      const current = readChannelWorkerState(root, subject);
      if (stopping || current?.stop_requested_at) {
        stopReason = current?.stop_requested_at ? 'stop_requested' : 'signal';
        break;
      }
      safeUpdateChannelWorkerHeartbeat(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        status: 'running',
      });
      const { reclaimed } = reclaimExpiredChannelLeases(root, subject);
      for (const task of reclaimed) {
        recordChannelEvent(root, subject, {
          type: 'channel_stale_lease_reclaimed',
          status: 'ok',
          task_id: task.task_id,
          task_type: task.type,
          lease_owner: task.previous?.lease_owner,
        });
      }
      const result = await channelWorkOnce(root, subject, {
        ...flags,
        worker: workerId,
        'lease-ms': leaseMs,
        signal: stopController.signal,
      });
      iterations += 1;
      const summary = workResultSummary(result);
      safeUpdateChannelWorkerHeartbeat(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        status: 'running',
        last_work_result: summary,
        last_error: summary.error_code ? {
          code: summary.error_code,
          task_id: summary.task_id,
          task_status: summary.task_status,
        } : null,
      });
      if (maxIterations && iterations >= maxIterations) {
        stopReason = 'max_iterations';
        break;
      }
      const afterWork = readChannelWorkerState(root, subject);
      if (stopping || afterWork?.stop_requested_at) {
        stopReason = afterWork?.stop_requested_at ? 'stop_requested' : 'signal';
        break;
      }
      await sleep(result.worked ? workIntervalMs : idleIntervalMs, stopController.signal);
    }
  } finally {
    if (!stopController.signal.aborted) stopController.abort(new Error('channel worker stopped'));
    if (tickTimer) clearInterval(tickTimer);
    if (stopPollTimer) clearInterval(stopPollTimer);
    if (supervisorTimer) clearInterval(supervisorTimer);
    await listenerSupervisor;
    process.removeListener('SIGINT', requestLocalStop);
    process.removeListener('SIGTERM', requestLocalStop);
    reconcileChannelWorkerState(root, subject, { staleMs: heartbeatStaleMs });
  }
  const stopped = markChannelWorkerStopped(root, subject, {
    worker_id: workerId,
    pid: process.pid,
    stop_reason: stopReason,
    supervisor: supervisorStateMirror(supervisorLease.config, supervisorObservation),
  });
  recordChannelEvent(root, subject, {
    type: 'channel_worker_stopped',
    status: 'ok',
    worker_id: workerId,
    pid: process.pid,
    reason: stopReason,
  });
  return { started: true, reason: stopReason, state: stopped, iterations };
}

export async function runChannelDomainWorker(root, subject, flags = {}) {
  const roles = resolveChannelDomainRoles(flags);
  const supervisorLease = supervisorLeaseRuntime(flags);
  const tickMs = parseTickMs(flags);
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const heartbeatStaleMs = parseChannelHeartbeatStaleMs(
    flags['channel-heartbeat-stale-ms'] ?? flags['heartbeat-stale-ms'],
    Math.max(leaseMs * 2, parseChannelHeartbeatMs(flags['channel-heartbeat-ms'] ?? flags['heartbeat-ms']) * 3, 60_000),
  );
  const workIntervalMs = parsePositiveInt(flags['channel-interval-ms'] ?? flags['interval-ms'], { name: 'channel-interval-ms', defaultValue: 1000, min: 0 });
  const idleIntervalMs = parsePositiveInt(flags['channel-idle-interval-ms'] ?? flags['idle-interval-ms'], { name: 'channel-idle-interval-ms', defaultValue: 5000, min: 0 });
  const maxIterations = flags['max-iterations'] == null || flags['max-iterations'] === true
    ? null
    : parsePositiveInt(flags['max-iterations'], { name: 'max-iterations', min: 1 });

  if (roles.length === 1 && roles[0] === 'all') {
    return runChannelDomainWorkerSingle(root, subject, flags);
  }

  return runChannelDomainWorkerMulti(root, subject, flags, {
    roles,
    tickMs,
    leaseMs,
    heartbeatStaleMs,
    workIntervalMs,
    idleIntervalMs,
    maxIterations,
    channelWorkOnce: channelWorkOnce,
    supervisorLease,
  });
}

export function normalizeDaemonDomain(raw, fallback = 'all') {
  const domain = raw && raw !== true ? String(raw) : fallback;
  if (domain === 'evolution') return 'cycle';
  return domain;
}

export async function runDaemonDomains(root, subject, flags = {}) {
  const domain = normalizeDaemonDomain(flags.domain, 'all');
  if (domain === 'cycle') return runDaemonWorker(root, subject, flags);
  if (domain === 'channel') return runChannelDomainWorker(root, subject, flags);
  const [cycle, channel] = await Promise.all([
    runDaemonWorker(root, subject, { ...flags, domain: 'cycle' }),
    runChannelDomainWorker(root, subject, { ...flags, domain: 'channel' }),
  ]);
  return {
    started: Boolean(cycle.started || channel.started),
    reason: [cycle.reason, channel.reason].filter(Boolean).join(','),
    domains: { cycle, channel },
  };
}

function printProjection(projection) {
  console.log(`# Daemon Status: ${projection.subject}`);
  if (projection.evolution_state) {
    console.log(`evolution_state: ${projection.evolution_state} (${projection.evolution_state_source ?? 'unknown'})`);
  }
  console.log(`health: ${projection.health.status} ok=${projection.health.ok}`);
  if (projection.channel?.health) {
    console.log(`channel: ${projection.channel.health.status} ok=${projection.channel.health.ok}`);
  }
  for (const reason of projection.health.reasons || []) console.log(`reason: ${reason}`);
  console.log(`worker: ${projection.worker.status} pid=${projection.worker.pid ?? 'none'} heartbeat=${projection.worker.heartbeat_at ?? 'none'}`);
  console.log(`tasks: ${projection.tasks.total}`);
  console.log(`counts: ${JSON.stringify(projection.tasks.counts)}`);
  if (projection.tasks.expired_running_count) {
    console.log(`expired running leases: ${projection.tasks.expired_running_count}`);
  }
  if (projection.reactor_progress?.freshness) {
    console.log(`reactor_progress: gen=${projection.reactor_progress.projection_generation} freshness=${projection.reactor_progress.freshness.status}`);
  }
  if (projection.tasks.next_task) {
    console.log(`next: ${projection.tasks.next_task.task_id} (${projection.tasks.next_task.type})`);
  }
  for (const item of projection.tasks.running) {
    console.log(`running: ${item.task_id} owner=${item.lease_owner} lease=${item.lease_expires_at}`);
  }
  for (const item of projection.tasks.failed) {
    console.log(`failed: ${item.task_id} ${item.last_error_code || ''} ${item.last_error || ''}`);
  }
  for (const suggestion of projection.health.suggestions || []) console.log(`suggestion: ${suggestion}`);
}

function printProjectionSummaries(items) {
  for (const item of items) {
    const counts = item.tasks.counts || {};
    const event = item.latest_event
      ? `${item.latest_event.type || 'event'} ${item.latest_event.status || ''}`.trim()
      : 'none';
    console.log(`# ${item.subject}`);
    console.log(`health: ${item.health.status} ok=${item.health.ok}`);
    console.log(`worker: ${item.worker.status} pid=${item.worker.pid ?? 'none'} heartbeat=${item.worker.heartbeat_at ?? 'none'}`);
    console.log(`tasks: pending=${counts.pending || 0} running=${counts.running || 0} failed=${counts.failed || 0} total=${item.tasks.total}`);
    console.log(`evolve_lock: ${item.locked ? 'held' : 'free'}`);
    console.log(`latest_event: ${event}`);
    if (item.reactor_progress?.freshness) {
      console.log(`reactor_progress: gen=${item.reactor_progress.projection_generation} freshness=${item.reactor_progress.freshness.status}`);
    }
    for (const reason of item.health.reasons || []) console.log(`reason: ${reason}`);
  }
}

function printArtifactInbox(items) {
  if (!items.length) {
    console.log('No subjects found.');
    return;
  }
  for (const item of items) {
    console.log(`# ${item.subject}`);
    console.log(`health: ${item.attention.health_status ?? 'unknown'}`);
    console.log(`pending_tasks: ${item.attention.pending_tasks} failed_tasks: ${item.attention.failed_tasks} acknowledged_tasks: ${item.attention.acknowledged_tasks}`);
    const report = item.latest_report;
    console.log(`latest_report: ${report?.cycle_id ?? 'none'} ${report?.generated_at ?? report?.recorded_at ?? ''}`.trim());
    if (report?.tldr) console.log(`  tldr: ${report.tldr}`);
    const diary = item.latest_diary;
    console.log(`latest_diary: ${diary?.name ?? 'none'} ${diary?.mtime ?? ''}`.trim());
    const verify = item.latest_verify_report;
    console.log(`latest_verify_report: ${verify?.name ?? 'none'} ${verify?.semantic_status ? `semantic=${verify.semantic_status}` : ''}`.trim());
    console.log(`standing_memory: ${item.standing_memory.exists ? item.standing_memory.updated_at || 'available' : 'none'}`);
    const pendingQuestions = item.pending_operator_questions || [];
    console.log(`pending_operator_questions: ${pendingQuestions.length}`);
    for (const q of pendingQuestions.slice(0, 5)) {
      console.log(`  - ${q.id}: ${String(q.question || '').slice(0, 120)}`);
    }
    const pendingFacts = item.pending_operator_facts || [];
    if (pendingFacts.length) {
      console.log(`pending_operator_facts: ${pendingFacts.length}`);
    }
    for (const reason of item.attention.reasons || []) console.log(`reason: ${reason}`);
  }
}

export async function daemonCommand({ subcommand, flags = {}, args = [], root = getProjectRoot() } = {}) {
  loadProjectEnv(root);
  const subjects = selectSubjects(root, {
    subject: flags.subject,
    subjects: flags.subjects,
    all: Boolean(flags.all),
  });
  const subject = subjects[0];
  const multiSubject = subjects.length > 1 || hasMultiSubjectSelection(flags);

  if (subcommand === 'evolution-state') {
    if (multiSubject) {
      console.error('daemon evolution-state supports one subject at a time.');
      return 2;
    }
    const [stateCommand, ...stateArgs] = args;
    if (stateCommand === 'show') {
      const resolved = resolveEvolutionState(root, subject);
      if (flags.json) {
        console.log(JSON.stringify({ subject, ...resolved }, null, 2));
      } else {
        console.log(`subject: ${subject}`);
        console.log(`evolution_state: ${resolved.state}`);
        console.log(`source: ${resolved.mapped_from}`);
        if (resolved.diagnostic) console.log(`diagnostic: ${resolved.diagnostic}`);
      }
      return 0;
    }
    if (stateCommand === 'set') {
      const rawState = stateArgs[0] || (flags.state && flags.state !== true ? String(flags.state) : null);
      if (!rawState) {
        console.error('Usage: jea daemon evolution-state set <active|paused> [--subject NAME] [--json]');
        return 2;
      }
      try {
        const result = applyEvolutionStateChange(root, subject, rawState);
        if (flags.json) {
          console.log(JSON.stringify({ subject, ...result }, null, 2));
        } else if (!result.changed) {
          console.log(`evolution_state already ${result.state} (${result.source})`);
        } else {
          console.log(`evolution_state: ${result.previous} -> ${result.state}`);
          console.log(`source: ${result.source}`);
          console.log(`path: ${result.path}`);
        }
        return 0;
      } catch (err) {
        console.error(err?.message || String(err));
        return 2;
      }
    }
    console.error('Usage: jea daemon evolution-state <show|set> ...');
    console.error('       jea daemon evolution-state show [--subject NAME] [--json]');
    console.error('       jea daemon evolution-state set <active|paused> [--subject NAME] [--json]');
    return 2;
  }

  if (subcommand === 'evolution-mode') {
    if (multiSubject) {
      console.error('daemon evolution-mode supports one subject at a time.');
      return 2;
    }
    const [modeCommand, ...modeArgs] = args;
    if (modeCommand === 'show') {
      const resolved = resolveEvolutionMode(root, { subject, flags });
      if (flags.json) {
        console.log(JSON.stringify({ subject, ...resolved, deprecated: true }, null, 2));
      } else {
        console.log(`subject: ${subject}`);
        console.log(`evolution_mode: ${resolved.mode}`);
        console.log(`source: ${resolved.source}`);
        console.log('deprecated: use `jea daemon evolution-state` (active|paused); scheduling is evidence-driven');
      }
      return 0;
    }
    if (modeCommand === 'set') {
      const rawMode = modeArgs[0] || (flags.mode && flags.mode !== true ? String(flags.mode) : null);
      if (!rawMode) {
        console.error('Usage: jea daemon evolution-mode set <continuous|on_demand> [--subject NAME] [--json]');
        return 2;
      }
      try {
        const result = applyEvolutionModeChange(root, subject, rawMode);
        if (flags.json) {
          console.log(JSON.stringify({ subject, ...result }, null, 2));
        } else if (!result.changed) {
          console.log(`evolution_mode already ${result.mode} (${result.source})`);
          console.log('deprecated: this no longer changes scheduling; use `jea daemon evolution-state set active|paused`');
        } else {
          console.log(`evolution_mode: ${result.previous} -> ${result.mode}`);
          console.log(`source: ${result.source}`);
          console.log(`path: ${result.path}`);
          console.log('deprecated: this no longer changes scheduling; use `jea daemon evolution-state set active|paused`');
        }
        return 0;
      } catch (err) {
        console.error(err?.message || String(err));
        return 2;
      }
    }
    console.error('Usage: jea daemon evolution-mode <show|set> ...');
    console.error('       jea daemon evolution-mode show [--subject NAME] [--json]');
    console.error('       jea daemon evolution-mode set <continuous|on_demand> [--subject NAME] [--json]');
    return 2;
  }

  if (subcommand === 'cycle' || subcommand === 'reaction') {
    if (multiSubject) {
      console.error(`daemon ${subcommand} supports one subject at a time.`);
      return 2;
    }
    const [cycleCommand, ...cycleArgs] = args;
    if (cycleCommand === 'request') {
      const reason = flags.reason && flags.reason !== true ? String(flags.reason) : 'manual';
      const note = flags.note && flags.note !== true ? String(flags.note) : null;
      const result = enqueueReactionRequest(root, subject, {
        reason,
        source: 'cli',
        meta: note ? { note } : {},
      });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`reaction request: ${result.request.request_id}`);
        console.log(`reasons: ${result.request.reasons.join(', ')}`);
        if (result.wake?.id) console.log(`wake: ${result.wake.id}`);
        console.log(result.created ? 'status: created' : 'status: merged');
      }
      return 0;
    }
    console.error(`Usage: jea daemon ${subcommand} request [--reason TEXT] [--note TEXT] [--subject NAME] [--json]`);
    return 2;
  }

  if (subcommand === 'enqueue') {
    if (multiSubject) {
      console.error('daemon enqueue supports one subject at a time. Use evolve --enqueue-only --subjects for batch task creation.');
      return 2;
    }
    const type = flags.type && flags.type !== true ? flags.type : 'cognitive_reaction';
    if (type === 'run_cycle' || ALL_CYCLE_STEP_TYPES.includes(type)) {
      console.error(`${type} was removed in S9. Use --type cognitive_reaction (or exec_queue / verify_batch).`);
      return 2;
    }
    const result = enqueueDaemonTask(root, subject, {
      type,
      idempotencyKey: flags['idempotency-key'] && flags['idempotency-key'] !== true ? flags['idempotency-key'] : null,
      priority: flags.priority || 100,
      input: taskInputFromFlags(flags, root, subject),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printTask(result.task, { created: result.created });
    return 0;
  }

  if (subcommand === 'process-once') {
    if (multiSubject) {
      console.error('daemon process-once supports one subject at a time.');
      return 2;
    }
    const laneGuard = checkSubjectLaneReady(root, { subject });
    if (!laneGuard.ok) {
      printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
      return 1;
    }
    const result = await processCycleOnce(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`status: ${result.status}`);
      console.log(`reason: ${result.reason}`);
      console.log(`backlog: ${result.backlog.before} -> ${result.backlog.after}`);
      if (!result.channel.unchanged) console.log('warning: Channel worker state changed');
    }
    return processOnceCommandExitCode(result.status);
  }

  if (subcommand === 'work') {
    if (multiSubject) {
      console.error('daemon work supports one subject at a time. Start one worker per subject for parallel evolution.');
      return 2;
    }
    if (!flags.once) {
      console.error('Usage: jea daemon work --once [--subject NAME]');
      return 2;
    }
    const domain = normalizeDaemonDomain(flags.domain, 'cycle');
    if (domain !== 'channel') {
      const laneGuard = checkSubjectLaneReady(root, { subject });
      if (!laneGuard.ok) {
        printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
        return 1;
      }
    }
    const result = domain === 'channel'
      ? await channelWorkOnce(root, subject, flags)
      : await workOnce(root, subject, flags);
    if (result.lockError) {
      console.error(result.lockError);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      return 1;
    }
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.worked) console.log('No daemon task available.');
    else printTask(result.task);
    return result.worked && result.ok === false && result.retryable === false ? 1 : 0;
  }

  if (subcommand === 'start') {
    if (multiSubject) {
      console.error('daemon start supports one subject at a time. External orchestrators should start one worker process per subject.');
      return 2;
    }
    const domain = normalizeDaemonDomain(flags.domain, 'all');
    if (domain !== 'channel') {
      const laneGuard = checkSubjectLaneReady(root, { subject });
      if (!laneGuard.ok) {
        printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
        return 1;
      }
    }
    const result = await runDaemonDomains(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.started) console.log(`Daemon worker not started: ${result.reason}`);
    else console.log(`Daemon worker stopped: ${result.reason}`);
    return result.started ? 0 : 1;
  }

  if (subcommand === 'stop') {
    const heartbeatStaleMs = parseHeartbeatStaleMs(flags['heartbeat-stale-ms']);
    const results = subjects.map((name) => {
      const result = requestWorkerStop(root, name, { staleMs: heartbeatStaleMs });
      const channel = requestChannelWorkerStop(root, name, { staleMs: heartbeatStaleMs });
      recordDaemonEvent(root, name, {
        type: 'worker_stop_requested',
        status: result.requested ? 'ok' : result.reason,
        worker_id: result.state?.worker_id,
        pid: result.state?.pid,
        reason: result.reason,
      });
      recordChannelEvent(root, name, {
        type: 'channel_worker_stop_requested',
        status: channel.requested ? 'ok' : channel.reason,
        worker_id: channel.state?.worker_id,
        pid: channel.state?.pid,
        reason: channel.reason,
      });
      return { subject: name, cycle: result, channel };
    });
    if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: results } : results[0], null, 2));
    else {
      for (const result of results) {
        const cycleText = result.cycle.requested ? 'cycle stop requested' : `cycle ${result.cycle.reason}`;
        const channelText = result.channel.requested ? 'channel stop requested' : `channel ${result.channel.reason}`;
        console.log(`${result.subject}: ${cycleText}; ${channelText}`);
      }
    }
    return 0;
  }

  if (subcommand === 'events' || subcommand === 'logs') {
    const limit = parseLimit(flags.limit, 20);
    const items = subjects.map((name) => ({
      subject: name,
      events: readDaemonEvents(root, name, { limit }),
    }));
    if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: items } : items[0], null, 2));
    else if (multiSubject) printMultiEvents(items);
    else printEvents(items[0].events);
    return 0;
  }

  if (subcommand === 'doctor') {
    const reports = subjects.map((name) => buildDaemonDiagnostics(root, name, buildProjection(root, name, flags)));
    if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: reports } : reports[0], null, 2));
    else if (multiSubject) printMultiDiagnostics(reports);
    else printDiagnostics(reports[0]);
    return reports.every((report) => report.health.ok) ? 0 : 1;
  }

  if (subcommand === 'tasks') {
    const [taskCommand, taskId] = args;
    if (!taskCommand || taskCommand === 'list') {
      const items = subjects.map((name) => {
        const queue = readTaskQueue(root, name);
        return {
          subject: name,
          tasks: sortedTasks(queue.tasks || [])
            .filter((task) => !flags.status || task.status === flags.status)
            .map(taskSummary),
        };
      });
      if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: items } : items[0], null, 2));
      else if (multiSubject) printMultiTaskList(items);
      else printTaskList(items[0].tasks);
      return 0;
    }
    if (multiSubject) {
      console.error('daemon tasks inspect/retry/cancel/acknowledge supports one subject at a time.');
      return 2;
    }
    const queue = readTaskQueue(root, subject);
    if (taskCommand === 'inspect') {
      const task = (queue.tasks || []).find((item) => item.task_id === taskId);
      if (!task) {
        console.error(`Task not found: ${taskId || '(missing)'}`);
        return 1;
      }
      if (flags.json) console.log(JSON.stringify({ subject, task }, null, 2));
      else printTaskDetails(task);
      return 0;
    }
    if (taskCommand === 'retry') {
      try {
        const retried = retryTask(root, subject, taskId, {
          code: 'manual_retry',
          reason: 'daemon_cli',
          message: 'Task scheduled for retry by daemon CLI.',
        });
        recordDaemonEvent(root, subject, {
          type: 'task_retry_requested',
          status: 'ok',
          task_id: retried.task.task_id,
          task_type: retried.task.type,
        });
        if (flags.json) console.log(JSON.stringify(retried, null, 2));
        else printTask(retried.task);
        return 0;
      } catch (e) {
        if (flags.json) console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
        else console.error(e?.message || String(e));
        return 1;
      }
    }
    if (taskCommand === 'cancel') {
      try {
        const cancelled = cancelTask(root, subject, taskId);
        recordDaemonEvent(root, subject, {
          type: 'task_cancelled',
          status: 'ok',
          task_id: cancelled.task.task_id,
          task_type: cancelled.task.type,
        });
        if (flags.json) console.log(JSON.stringify(cancelled, null, 2));
        else printTask(cancelled.task);
        return 0;
      } catch (e) {
        if (flags.json) console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
        else console.error(e?.message || String(e));
        return 1;
      }
    }
    if (taskCommand === 'acknowledge' || taskCommand === 'ack') {
      try {
        const acknowledged = acknowledgeTask(root, subject, taskId);
        recordDaemonEvent(root, subject, {
          type: 'task_acknowledged',
          status: 'ok',
          task_id: acknowledged.task.task_id,
          task_type: acknowledged.task.type,
        });
        if (flags.json) console.log(JSON.stringify(acknowledged, null, 2));
        else printTask(acknowledged.task);
        return 0;
      } catch (e) {
        if (flags.json) console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
        else console.error(e?.message || String(e));
        return 1;
      }
    }
    console.error('Usage: jea daemon tasks <list|inspect|retry|cancel|acknowledge> [task_id] [--status STATUS] [--json]');
    return 2;
  }

  if (subcommand === 'inbox' || subcommand === 'overview') {
    const repoLinks = await buildLinkHealthSummary(root, { probe: false }).catch(() => ({ configured: false, links: [] }));
    const items = subjects.map((name) => {
      const projection = buildProjection(root, name, flags);
      return buildSubjectArtifactOverview(root, name, { projection, repoLinks });
    });
    if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: items } : items[0], null, 2));
    else printArtifactInbox(items);
    return 0;
  }

  if (subcommand === 'status' || !subcommand) {
    const projections = subjects.map((name) => buildProjection(root, name, flags));
    if (flags.json) {
      const payload = multiSubject
        ? { subjects: projections.map((projection) => projectionSummary(root, projection.subject, projection)) }
        : projections[0];
      console.log(JSON.stringify(payload, null, 2));
    } else if (multiSubject) {
      printProjectionSummaries(projections.map((projection) => projectionSummary(root, projection.subject, projection)));
    } else {
      printProjection(projections[0]);
    }
    return 0;
  }

  {
    console.error('Usage: jea daemon <enqueue|work|process-once|start|stop|status|events|doctor|tasks|inbox|cycle|reaction|evolution-state|evolution-mode> [--subject NAME] [--subjects a,b | --all] [--json]');
    console.error('       jea daemon enqueue --type cognitive_reaction|exec_queue|verify_batch|rule_reaction|memory_compaction [--idempotency-key KEY]');
    console.error('       jea daemon reaction request [--reason TEXT] [--note TEXT]');
    console.error('       jea daemon cycle request [--reason TEXT] [--note TEXT]  (compat alias)');
    console.error('       jea daemon evolution-state show [--json]');
    console.error('       jea daemon evolution-state set <active|paused> [--json]');
    console.error('       jea daemon evolution-mode show|set  (deprecated; does not change scheduling)');
    console.error('       jea daemon process-once [--mock] [--subject NAME] [--json]');
    console.error('       jea daemon work --once');
    console.error('       jea daemon start [--tick-ms N] [--domain evolution|cycle|channel|all] [--interval-ms N] [--idle-interval-ms N] [--heartbeat-ms N]');
    console.error('       jea daemon stop');
    console.error('       jea daemon events [--limit N]');
    console.error('       jea daemon doctor');
    console.error('       jea daemon tasks <list|inspect|retry|cancel|acknowledge>');
    console.error('       jea daemon inbox [--all]');
    return 2;
  }
}
