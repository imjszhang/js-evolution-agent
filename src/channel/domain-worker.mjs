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
  reconcileChannelWorkerState,
  requestChannelWorkerStop,
  safeMarkChannelRoleWorkerStopped,
  safeUpdateChannelSupervisorState,
  safeUpdateChannelRoleWorkerHeartbeat,
} from './worker-state.mjs';
import { reclaimExpiredChannelLeases } from './task-queue.mjs';
import { readChannelReloadRequest, writeChannelReloadState } from './state.mjs';
import { runDomainWorkerLoop } from '../infra/worker-loop.mjs';
import { isProcessAlive } from '../infra/process-alive.mjs';
import { runUntilAbort, runWithTimeout } from './async-utils.mjs';
import { resolveFeishuConfig } from './adapters/feishu/config.mjs';
import { feishuListenerConfigFingerprint } from './adapters/feishu/listener.mjs';
import { sanitizeFeishuError } from './adapters/feishu/errors.mjs';
import {
  computeFeishuListenerBackoff,
  isFeishuListenerRetryableFailure,
  isFeishuListenerSuccess,
} from './adapters/feishu/backoff.mjs';
import { supervisorStateMirror } from '../product/supervisor-lease.mjs';

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
  now = Date.now,
  sleep = sleepWithSignal,
  random = Math.random,
  writeReloadState = writeChannelReloadState,
  readReloadRequest = readChannelReloadRequest,
} = {}) {
  if (flags['no-feishu-listener']) return { skipped: true, reason: 'listener_disabled_flag' };
  let attempt = 0;
  let lastFingerprint = null;
  let lastRetryEventKey = null;
  const persistRetry = (patch) => writeReloadState(root, subject, patch);
  try {
    while (!signal?.aborted) {
      const config = resolveFeishuConfig(root, subject);
      const fingerprint = feishuListenerConfigFingerprint(config);
      const reloadRequest = readReloadRequest(root, subject);
      if (fingerprint !== lastFingerprint || reloadRequest) {
        attempt = 0;
        lastFingerprint = fingerprint;
        lastRetryEventKey = null;
      }

      const canRetry = Boolean(config.listenerEnabled && !config.mock && config.appId && config.appSecret);
      if (!canRetry) {
        persistRetry({
          retry_attempt: 0,
          backoff_ms: null,
          next_retry_at: null,
        });
        await sleep(Math.max(refreshIntervalMs, 1000), signal);
        continue;
      }

      let result;
      try {
        // Connect deadline lives inside ensureListener. Supervisor only
        // cancels on shutdown so a hung ensure cannot block role workers.
        result = await runUntilAbort(
          (operationSignal) => ensureListener(root, subject, { ...flags, signal: operationSignal }),
          'feishu listener ensure',
          { signal },
        );
      } catch (err) {
        if (signal?.aborted || err?.code === 'channel_aborted') break;
        result = {
          action: 'start_failed',
          reason: sanitizeFeishuError(err, config),
          error_code: err?.code ?? 'feishu_listener_start_failed',
        };
      }

      if (isFeishuListenerSuccess(result)) {
        attempt = 0;
        lastRetryEventKey = null;
        persistRetry({
          retry_attempt: 0,
          backoff_ms: null,
          next_retry_at: null,
          last_error: null,
          last_error_code: null,
        });
        await sleep(Math.max(refreshIntervalMs, 1000), signal);
        continue;
      }

      if (!isFeishuListenerRetryableFailure(result)) {
        persistRetry({
          retry_attempt: 0,
          backoff_ms: null,
          next_retry_at: null,
        });
        await sleep(Math.max(refreshIntervalMs, 1000), signal);
        continue;
      }

      attempt += 1;
      const backoffMs = computeFeishuListenerBackoff({
        attempt,
        baseMs: config.retryBaseMs,
        multiplier: config.retryMultiplier,
        maxMs: config.retryMaxMs,
        jitter: config.retryJitter,
        random,
      });
      const nextRetryAt = new Date(now() + backoffMs).toISOString();
      const safeReason = sanitizeFeishuError(result.reason ?? result.error_code ?? 'feishu_listener_start_failed', config);
      persistRetry({
        retry_attempt: attempt,
        backoff_ms: backoffMs,
        next_retry_at: nextRetryAt,
        last_error: safeReason,
        last_error_code: result.error_code ?? null,
        last_error_at: new Date(now()).toISOString(),
      });
      const eventKey = `${fingerprint}:${result.error_code ?? result.reason}:${attempt}`;
      if (eventKey !== lastRetryEventKey) {
        lastRetryEventKey = eventKey;
        recordChannelEvent(root, subject, {
          type: 'feishu_listener_retry_scheduled',
          status: 'retry_scheduled',
          retry_attempt: attempt,
          backoff_ms: backoffMs,
          next_retry_at: nextRetryAt,
          error_code: result.error_code ?? null,
          reason: safeReason,
        });
      }
      await sleep(backoffMs, signal);
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
    if (shared.stopReason) stopReason = shared.stopReason;
    else if (isChannelRoleStopRequested(root, subject, role)) stopReason = 'stop_requested';
  } finally {
    safeMarkChannelRoleWorkerStopped(root, subject, role, {
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
  supervisorLease = null,
  ensureListener = ensureChannelListener,
  stopListener = stopChannelListener,
}) {
  const leaseRuntime = supervisorLease ?? {
    config: null,
    guard: { required: false, check: () => ({ stop: false, status: 'not_required' }) },
    observation: { stop: false, status: 'not_required', expires_at: null },
    checkIntervalMs: null,
  };
  let supervisorObservation = leaseRuntime.observation;
  const supervisor = supervisorStateMirror(leaseRuntime.config, supervisorObservation);
  const classifierConfig = resolveClassifierConfig(root, subject);
  reconcileChannelWorkerState(root, subject, { staleMs: heartbeatStaleMs });
  initChannelCoordinatorState(root, subject, {
    pid: process.pid,
    tickMs,
    classifierIntervalMs: classifierConfig.interval_ms,
    roles,
    staleMs: heartbeatStaleMs,
    supervisor,
  });
  for (const role of roles) {
    createChannelRoleWorkerState(root, subject, {
      role,
      workerId: roleWorkerId(role),
      pid: process.pid,
      staleMs: heartbeatStaleMs,
      tickMs,
      allowedTaskTypes: resolveChannelWorkerTaskTypes(flags, role) ?? taskTypesForChannelRole(role),
      supervisor,
    });
  }
  if (supervisorObservation.stop) {
    for (const role of roles) {
      safeMarkChannelRoleWorkerStopped(root, subject, role, {
        worker_id: roleWorkerId(role),
        pid: process.pid,
        stop_reason: supervisorObservation.reason,
        supervisor,
      });
    }
    recordChannelEvent(root, subject, {
      type: 'channel_worker_start_failed',
      status: supervisorObservation.reason,
      pid: process.pid,
      reason: supervisorObservation.reason,
    });
    return {
      started: false,
      reason: supervisorObservation.reason,
      roles: [],
      state: readChannelWorkerState(root, subject),
    };
  }

  const shared = {
    stopping: false,
    stopReason: null,
    tickMs,
    heartbeatStaleMs,
  };
  const stopController = new AbortController();
  shared.signal = stopController.signal;

  const requestLocalStop = (reason = 'signal') => {
    if (shared.stopping) return;
    shared.stopping = true;
    shared.stopReason = reason;
    if (!stopController.signal.aborted) stopController.abort(new Error('channel domain stopping'));
    requestChannelWorkerStop(root, subject, { staleMs: heartbeatStaleMs });
  };
  process.once('SIGINT', requestLocalStop);
  process.once('SIGTERM', requestLocalStop);

  let fatalHandled = false;
  const handleFatal = (label, err) => {
    if (fatalHandled) return;
    fatalHandled = true;
    shared.stopping = true;
    if (!stopController.signal.aborted) {
      stopController.abort(err instanceof Error ? err : new Error(String(err)));
    }
    try {
      recordChannelEvent(root, subject, {
        type: 'channel_worker_crashed',
        status: 'error',
        reason: label,
        error: err?.message || String(err),
        error_code: err?.code ?? null,
        pid: process.pid,
      });
      const state = readChannelWorkerState(root, subject);
      for (const role of Object.keys(state?.workers ?? {})) {
        const worker = state.workers[role];
        if (worker?.pid === process.pid || !worker?.pid) {
          safeMarkChannelRoleWorkerStopped(root, subject, role, {
            worker_id: worker?.worker_id,
            pid: process.pid,
            stop_reason: 'crashed',
          });
        }
      }
      reconcileChannelWorkerState(root, subject, { staleMs: heartbeatStaleMs });
    } catch {
      // best effort
    }
  };
  const onUncaughtException = (err) => handleFatal('uncaughtException', err);
  const onUnhandledRejection = (reason) => {
    handleFatal('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  };
  process.once('uncaughtException', onUncaughtException);
  process.once('unhandledRejection', onUnhandledRejection);

  let presenceTickTimer = null;
  let classifierTickTimer = null;
  let stopPollTimer = null;
  let supervisorTimer = null;
  let supervisorFingerprint = JSON.stringify(supervisor);
  const checkSupervisorLease = () => {
    if (!leaseRuntime.guard.required || shared.stopping) return supervisorObservation;
    supervisorObservation = leaseRuntime.guard.check();
    const nextSupervisor = supervisorStateMirror(leaseRuntime.config, supervisorObservation);
    const nextFingerprint = JSON.stringify(nextSupervisor);
    if (nextFingerprint !== supervisorFingerprint) {
      supervisorFingerprint = nextFingerprint;
      safeUpdateChannelSupervisorState(root, subject, nextSupervisor);
    }
    if (supervisorObservation.stop) {
      recordChannelEvent(root, subject, {
        type: 'channel_supervisor_lease_lost',
        status: 'stopping',
        pid: process.pid,
        reason: supervisorObservation.reason,
      });
      requestLocalStop(supervisorObservation.reason);
    }
    return supervisorObservation;
  };
  if (leaseRuntime.checkIntervalMs) {
    supervisorTimer = setInterval(checkSupervisorLease, leaseRuntime.checkIntervalMs);
    supervisorTimer.unref?.();
  }

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
    checkSupervisorLease();
    if (readChannelWorkerState(root, subject)?.stop_requested_at) requestLocalStop('stop_requested');
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
    if (supervisorTimer) clearInterval(supervisorTimer);
    await listenerSupervisor;
    const leftover = readChannelWorkerState(root, subject);
    for (const [role, worker] of Object.entries(leftover?.workers ?? {})) {
      if (!['running', 'stopping'].includes(worker.status)) continue;
      if (worker.pid === process.pid || !isProcessAlive(worker.pid)) {
        safeMarkChannelRoleWorkerStopped(root, subject, role, {
          worker_id: worker.worker_id,
          pid: worker.pid,
          stop_reason: shared.stopReason ?? 'shutdown_fallback',
        });
      }
    }
    reconcileChannelWorkerState(root, subject, { staleMs: heartbeatStaleMs });
    process.removeListener('SIGINT', requestLocalStop);
    process.removeListener('SIGTERM', requestLocalStop);
    process.removeListener('uncaughtException', onUncaughtException);
    process.removeListener('unhandledRejection', onUnhandledRejection);
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
