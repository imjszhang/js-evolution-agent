import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import { isSubjectLocked, normalizeEvolveSubjects, parsePositiveInt } from '../utils/evolve-runs.mjs';
import {
  cancelTask,
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  parseLeaseMs,
  reclaimExpiredLeases,
  readTaskQueue,
  renewTaskLease,
  releaseTaskForRetry,
  retryTask,
} from '../utils/daemon-tasks.mjs';
import { buildDaemonProjection, writeDaemonProjection } from '../utils/daemon-projection.mjs';
import { recordDaemonEvent, storeForSubject } from '../utils/daemon-events.mjs';
import {
  createWorkerState,
  defaultWorkerId,
  markWorkerStopped,
  parseHeartbeatMs,
  parseHeartbeatStaleMs,
  readWorkerState,
  requestWorkerStop,
  updateWorkerHeartbeat,
} from '../utils/daemon-worker-state.mjs';
import {
  classifyCycleFailure,
  runSingleCycle,
} from './evolve.mjs';

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function enqueueDaemonTask(root, subject, {
  type = 'run_cycle',
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

function buildDaemonDiagnostics(root, subject, projection) {
  const diagnostics = [];
  const locked = isSubjectLocked(root, subject);
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
      severity: 'warning',
      code: 'failed_tasks',
      message: `${projection.tasks.counts.failed} daemon task(s) have failed.`,
      action: 'Inspect failed tasks and retry only after the underlying error is understood.',
    });
  }
  if (locked) {
    diagnostics.push({
      severity: 'info',
      code: 'subject_evolve_lock_present',
      message: 'Subject evolve lock appears to be held.',
      action: 'This is expected while daemon or foreground evolve is running; avoid concurrent evolve for the same subject.',
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

function printTaskDetails(task) {
  const summary = taskSummary(task);
  for (const [key, value] of Object.entries(summary)) {
    console.log(`${key}: ${value ?? ''}`);
  }
  if (task.input) console.log(`input: ${JSON.stringify(task.input)}`);
  if (task.result) console.log(`result: ${JSON.stringify(task.result)}`);
}

function taskInputFromFlags(flags) {
  return {
    mock: Boolean(flags.mock),
    deepseek: Boolean(flags.deepseek),
    skip_goals_assess: Boolean(flags['skip-goals-assess']),
    exec_limit: flags['exec-limit'] == null || flags['exec-limit'] === true
      ? null
      : parsePositiveInt(flags['exec-limit'], { name: 'exec-limit', min: 1 }),
    retries: parsePositiveInt(flags.retries, { name: 'retries', defaultValue: 3, min: 0 }),
  };
}

function flagsFromTask(task, overrides = {}) {
  const input = task.input || {};
  return {
    mock: Boolean(input.mock || overrides.mock),
    deepseek: Boolean(input.deepseek || overrides.deepseek),
    'skip-goals-assess': Boolean(input.skip_goals_assess || overrides['skip-goals-assess']),
    'exec-limit': overrides['exec-limit'] ?? input.exec_limit ?? undefined,
  };
}

async function workRunCycle(root, subject, task, flags) {
  const workerId = task.lease_owner || flags.worker || `worker-${process.pid}`;
  const { leaseMs, heartbeatMs } = heartbeatDefaults(flags);
  const controller = flags.watchdog ? new AbortController() : null;
  let lastLeaseRenewEventAt = 0;
  let watchdog = null;
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
      recordDaemonEvent(root, subject, {
        type: 'task_lease_renew_failed',
        status: renewed.reason,
        task_id: task.task_id,
        task_type: task.type,
        lease_owner: workerId,
      });
      controller?.abort();
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
    if (stopping) controller?.abort();
  };
  if (flags.watchdog) {
    tick();
    watchdog = setInterval(tick, heartbeatMs);
  }
  const result = await runSingleCycle({
    root,
    subject,
    flags: flagsFromTask(task, flags),
    signal: controller?.signal,
    hooks: flags.watchdog ? {
      onOutput: () => tick(),
    } : {},
  });
  if (watchdog) clearInterval(watchdog);
  if (result.exitCode === 0) {
    const completed = completeTask(root, subject, task.task_id, { exit_code: 0 });
    recordDaemonEvent(root, subject, {
      type: 'task_completed',
      status: 'ok',
      task_id: task.task_id,
      task_type: task.type,
    });
    return { ok: true, task: completed.task };
  }
  const failure = classifyCycleFailure({ exitCode: result.exitCode, output: result.output });
  if (failure.code === 'daemon_stop_requested') {
    const released = releaseTaskForRetry(root, subject, task.task_id, failure);
    recordDaemonEvent(root, subject, {
      type: 'task_failed',
      status: 'stop_requested_retry_scheduled',
      task_id: task.task_id,
      task_type: task.type,
      retryable: true,
      error_code: failure.code,
      error_reason: failure.reason,
    });
    return { ok: false, retryable: true, stopped: true, task: released.task, failure };
  }
  const maxAttempts = Math.max(1, (task.input?.retries ?? 3) + 1);
  if (failure.retryable && task.attempts < maxAttempts) {
    const released = releaseTaskForRetry(root, subject, task.task_id, failure);
    recordDaemonEvent(root, subject, {
      type: 'task_failed',
      status: 'retry_scheduled',
      task_id: task.task_id,
      task_type: task.type,
      retryable: true,
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
    retryable: failure.retryable,
    error_code: failure.code,
    error_reason: failure.reason,
  });
  return { ok: false, retryable: false, task: failed.task, failure };
}

export async function workOnce(root, subject, flags = {}) {
  const workerId = flags.worker || `worker-${process.pid}`;
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const claim = claimNextTask(root, subject, {
    workerId,
    leaseMs,
    type: flags.type && flags.type !== true ? flags.type : null,
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
  if (claim.task.type !== 'run_cycle') {
    const failed = failTask(root, subject, claim.task.task_id, {
      code: 'unsupported_task_type',
      reason: claim.task.type,
      message: `Unsupported task type: ${claim.task.type}`,
    });
    return { worked: true, ok: false, task: failed.task };
  }
  const outcome = await workRunCycle(root, subject, claim.task, flags);
  return { worked: true, ...outcome };
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

export async function runDaemonWorker(root, subject, flags = {}) {
  const workerId = flags.worker && flags.worker !== true ? flags.worker : defaultWorkerId();
  const { leaseMs, heartbeatMs, heartbeatStaleMs } = heartbeatDefaults(flags);
  const intervalMs = parsePositiveInt(flags['interval-ms'], { name: 'interval-ms', defaultValue: 1000, min: 0 });
  const idleIntervalMs = parsePositiveInt(flags['idle-interval-ms'], { name: 'idle-interval-ms', defaultValue: 5000, min: 0 });
  const maxIterations = flags['max-iterations'] == null || flags['max-iterations'] === true
    ? null
    : parsePositiveInt(flags['max-iterations'], { name: 'max-iterations', min: 1 });
  const created = createWorkerState(root, subject, { workerId, staleMs: heartbeatStaleMs });
  if (!created.created) {
    return { started: false, reason: created.reason, state: created.state };
  }
  recordDaemonEvent(root, subject, {
    type: 'worker_started',
    status: 'ok',
    worker_id: workerId,
    pid: process.pid,
    heartbeat_ms: heartbeatMs,
    lease_ms: leaseMs,
  });

  let stopping = false;
  const requestLocalStop = () => {
    stopping = true;
    requestWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);
  let iterations = 0;
  let stopReason = 'stopped';
  try {
    for (;;) {
      const current = readWorkerState(root, subject);
      if (stopping || current?.stop_requested_at) {
        stopReason = current?.stop_requested_at ? 'stop_requested' : 'signal';
        break;
      }
      updateWorkerHeartbeat(root, subject, {
        worker_id: workerId,
        pid: process.pid,
        status: 'running',
      });
      await reclaimStaleLeasesForWorker(root, subject);
      const result = await workOnce(root, subject, {
        ...flags,
        worker: workerId,
        'lease-ms': leaseMs,
        'heartbeat-ms': heartbeatMs,
        watchdog: true,
      });
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
        stopReason = 'max_iterations';
        break;
      }
      const afterWork = readWorkerState(root, subject);
      if (stopping || afterWork?.stop_requested_at) {
        stopReason = afterWork?.stop_requested_at ? 'stop_requested' : 'signal';
        break;
      }
      await sleep(result.worked ? intervalMs : idleIntervalMs);
    }
  } finally {
    process.removeListener('SIGINT', requestLocalStop);
    process.removeListener('SIGTERM', requestLocalStop);
  }
  const stopped = markWorkerStopped(root, subject, {
    worker_id: workerId,
    pid: process.pid,
    stop_reason: stopReason,
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

function printProjection(projection) {
  console.log(`# Daemon Status: ${projection.subject}`);
  console.log(`health: ${projection.health.status} ok=${projection.health.ok}`);
  for (const reason of projection.health.reasons || []) console.log(`reason: ${reason}`);
  console.log(`worker: ${projection.worker.status} pid=${projection.worker.pid ?? 'none'} heartbeat=${projection.worker.heartbeat_at ?? 'none'}`);
  console.log(`tasks: ${projection.tasks.total}`);
  console.log(`counts: ${JSON.stringify(projection.tasks.counts)}`);
  if (projection.tasks.expired_running_count) {
    console.log(`expired running leases: ${projection.tasks.expired_running_count}`);
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

export async function daemonCommand({ subcommand, flags = {}, args = [], root = getProjectRoot() } = {}) {
  loadProjectEnv(root);
  const subjects = normalizeEvolveSubjects(root, {
    subject: flags.subject,
    subjects: flags.subjects,
  });
  const subject = subjects[0];

  if (subcommand === 'enqueue') {
    const type = flags.type && flags.type !== true ? flags.type : 'run_cycle';
    const result = enqueueDaemonTask(root, subject, {
      type,
      idempotencyKey: flags['idempotency-key'] && flags['idempotency-key'] !== true ? flags['idempotency-key'] : null,
      priority: flags.priority || 100,
      input: taskInputFromFlags(flags),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printTask(result.task, { created: result.created });
    return 0;
  }

  if (subcommand === 'work') {
    if (!flags.once) {
      console.error('Usage: jea daemon work --once [--subject NAME]');
      return 2;
    }
    const result = await workOnce(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.worked) console.log('No daemon task available.');
    else printTask(result.task);
    return result.worked && result.ok === false && result.retryable === false ? 1 : 0;
  }

  if (subcommand === 'start') {
    const result = await runDaemonWorker(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.started) console.log(`Daemon worker not started: ${result.reason}`);
    else console.log(`Daemon worker stopped: ${result.reason}`);
    return result.started ? 0 : 1;
  }

  if (subcommand === 'stop') {
    const heartbeatStaleMs = parseHeartbeatStaleMs(flags['heartbeat-stale-ms']);
    const result = requestWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
    recordDaemonEvent(root, subject, {
      type: 'worker_stop_requested',
      status: result.requested ? 'ok' : result.reason,
      worker_id: result.state?.worker_id,
      pid: result.state?.pid,
      reason: result.reason,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.requested ? 'Daemon worker stop requested.' : `Daemon worker not running: ${result.reason}`);
    return 0;
  }

  if (subcommand === 'events' || subcommand === 'logs') {
    const limit = parseLimit(flags.limit, 20);
    const events = readDaemonEvents(root, subject, { limit });
    if (flags.json) console.log(JSON.stringify({ subject, events }, null, 2));
    else printEvents(events);
    return 0;
  }

  if (subcommand === 'doctor') {
    const store = storeForSubject(root, subject);
    const projection = buildDaemonProjection(root, subject, {
      store,
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    writeDaemonProjection(root, subject, projection);
    const report = buildDaemonDiagnostics(root, subject, projection);
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else printDiagnostics(report);
    return report.health.ok ? 0 : 1;
  }

  if (subcommand === 'tasks') {
    const [taskCommand, taskId] = args;
    const queue = readTaskQueue(root, subject);
    if (!taskCommand || taskCommand === 'list') {
      const tasks = sortedTasks(queue.tasks || [])
        .filter((task) => !flags.status || task.status === flags.status)
        .map(taskSummary);
      if (flags.json) console.log(JSON.stringify({ subject, tasks }, null, 2));
      else printTaskList(tasks);
      return 0;
    }
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
    console.error('Usage: jea daemon tasks <list|inspect|retry|cancel> [task_id] [--status STATUS] [--json]');
    return 2;
  }

  if (subcommand === 'status' || !subcommand) {
    const store = storeForSubject(root, subject);
    const projection = buildDaemonProjection(root, subject, {
      store,
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    writeDaemonProjection(root, subject, projection);
    if (flags.json) console.log(JSON.stringify(projection, null, 2));
    else printProjection(projection);
    return 0;
  }

  {
    console.error('Usage: jea daemon <enqueue|work|start|stop|status|events|doctor|tasks> [--subject NAME] [--json]');
    console.error('       jea daemon enqueue --type run_cycle [--idempotency-key KEY]');
    console.error('       jea daemon work --once');
    console.error('       jea daemon start [--interval-ms N] [--idle-interval-ms N] [--heartbeat-ms N]');
    console.error('       jea daemon stop');
    console.error('       jea daemon events [--limit N]');
    console.error('       jea daemon doctor');
    console.error('       jea daemon tasks <list|inspect|retry|cancel>');
    return 2;
  }
}
