import { existsSync } from 'node:fs';
import { readJsonSafe, writeJsonFile } from '../cli/utils/files.mjs';
import {
  defaultWorkerId,
  isWorkerFresh,
  isWorkerZombie,
  parseHeartbeatMs,
  parseHeartbeatStaleMs,
  summarizeWorkerState,
} from '../cli/utils/daemon-worker-state.mjs';
import { isProcessAlive } from '../cli/utils/process-alive.mjs';
import { channelWorkerStatePath } from './paths.mjs';
import { nowIso } from './types.mjs';

export { defaultWorkerId, parseHeartbeatMs, parseHeartbeatStaleMs, summarizeWorkerState };

export function readChannelWorkerState(root, subject) {
  const filePath = channelWorkerStatePath(root, subject);
  if (!existsSync(filePath)) return null;
  const state = readJsonSafe(filePath, null);
  return state && typeof state === 'object' ? state : null;
}

export function writeChannelWorkerState(root, subject, state) {
  writeJsonFile(channelWorkerStatePath(root, subject), state);
  return state;
}

export function createChannelWorkerState(root, subject, {
  workerId = defaultWorkerId(),
  pid = process.pid,
  staleMs = 60_000,
  tickMs = null,
} = {}) {
  const existing = readChannelWorkerState(root, subject);
  if (existing && isWorkerZombie(existing, { staleMs })) {
    markChannelWorkerStopped(root, subject, {
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
    domain: 'channel',
    worker_id: workerId,
    pid,
    status: 'running',
    started_at: now,
    heartbeat_at: now,
    stop_requested_at: null,
    stopped_at: null,
    stale_after_ms: staleMs,
    tick_ms: tickMs,
    last_work_result: null,
    last_error: null,
  };
  writeChannelWorkerState(root, subject, state);
  return { created: true, state };
}

export function updateChannelWorkerHeartbeat(root, subject, patch = {}) {
  const previous = readChannelWorkerState(root, subject) || {};
  const state = {
    ...previous,
    ...patch,
    subject,
    domain: 'channel',
    status: patch.status || previous.status || 'running',
    heartbeat_at: nowIso(),
  };
  writeChannelWorkerState(root, subject, state);
  return state;
}

export function requestChannelWorkerStop(root, subject, { staleMs = 60_000 } = {}) {
  const previous = readChannelWorkerState(root, subject);
  const now = nowIso();
  if (!previous) {
    const state = {
      subject,
      domain: 'channel',
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
    writeChannelWorkerState(root, subject, state);
    return { requested: false, reason: 'not_running', state };
  }
  const effectiveStaleMs = previous.stale_after_ms ?? staleMs;
  const fresh = isWorkerFresh(previous, { staleMs: effectiveStaleMs });
  const state = {
    ...previous,
    domain: 'channel',
    status: fresh ? 'stopping' : 'stopped',
    stop_requested_at: previous.stop_requested_at || now,
    stopped_at: fresh ? previous.stopped_at ?? null : now,
    stale_after_ms: effectiveStaleMs,
  };
  writeChannelWorkerState(root, subject, state);
  return {
    requested: fresh,
    reason: fresh ? 'stop_requested' : 'stale_worker_marked_stopped',
    state,
  };
}

export function markChannelWorkerStopped(root, subject, patch = {}) {
  const previous = readChannelWorkerState(root, subject) || {};
  const state = {
    ...previous,
    ...patch,
    subject,
    domain: 'channel',
    status: 'stopped',
    stopped_at: nowIso(),
  };
  writeChannelWorkerState(root, subject, state);
  return state;
}
