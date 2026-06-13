import { runChannelPresenceTick, runChannelClassifierTick } from './dispatch.mjs';
import { resolveClassifierConfig } from './classifier-config.mjs';
import { resolveChannelRoles, resolveChannelWorkerTaskTypes, taskTypesForChannelRole } from './channel-roles.mjs';
import { recordChannelEvent } from './audit.mjs';
import {
  ensureChannelListener,
  getChannelListenerStatus,
  stopChannelListener,
} from './listener.mjs';
import {
  createChannelRoleWorkerState,
  initChannelCoordinatorState,
  isChannelRoleStopRequested,
  markChannelRoleWorkerStopped,
  readChannelWorkerState,
  requestChannelWorkerStop,
  safeUpdateChannelRoleWorkerHeartbeat,
} from './worker-state.mjs';
import { reclaimExpiredChannelLeases } from './task-queue.mjs';

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function roleWorkerId(role, pid = process.pid) {
  return `channel-worker-${role}-${pid}`;
}

export async function runChannelRoleWorkerLoop(root, subject, role, flags, shared, {
  leaseMs,
  workIntervalMs,
  idleIntervalMs,
  maxIterations = null,
  channelWorkOnce,
} = {}) {
  const workerId = flags.worker && flags.worker !== true
    ? String(flags.worker)
    : roleWorkerId(role);
  const types = flags.types ?? resolveChannelWorkerTaskTypes(flags, role) ?? taskTypesForChannelRole(role);
  const created = createChannelRoleWorkerState(root, subject, {
    role,
    workerId,
    pid: process.pid,
    staleMs: shared.heartbeatStaleMs,
    tickMs: shared.tickMs,
    allowedTaskTypes: types,
  });
  if (!created.created && !flags.force) {
    return { role, started: false, reason: created.reason, iterations: 0 };
  }

  recordChannelEvent(root, subject, {
    type: 'channel_worker_started',
    status: 'ok',
    role,
    worker_id: workerId,
    pid: process.pid,
    allowed_task_types: types,
  });

  let iterations = 0;
  let stopReason = 'stopped';

  try {
    for (;;) {
      if (shared.stopping || isChannelRoleStopRequested(root, subject, role)) {
        stopReason = 'stop_requested';
        break;
      }
      safeUpdateChannelRoleWorkerHeartbeat(root, subject, role, {
        worker_id: workerId,
        pid: process.pid,
        status: 'running',
      });
      const { reclaimed } = reclaimExpiredChannelLeases(root, subject);
      for (const task of reclaimed) {
        recordChannelEvent(root, subject, {
          type: 'channel_stale_lease_reclaimed',
          status: 'ok',
          role,
          task_id: task.task_id,
          task_type: task.type,
          lease_owner: task.previous?.lease_owner,
        });
      }
      const result = await channelWorkOnce(root, subject, {
        ...flags,
        worker: workerId,
        role,
        types,
        'lease-ms': leaseMs,
      });
      iterations += 1;
      const summary = workResultSummary(result);
      safeUpdateChannelRoleWorkerHeartbeat(root, subject, role, {
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
      await sleep(result.worked ? workIntervalMs : idleIntervalMs);
    }
  } finally {
    markChannelRoleWorkerStopped(root, subject, role, {
      worker_id: workerId,
      pid: process.pid,
      stop_reason: stopReason,
    });
    recordChannelEvent(root, subject, {
      type: 'channel_worker_stopped',
      status: 'ok',
      role,
      worker_id: workerId,
      pid: process.pid,
      reason: stopReason,
    });
  }

  return { role, started: true, reason: stopReason, iterations };
}

export async function runChannelDomainWorkerMulti(root, subject, flags, {
  roles,
  tickMs,
  leaseMs,
  heartbeatStaleMs,
  workIntervalMs,
  idleIntervalMs,
  maxIterations,
  channelWorkOnce,
}) {
  const classifierConfig = resolveClassifierConfig(root, subject);
  initChannelCoordinatorState(root, subject, {
    pid: process.pid,
    tickMs,
    classifierIntervalMs: classifierConfig.interval_ms,
    roles,
    staleMs: heartbeatStaleMs,
  });

  const shared = {
    stopping: false,
    tickMs,
    heartbeatStaleMs,
  };

  const requestLocalStop = () => {
    shared.stopping = true;
    requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);

  let presenceTickTimer = null;
  let classifierTickTimer = null;

  const runPresenceSchedule = () => {
    if (shared.stopping) return;
    try {
      runChannelPresenceTick(root, subject, { tick_ms: tickMs });
    } catch (err) {
      recordChannelEvent(root, subject, {
        type: 'channel_tick_failed',
        status: 'error',
        phase: 'presence',
        error: err?.message || String(err),
      });
    }
  };

  const runClassifierSchedule = () => {
    if (shared.stopping) return;
    try {
      runChannelClassifierTick(root, subject);
    } catch (err) {
      recordChannelEvent(root, subject, {
        type: 'channel_classifier_tick_failed',
        status: 'error',
        error: err?.message || String(err),
      });
    }
  };

  runPresenceSchedule();
  presenceTickTimer = setInterval(runPresenceSchedule, tickMs);

  if (roles.includes('classifier') && classifierConfig.enabled) {
    runClassifierSchedule();
    classifierTickTimer = setInterval(runClassifierSchedule, classifierConfig.interval_ms);
  }

  if (!flags['no-feishu-listener']) {
    const initialEnsure = await ensureChannelListener(root, subject, flags);
    if (initialEnsure.action === 'start_failed' || initialEnsure.action === 'reload_failed') {
      recordChannelEvent(root, subject, {
        type: 'feishu_listener_start_skipped',
        status: 'not_running',
        reason: initialEnsure.reason ?? initialEnsure.action,
      });
    }
  }

  let workerResults = [];
  let listenerRefresh = null;
  try {
    listenerRefresh = !flags['no-feishu-listener']
      ? setInterval(async () => {
        if (shared.stopping) return;
        try {
          await ensureChannelListener(root, subject, flags);
        } catch (err) {
          recordChannelEvent(root, subject, {
            type: 'channel_config_reload_failed',
            status: 'error',
            error: err?.message || String(err),
          });
        }
      }, Math.max(workIntervalMs, 1000))
      : null;

    try {
      workerResults = await Promise.all(roles.map((role) => runChannelRoleWorkerLoop(root, subject, role, flags, shared, {
        leaseMs,
        workIntervalMs,
        idleIntervalMs,
        maxIterations,
        channelWorkOnce,
      })));
    } catch (err) {
      shared.stopping = true;
      requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
      throw err;
    }
  } finally {
    shared.stopping = true;
    if (listenerRefresh) clearInterval(listenerRefresh);
    if (presenceTickTimer) clearInterval(presenceTickTimer);
    if (classifierTickTimer) clearInterval(classifierTickTimer);
    if (getChannelListenerStatus(root, subject).running) {
      await stopChannelListener(root, subject);
    }
    process.removeListener('SIGINT', requestLocalStop);
    process.removeListener('SIGTERM', requestLocalStop);
  }

  return {
    started: workerResults.some((r) => r.started),
    reason: workerResults.map((r) => `${r.role}:${r.reason}`).join(','),
    roles: workerResults,
    state: readChannelWorkerState(root, subject),
  };
}

export function resolveChannelDomainRoles(flags = {}) {
  return resolveChannelRoles(flags);
}

export { sleep, workResultSummary };
