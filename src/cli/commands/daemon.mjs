import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import { isSubjectLocked, parsePositiveInt } from '../utils/evolve-runs.mjs';
import { hasMultiSubjectSelection, selectSubjects } from '../utils/subject-selection.mjs';
import { buildSubjectArtifactOverview } from '../utils/subject-artifacts.mjs';
import {
  acknowledgeTask,
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
import {
  checkSubjectLaneReady,
  printSubjectLaneGuardFailure,
} from '../utils/subject-lane-guard.mjs';

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

function buildProjection(root, subject, flags = {}) {
  const store = storeForSubject(root, subject);
  const projection = buildDaemonProjection(root, subject, {
    store,
    heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
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

function taskInputFromFlags(flags) {
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

function flagsFromTask(task, overrides = {}) {
  const input = task.input || {};
  return {
    mock: Boolean(input.mock || overrides.mock),
    deepseek: Boolean(input.deepseek || overrides.deepseek),
    'skip-goals-assess': Boolean(input.skip_goals_assess || overrides['skip-goals-assess']),
    'skip-belief-update': Boolean(input.skip_belief_update || overrides['skip-belief-update']),
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

  if (subcommand === 'enqueue') {
    if (multiSubject) {
      console.error('daemon enqueue supports one subject at a time. Use evolve --enqueue-only --subjects for batch task creation.');
      return 2;
    }
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
    if (multiSubject) {
      console.error('daemon work supports one subject at a time. Start one worker per subject for parallel evolution.');
      return 2;
    }
    if (!flags.once) {
      console.error('Usage: jea daemon work --once [--subject NAME]');
      return 2;
    }
    const laneGuard = checkSubjectLaneReady(root, { subject });
    if (!laneGuard.ok) {
      printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
      return 1;
    }
    const result = await workOnce(root, subject, flags);
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
    const laneGuard = checkSubjectLaneReady(root, { subject });
    if (!laneGuard.ok) {
      printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
      return 1;
    }
    const result = await runDaemonWorker(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.started) console.log(`Daemon worker not started: ${result.reason}`);
    else console.log(`Daemon worker stopped: ${result.reason}`);
    return result.started ? 0 : 1;
  }

  if (subcommand === 'stop') {
    const heartbeatStaleMs = parseHeartbeatStaleMs(flags['heartbeat-stale-ms']);
    const results = subjects.map((name) => {
      const result = requestWorkerStop(root, name, { staleMs: heartbeatStaleMs });
      recordDaemonEvent(root, name, {
        type: 'worker_stop_requested',
        status: result.requested ? 'ok' : result.reason,
        worker_id: result.state?.worker_id,
        pid: result.state?.pid,
        reason: result.reason,
      });
      return { subject: name, ...result };
    });
    if (flags.json) console.log(JSON.stringify(multiSubject ? { subjects: results } : results[0], null, 2));
    else {
      for (const result of results) {
        console.log(`${result.subject}: ${result.requested ? 'Daemon worker stop requested.' : `Daemon worker not running: ${result.reason}`}`);
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
    const items = subjects.map((name) => {
      const projection = buildProjection(root, name, flags);
      return buildSubjectArtifactOverview(root, name, { projection });
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
    console.error('Usage: jea daemon <enqueue|work|start|stop|status|events|doctor|tasks|inbox> [--subject NAME] [--subjects a,b | --all] [--json]');
    console.error('       jea daemon enqueue --type run_cycle [--idempotency-key KEY]');
    console.error('       jea daemon work --once');
    console.error('       jea daemon start [--interval-ms N] [--idle-interval-ms N] [--heartbeat-ms N]');
    console.error('       jea daemon stop');
    console.error('       jea daemon events [--limit N]');
    console.error('       jea daemon doctor');
    console.error('       jea daemon tasks <list|inspect|retry|cancel|acknowledge>');
    console.error('       jea daemon inbox [--all]');
    return 2;
  }
}
