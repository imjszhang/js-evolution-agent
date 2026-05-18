import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import { normalizeEvolveSubjects, parsePositiveInt } from '../utils/evolve-runs.mjs';
import {
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  parseLeaseMs,
  reclaimExpiredLeases,
  renewTaskLease,
  releaseTaskForRetry,
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
}

export async function daemonCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();
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
    console.error('Usage: jea daemon <enqueue|work|start|stop|status> [--subject NAME] [--json]');
    console.error('       jea daemon enqueue --type run_cycle [--idempotency-key KEY]');
    console.error('       jea daemon work --once');
    console.error('       jea daemon start [--interval-ms N] [--idle-interval-ms N] [--heartbeat-ms N]');
    console.error('       jea daemon stop');
    return 2;
  }
}
