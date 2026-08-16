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
import { runDomainWorkerLoop } from '../infra/worker-loop.mjs';
import { runWithTimeout } from './async-utils.mjs';
import { resolveFeishuConfig } from './adapters/feishu/config.mjs';

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms, signal) {
  if (!ms || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function runChannelListenerSupervisor(root, subject, flags = {}, {
  signal = null,
  refreshIntervalMs = 1000,
  ensureListener = ensureChannelListener,
  stopListener = stopChannelListener,
} = {}) {
  if (flags['no-feishu-listener']) return { skipped: true, reason: 'listener_disabled_flag' };
  try {
    while (!signal?.aborted) {
      try {
        const config = resolveFeishuConfig(root, subject);
        const result = await runWithTimeout(
          (operationSignal) => ensureListener(root, subject, { ...flags, signal: operationSignal }),
          config.connectTimeoutMs,
          'feishu listener ensure',
          { signal },
        );
        if (result.action === 'start_failed' || result.action === 'reload_failed') {
          recordChannelEvent(root, subject, {
            type: 'feishu_listener_start_skipped',
            status: 'not_running',
            reason: result.reason ?? result.action,
            error_code: result.error_code ?? null,
          });
        }
      } catch (err) {
        if (!signal?.aborted) {
          recordChannelEvent(root, subject, {
            type: 'channel_config_reload_failed',
            status: 'error',
            error: err?.message || String(err),
            error_code: err?.code ?? null,
          });
        }
      }
      await sleepWithSignal(Math.max(refreshIntervalMs, 1000), signal);
    }
  } finally {
    if (getChannelListenerStatus(root, subject).running) {
      const config = resolveFeishuConfig(root, subject);
      try {
        await runWithTimeout(
          () => stopListener(root, subject, { stopTimeoutMs: config.stopTimeoutMs }),
          config.stopTimeoutMs,
          'feishu listener supervisor stop',
        );
      } catch (err) {
        recordChannelEvent(root, subject, {
          type: 'feishu_listener_stop_failed',
          status: 'error',
          error: err?.message || String(err),
          error_code: err?.code ?? null,
        });
      }
    }
  }
  return { stopped: true };
}

async function awaitWorkersWithShutdownGrace(root, subject, workerPromise, signal) {
  const { shutdownGraceMs } = resolveFeishuConfig(root, subject);
  let removeAbort = null;
  const shutdown = new Promise((resolve) => {
    const onAbort = () => {
      runWithTimeout(
        () => workerPromise,
        shutdownGraceMs,
        'channel worker shutdown',
      ).then(resolve, (error) => {
        recordChannelEvent(root, subject, {
          type: 'channel_shutdown_grace_exceeded',
          status: 'error',
          error_code: error?.code ?? null,
          grace_ms: shutdownGraceMs,
        });
        resolve([]);
      });
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    }
  });
  try {
    return await Promise.race([workerPromise, shutdown]);
  } finally {
    removeAbort?.();
  }
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
    await runDomainWorkerLoop({
      shouldStop: () => {
        if (shared.stopping) return true;
        if (maxIterations && iterations >= maxIterations) return true;
        return isChannelRoleStopRequested(root, subject, role);
      },
      heartbeat: () => {
        safeUpdateChannelRoleWorkerHeartbeat(root, subject, role, {
          worker_id: workerId,
          pid: process.pid,
          status: 'running',
        });
      },
      claim: async () => {
        if (shared.stopping || isChannelRoleStopRequested(root, subject, role)) return null;
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
        return channelWorkOnce(root, subject, {
          ...flags,
          worker: workerId,
          role,
          types,
          'lease-ms': leaseMs,
          signal: shared.signal,
        });
      },
      execute: async (result) => {
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
          shared.stopping = true;
          stopReason = 'max_iterations';
        }
      },
      afterExecute: async (result) => (result?.worked ? workIntervalMs : idleIntervalMs),
      idleMs: idleIntervalMs,
      signal: shared.signal,
    });
    if (isChannelRoleStopRequested(root, subject, role)) stopReason = 'stop_requested';
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
  ensureListener = ensureChannelListener,
  stopListener = stopChannelListener,
}) {
  const classifierConfig = resolveClassifierConfig(root, subject);
  initChannelCoordinatorState(root, subject, {
    pid: process.pid,
    tickMs,
    classifierIntervalMs: classifierConfig.interval_ms,
    roles,
    staleMs: heartbeatStaleMs,
  });
  for (const role of roles) {
    createChannelRoleWorkerState(root, subject, {
      role,
      workerId: roleWorkerId(role),
      pid: process.pid,
      staleMs: heartbeatStaleMs,
      tickMs,
      allowedTaskTypes: resolveChannelWorkerTaskTypes(flags, role) ?? taskTypesForChannelRole(role),
    });
  }

  const shared = {
    stopping: false,
    tickMs,
    heartbeatStaleMs,
  };
  const stopController = new AbortController();
  shared.signal = stopController.signal;

  const requestLocalStop = () => {
    if (shared.stopping) return;
    shared.stopping = true;
    if (!stopController.signal.aborted) stopController.abort(new Error('channel domain stopping'));
    requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);

  let presenceTickTimer = null;
  let classifierTickTimer = null;
  let stopPollTimer = null;

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
  stopPollTimer = setInterval(() => {
    if (readChannelWorkerState(root, subject)?.stop_requested_at) requestLocalStop();
  }, 250);
  stopPollTimer.unref?.();

  let workerResults = [];
  const listenerSupervisor = runChannelListenerSupervisor(root, subject, flags, {
    signal: stopController.signal,
    refreshIntervalMs: Math.max(workIntervalMs, 1000),
    ensureListener,
    stopListener,
  });
  try {
    try {
      const workerPromise = Promise.all(roles.map((role) => runChannelRoleWorkerLoop(root, subject, role, flags, shared, {
        leaseMs,
        workIntervalMs,
        idleIntervalMs,
        maxIterations,
        channelWorkOnce,
      })));
      workerResults = await awaitWorkersWithShutdownGrace(root, subject, workerPromise, stopController.signal);
    } catch (err) {
      shared.stopping = true;
      if (!stopController.signal.aborted) stopController.abort(err);
      requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
      throw err;
    }
  } finally {
    shared.stopping = true;
    if (!stopController.signal.aborted) stopController.abort(new Error('channel domain stopped'));
    if (presenceTickTimer) clearInterval(presenceTickTimer);
    if (classifierTickTimer) clearInterval(classifierTickTimer);
    if (stopPollTimer) clearInterval(stopPollTimer);
    await listenerSupervisor;
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
