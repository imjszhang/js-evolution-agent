import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { readJsonSafe } from '../infra/files.mjs';
import { writeJsonAtomic } from '../infra/atomic-json-write.mjs';
import { recordChannelEvent } from './audit.mjs';
import {
  defaultWorkerId,
  isWorkerFresh,
  isWorkerZombie,
  parseHeartbeatMs,
  parseHeartbeatStaleMs,
  summarizeWorkerState,
} from '../daemon/daemon-worker-state.mjs';
import { isProcessAlive } from '../infra/process-alive.mjs';
import { taskTypesForChannelRole } from './channel-roles.mjs';
import { channelWorkerStatePath } from './paths.mjs';
import { nowIso } from './types.mjs';

export { defaultWorkerId, parseHeartbeatMs, parseHeartbeatStaleMs, summarizeWorkerState };

function channelWorkerStateLockPath(root, subject) {
  return `${channelWorkerStatePath(root, subject)}.lock`;
}

function withChannelWorkerStateLock(root, subject, fn) {
  const lockPath = channelWorkerStateLockPath(root, subject);
  mkdirSync(dirname(lockPath), { recursive: true });
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '', 'utf-8');
  }
  let release = null;
  let lastError = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      release = lockfile.lockSync(lockPath);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 14) {
        const end = Date.now() + Math.min(50 * (attempt + 1), 500);
        while (Date.now() < end) { /* sync backoff */ }
      }
    }
  }
  if (lastError) {
    throw new Error(`Channel worker state is locked for ${subject}: ${lastError?.message || lastError}`);
  }
  try {
    return fn();
  } finally {
    if (release) release();
  }
}

function safeRoleTaskTypes(role, worker) {
  if (worker?.allowed_task_types !== undefined) return worker.allowed_task_types;
  try {
    return taskTypesForChannelRole(role);
  } catch {
    return null;
  }
}

function emptyAggregateState(subject) {
  return {
    subject,
    domain: 'channel',
    schema_version: 2,
    workers: {},
    coordinator: null,
    worker_id: null,
    pid: null,
    status: 'stopped',
    started_at: null,
    heartbeat_at: null,
    stop_requested_at: null,
    stopped_at: null,
    stale_after_ms: 60_000,
    tick_ms: null,
    last_work_result: null,
    last_error: null,
  };
}

function migrateLegacyState(raw) {
  if (!raw || typeof raw !== 'object') return emptyAggregateState(null);
  if (raw.workers && typeof raw.workers === 'object') return raw;
  const legacyRole = raw.role ?? 'legacy';
  const workers = {};
  if (raw.worker_id || raw.status) {
    workers[legacyRole] = {
      role: legacyRole,
      worker_id: raw.worker_id,
      pid: raw.pid,
      status: raw.status,
      started_at: raw.started_at,
      heartbeat_at: raw.heartbeat_at,
      stop_requested_at: raw.stop_requested_at,
      stopped_at: raw.stopped_at,
      allowed_task_types: raw.allowed_task_types ?? null,
      last_work_result: raw.last_work_result ?? null,
      last_error: raw.last_error ?? null,
    };
  }
  return {
    ...emptyAggregateState(raw.subject),
    ...raw,
    schema_version: 2,
    workers,
  };
}

export function readChannelWorkerState(root, subject) {
  const filePath = channelWorkerStatePath(root, subject);
  if (!existsSync(filePath)) return null;
  const state = readJsonSafe(filePath, null);
  return state && typeof state === 'object' ? migrateLegacyState(state) : null;
}

export function writeChannelWorkerState(root, subject, state) {
  writeJsonAtomic(channelWorkerStatePath(root, subject), state);
  return state;
}

export function summarizeChannelWorkersState(raw, { staleMs = 60_000 } = {}) {
  const state = migrateLegacyState(raw);
  const roles = Object.entries(state.workers ?? {}).map(([role, worker]) => {
    const summary = summarizeWorkerState(worker, { staleMs: worker.stale_after_ms ?? staleMs });
    return {
      role,
      ...summary,
      allowed_task_types: safeRoleTaskTypes(role, worker),
    };
  });
  const running = roles.filter((r) => r.running);
  const fresh = roles.filter((r) => r.fresh);
  const zombies = roles.filter((r) => r.zombie);
  const stale = roles.filter((r) => r.stale);
  return {
    schema_version: 2,
    coordinator: state.coordinator,
    roles,
    running_count: running.length,
    fresh_count: fresh.length,
    zombie_count: zombies.length,
    stale_count: stale.length,
    ok: zombies.length === 0 && stale.length === 0,
    status: running.length ? (zombies.length ? 'worker_zombie' : (stale.length ? 'stale' : 'healthy')) : 'idle',
  };
}

export function initChannelCoordinatorState(root, subject, {
  pid = process.pid,
  tickMs = null,
  classifierIntervalMs = null,
  roles = [],
  staleMs = 60_000,
} = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const previous = readChannelWorkerState(root, subject) || emptyAggregateState(subject);
    const state = {
      ...previous,
      subject,
      domain: 'channel',
      schema_version: 2,
      stale_after_ms: staleMs,
      tick_ms: tickMs,
      coordinator: {
        pid,
        started_at: nowIso(),
        roles,
        tick_ms: tickMs,
        classifier_interval_ms: classifierIntervalMs,
      },
      status: 'running',
      heartbeat_at: nowIso(),
      stop_requested_at: null,
      stopped_at: null,
      pid,
      worker_id: `channel-coordinator-${pid}`,
    };
    delete state.stop_reason;
    for (const role of roles) {
      if (state.workers?.[role]) {
        state.workers[role] = {
          ...state.workers[role],
          stop_requested_at: null,
          stopped_at: null,
        };
      }
    }
    writeChannelWorkerState(root, subject, state);
    return state;
  });
}

export function createChannelRoleWorkerState(root, subject, {
  role,
  workerId = defaultWorkerId(),
  pid = process.pid,
  staleMs = 60_000,
  tickMs = null,
  allowedTaskTypes = null,
} = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const state = readChannelWorkerState(root, subject) || emptyAggregateState(subject);
    const existing = state.workers?.[role];
    if (existing && isWorkerZombie(existing, { staleMs })) {
      state.workers[role] = {
        ...existing,
        status: 'stopped',
        stopped_at: nowIso(),
        stop_reason: 'zombie_pid_dead',
      };
    } else if (
      ['running', 'stopping'].includes(existing?.status)
      && isWorkerFresh(existing, { staleMs })
      && isProcessAlive(existing.pid)
    ) {
      if (existing.pid !== pid) {
        return { created: false, reason: 'already_running', role, state: existing };
      }
      const reusedAt = nowIso();
      state.workers[role] = {
        ...existing,
        worker_id: workerId,
        pid,
        status: 'running',
        heartbeat_at: reusedAt,
        stop_requested_at: null,
        stopped_at: null,
        stale_after_ms: staleMs,
        tick_ms: tickMs ?? existing.tick_ms ?? null,
        allowed_task_types: allowedTaskTypes ?? existing.allowed_task_types ?? safeRoleTaskTypes(role, existing),
      };
      delete state.workers[role].stop_reason;
      state.status = 'running';
      state.heartbeat_at = reusedAt;
      state.stop_requested_at = null;
      state.stopped_at = null;
      state.pid = pid;
      if (state.coordinator) {
        state.coordinator.pid = pid;
        state.worker_id = `channel-coordinator-${pid}`;
      } else {
        state.worker_id = workerId;
      }
      delete state.stop_reason;
      writeChannelWorkerState(root, subject, state);
      return { created: true, reused: true, role, state: state.workers[role] };
    }
    const now = nowIso();
    state.workers[role] = {
      role,
      worker_id: workerId,
      pid,
      status: 'running',
      started_at: now,
      heartbeat_at: now,
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: staleMs,
      tick_ms: tickMs,
      allowed_task_types: allowedTaskTypes ?? safeRoleTaskTypes(role, null),
      last_work_result: null,
      last_error: null,
    };
    state.status = 'running';
    state.heartbeat_at = now;
    state.stop_requested_at = null;
    state.stopped_at = null;
    state.pid = pid;
    if (state.coordinator) {
      state.coordinator.pid = pid;
      state.worker_id = `channel-coordinator-${state.coordinator.pid}`;
    } else {
      state.worker_id = workerId;
    }
    delete state.stop_reason;
    writeChannelWorkerState(root, subject, state);
    return { created: true, role, state: state.workers[role] };
  });
}

/** Backward-compatible single-worker create (all tasks). */
export function createChannelWorkerState(root, subject, options = {}) {
  return createChannelRoleWorkerState(root, subject, {
    ...options,
    role: options.role ?? 'all',
    workerId: options.workerId ?? defaultWorkerId().replace(/^worker-/, 'channel-worker-'),
  });
}

export function updateChannelRoleWorkerHeartbeat(root, subject, role, patch = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const state = readChannelWorkerState(root, subject) || emptyAggregateState(subject);
    const previous = state.workers?.[role] || {};
    state.workers[role] = {
      ...previous,
      ...patch,
      role,
      heartbeat_at: nowIso(),
      status: patch.status || previous.status || 'running',
    };
    state.heartbeat_at = nowIso();
    if (state.coordinator) {
      const coordPid = state.coordinator.pid ?? patch.pid ?? state.pid ?? null;
      if (coordPid != null) {
        state.pid = coordPid;
        state.worker_id = `channel-coordinator-${coordPid}`;
      }
    }
    writeChannelWorkerState(root, subject, state);
    return state.workers[role];
  });
}

export function safeUpdateChannelRoleWorkerHeartbeat(root, subject, role, patch = {}) {
  try {
    return updateChannelRoleWorkerHeartbeat(root, subject, role, patch);
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'channel_worker_state_write_failed',
      status: 'error',
      role,
      error_code: err?.code ?? null,
      error: err?.message || String(err),
    });
    return null;
  }
}

export function safeUpdateChannelWorkerHeartbeat(root, subject, patch = {}) {
  const role = patch.role ?? 'all';
  return safeUpdateChannelRoleWorkerHeartbeat(root, subject, role, patch);
}

export function updateChannelWorkerHeartbeat(root, subject, patch = {}) {
  const role = patch.role ?? 'all';
  return updateChannelRoleWorkerHeartbeat(root, subject, role, patch);
}

export function requestChannelRoleWorkerStop(root, subject, role, { staleMs = 60_000 } = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const state = readChannelWorkerState(root, subject) || emptyAggregateState(subject);
    const now = nowIso();
    const previous = state.workers?.[role];
    if (!previous) {
      return { requested: false, reason: 'not_running', role, state: null };
    }
    const effectiveStaleMs = previous.stale_after_ms ?? staleMs;
    const alive = isProcessAlive(previous.pid);
    const live = isWorkerFresh(previous, { staleMs: effectiveStaleMs }) && alive;
    state.workers[role] = {
      ...previous,
      status: live ? 'stopping' : 'stopped',
      stop_requested_at: previous.stop_requested_at || now,
      stopped_at: live ? previous.stopped_at ?? null : now,
      ...(alive ? {} : { stop_reason: 'zombie_pid_dead' }),
    };
    writeChannelWorkerState(root, subject, state);
    return {
      requested: live,
      role,
      reason: live ? 'stop_requested' : (alive ? 'stale_worker_marked_stopped' : 'zombie_pid_dead'),
      state: state.workers[role],
    };
  });
}

export function requestChannelWorkerStop(root, subject, { staleMs = 60_000, role = null } = {}) {
  if (role) {
    return requestChannelRoleWorkerStop(root, subject, role, { staleMs });
  }
  return withChannelWorkerStateLock(root, subject, () => {
    const state = readChannelWorkerState(root, subject);
    const now = nowIso();
    if (!state) {
      const empty = emptyAggregateState(subject);
      empty.stop_requested_at = now;
      empty.stopped_at = now;
      writeChannelWorkerState(root, subject, empty);
      return { requested: false, reason: 'not_running', state: empty };
    }
    const migrated = migrateLegacyState(state);
    let anyRequested = false;
    for (const key of Object.keys(migrated.workers ?? {})) {
      const previous = migrated.workers[key];
      const effectiveStaleMs = previous.stale_after_ms ?? staleMs;
      const alive = isProcessAlive(previous.pid);
      const live = isWorkerFresh(previous, { staleMs: effectiveStaleMs }) && alive;
      migrated.workers[key] = {
        ...previous,
        status: live ? 'stopping' : 'stopped',
        stop_requested_at: previous.stop_requested_at || now,
        stopped_at: live ? previous.stopped_at ?? null : now,
        ...(alive ? {} : { stop_reason: 'zombie_pid_dead' }),
      };
      anyRequested = anyRequested || live;
    }
    migrated.stop_requested_at = migrated.stop_requested_at || now;
    migrated.status = anyRequested ? 'stopping' : 'stopped';
    if (!anyRequested) migrated.stopped_at = now;
    writeChannelWorkerState(root, subject, migrated);
    return {
      requested: anyRequested,
      reason: anyRequested ? 'stop_requested' : 'stale_worker_marked_stopped',
      state: migrated,
    };
  });
}

export function markChannelRoleWorkerStopped(root, subject, role, patch = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const state = readChannelWorkerState(root, subject) || emptyAggregateState(subject);
    const previous = state.workers?.[role] || {};
    state.workers[role] = {
      ...previous,
      ...patch,
      role,
      status: 'stopped',
      stopped_at: nowIso(),
    };
    const anyRunning = Object.values(state.workers ?? {}).some((w) => w.status === 'running' || w.status === 'stopping');
    if (!anyRunning) {
      state.status = 'stopped';
      state.stopped_at = nowIso();
    }
    writeChannelWorkerState(root, subject, state);
    return state.workers[role];
  });
}

export function markChannelWorkerStopped(root, subject, patch = {}) {
  const role = patch.role ?? 'all';
  return markChannelRoleWorkerStopped(root, subject, role, patch);
}

export function safeMarkChannelRoleWorkerStopped(root, subject, role, patch = {}) {
  try {
    return markChannelRoleWorkerStopped(root, subject, role, patch);
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'channel_worker_state_write_failed',
      status: 'error',
      role,
      error_code: err?.code ?? null,
      error: err?.message || String(err),
    });
    return null;
  }
}

export function isChannelRoleStopRequested(root, subject, role) {
  const state = readChannelWorkerState(root, subject);
  return Boolean(state?.workers?.[role]?.stop_requested_at || state?.stop_requested_at);
}

function reconcileRoleWorker(worker, { now, staleMs }) {
  if (!worker || !['running', 'stopping'].includes(worker.status)) {
    return { worker, changed: false, reason: null };
  }
  const effectiveStaleMs = worker.stale_after_ms ?? staleMs;
  const fresh = isWorkerFresh(worker, { staleMs: effectiveStaleMs });
  const alive = isProcessAlive(worker.pid);
  let reason = null;
  if (!alive) reason = 'zombie_pid_dead';
  else if (!fresh) reason = 'stale_heartbeat';
  if (!reason) return { worker, changed: false, reason: null };
  return {
    worker: {
      ...worker,
      status: 'stopped',
      stopped_at: now,
      stop_reason: reason,
    },
    changed: true,
    reason,
  };
}

export function reconcileChannelWorkerState(root, subject, { staleMs = 60_000 } = {}) {
  return withChannelWorkerStateLock(root, subject, () => {
    const raw = readChannelWorkerState(root, subject);
    if (!raw) return { changed: false, roles: [], state: null };
    const state = migrateLegacyState(raw);
    const now = nowIso();
    const roles = [];
    for (const [role, previous] of Object.entries(state.workers ?? {})) {
      const result = reconcileRoleWorker(previous, { now, staleMs });
      if (!result.changed) continue;
      state.workers[role] = result.worker;
      roles.push({
        role,
        from: previous.status,
        to: 'stopped',
        reason: result.reason,
      });
    }
    const anyActive = Object.values(state.workers ?? {}).some((worker) => (
      worker.status === 'running' || worker.status === 'stopping'
    ));
    const coordinatorDead = state.pid != null && !isProcessAlive(state.pid);
    let aggregateChanged = false;
    if (!anyActive && state.status !== 'stopped') {
      state.status = 'stopped';
      state.stopped_at = now;
      if (coordinatorDead) state.stop_reason = state.stop_reason ?? 'zombie_pid_dead';
      aggregateChanged = true;
    } else if (anyActive && coordinatorDead && ['running', 'stopping'].includes(state.status)) {
      state.status = 'stopped';
      state.stopped_at = now;
      state.stop_reason = 'zombie_pid_dead';
      aggregateChanged = true;
    }
    if (!roles.length && !aggregateChanged) {
      return { changed: false, roles, state };
    }
    writeChannelWorkerState(root, subject, state);
    return { changed: true, roles, state };
  });
}
