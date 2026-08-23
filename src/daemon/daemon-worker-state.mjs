import { join } from 'node:path';
import { writeJson } from '../infra/json-store.mjs';
import { nowIso, parsePositiveInt, runtimeForSubject } from '../infra/runtime-paths.mjs';
import {
  isWorkerFresh,
  readWorkerState,
  workerStatePath,
} from '../infra/worker-state-read.mjs';
import { isProcessAlive } from '../infra/process-alive.mjs';

export { isWorkerFresh, readWorkerState, workerStatePath };

export function daemonStateDir(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'daemon');
}

export function defaultWorkerId() {
  return `worker-${process.pid}`;
}

export function parseHeartbeatStaleMs(value, defaultValue = 60_000) {
  return parsePositiveInt(value, { name: 'heartbeat-stale-ms', defaultValue, min: 1 });
}

export function parseHeartbeatMs(value, defaultValue = 30_000) {
  return parsePositiveInt(value, { name: 'heartbeat-ms', defaultValue, min: 1 });
}

export function writeWorkerState(root, subject, state) {
  const filePath = workerStatePath(root, subject);
  writeJson(filePath, state);
  return state;
}

export function isWorkerZombie(state, { nowMs: _nowMs = Date.now(), staleMs: _staleMs = 60_000 } = {}) {
  if (!state || !['running', 'stopping'].includes(state.status)) return false;
  return !isProcessAlive(state.pid);
}

export function inspectWorkerRepair(state) {
  if (!state || !['running', 'stopping'].includes(state.status)) {
    return {
      needed: false,
      blocked: false,
      reason: state ? 'already_stopped' : 'not_found',
    };
  }
  if (isProcessAlive(state.pid)) {
    return { needed: false, blocked: true, reason: 'pid_alive' };
  }
  return { needed: true, blocked: false, reason: 'pid_dead' };
}

export function reconcileWorkerState(root, subject, { staleMs = 60_000 } = {}) {
  const previous = readWorkerState(root, subject);
  const inspection = inspectWorkerRepair(previous);
  if (inspection.blocked || !inspection.needed) {
    return {
      changed: false,
      repaired: false,
      ...inspection,
      state: previous,
    };
  }
  const state = markWorkerStopped(root, subject, {
    worker_id: previous.worker_id,
    pid: previous.pid,
    stale_after_ms: previous.stale_after_ms ?? staleMs,
    stop_reason: 'reconcile_pid_dead',
  });
  return {
    changed: true,
    repaired: true,
    needed: true,
    blocked: false,
    reason: 'pid_dead',
    state,
  };
}

export function createWorkerState(root, subject, {
  workerId = defaultWorkerId(),
  pid = process.pid,
  staleMs = 60_000,
  tickMs = null,
  evolutionMode = null,
  evolutionModeSource = null,
  supervisor = null,
} = {}) {
  const existing = readWorkerState(root, subject);
  if (existing && isWorkerZombie(existing, { staleMs })) {
    markWorkerStopped(root, subject, {
      worker_id: existing.worker_id,
      pid: existing.pid,
      stop_reason: 'zombie_pid_dead',
    });
  } else if (existing && isWorkerFresh(existing, { staleMs }) && isProcessAlive(existing.pid)) {
    return { created: false, reason: 'already_running', state: existing };
  }
  const now = nowIso();
  const state = {
    subject,
    worker_id: workerId,
    pid,
    status: 'running',
    started_at: now,
    heartbeat_at: now,
    stop_requested_at: null,
    stopped_at: null,
    stale_after_ms: staleMs,
    tick_ms: tickMs,
    evolution_mode: evolutionMode,
    evolution_mode_source: evolutionModeSource,
    supervisor,
    last_work_result: null,
    last_error: null,
  };
  writeWorkerState(root, subject, state);
  return { created: true, state };
}

export function updateWorkerHeartbeat(root, subject, patch = {}) {
  const previous = readWorkerState(root, subject) || {};
  const state = {
    ...previous,
    ...patch,
    subject,
    status: patch.status || previous.status || 'running',
    heartbeat_at: nowIso(),
  };
  writeWorkerState(root, subject, state);
  return state;
}

export function requestWorkerStop(root, subject, { staleMs = 60_000 } = {}) {
  const previous = readWorkerState(root, subject);
  const now = nowIso();
  if (!previous) {
    const state = {
      subject,
      worker_id: null,
      pid: null,
      status: 'stopped',
      started_at: null,
      heartbeat_at: null,
      stop_requested_at: now,
      stopped_at: now,
      stale_after_ms: staleMs,
      last_work_result: null,
      last_error: null,
    };
    writeWorkerState(root, subject, state);
    return { requested: false, reason: 'not_running', state };
  }
  const effectiveStaleMs = previous.stale_after_ms ?? staleMs;
  const fresh = isWorkerFresh(previous, { staleMs: effectiveStaleMs });
  const state = {
    ...previous,
    status: fresh ? 'stopping' : 'stopped',
    stop_requested_at: previous.stop_requested_at || now,
    stopped_at: fresh ? previous.stopped_at ?? null : now,
    stale_after_ms: effectiveStaleMs,
  };
  writeWorkerState(root, subject, state);
  return {
    requested: fresh,
    reason: fresh ? 'stop_requested' : 'stale_worker_marked_stopped',
    state,
  };
}

export function markWorkerStopped(root, subject, patch = {}) {
  const previous = readWorkerState(root, subject) || {};
  const state = {
    ...previous,
    ...patch,
    subject,
    status: 'stopped',
    stopped_at: nowIso(),
  };
  writeWorkerState(root, subject, state);
  return state;
}

export function summarizeWorkerState(state, { nowMs = Date.now(), staleMs = 60_000 } = {}) {
  if (!state) {
    return {
      status: 'stopped',
      running: false,
      fresh: false,
      stale: false,
      zombie: false,
      pid_alive: false,
      pid: null,
      worker_id: null,
      heartbeat_at: null,
      stop_requested_at: null,
      tick_ms: null,
      supervisor: null,
      supervisor_required: false,
      supervisor_lease_status: null,
      supervisor_lease_expires_at: null,
      stop_reason: null,
      last_work_result: null,
      last_error: null,
    };
  }
  const effectiveStaleMs = state.stale_after_ms ?? staleMs;
  const fresh = isWorkerFresh(state, { nowMs, staleMs: effectiveStaleMs });
  const pid_alive = isProcessAlive(state.pid);
  const active = ['running', 'stopping'].includes(state.status);
  const stale = active && !fresh && pid_alive;
  const zombie = active && !pid_alive;
  const aliveAndFresh = fresh && pid_alive;
  return {
    status: zombie ? 'zombie' : (stale ? 'stale' : state.status),
    running: ['running', 'stopping'].includes(state.status) && aliveAndFresh,
    fresh,
    stale,
    zombie,
    pid_alive,
    pid: state.pid ?? null,
    worker_id: state.worker_id ?? null,
    started_at: state.started_at ?? null,
    heartbeat_at: state.heartbeat_at ?? null,
    stop_requested_at: state.stop_requested_at ?? null,
    stopped_at: state.stopped_at ?? null,
    stale_after_ms: effectiveStaleMs,
    tick_ms: state.tick_ms ?? null,
    supervisor: state.supervisor ?? null,
    supervisor_required: state.supervisor?.required === true,
    supervisor_lease_status: state.supervisor?.lease_status ?? null,
    supervisor_lease_expires_at: state.supervisor?.lease_expires_at ?? null,
    stop_reason: state.stop_reason ?? null,
    last_work_result: state.last_work_result ?? null,
    last_error: state.last_error ?? null,
  };
}
