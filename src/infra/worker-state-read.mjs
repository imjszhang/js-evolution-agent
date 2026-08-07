// Neutral read-side helpers for daemon worker-state.json.
// Kept in infra so subject-lock can inspect worker freshness without importing
// the daemon orchestration module (avoids runtime-paths ↔ daemon cycles).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe } from './files.mjs';
import { runtimeForSubject } from './runtime-paths.mjs';

export function workerStatePath(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'daemon', 'worker-state.json');
}

export function readWorkerState(root, subject) {
  const filePath = workerStatePath(root, subject);
  if (!existsSync(filePath)) return null;
  const state = readJsonSafe(filePath, null);
  return state && typeof state === 'object' ? state : null;
}

export function isWorkerFresh(state, { nowMs = Date.now(), staleMs = 60_000 } = {}) {
  if (!state || !['running', 'stopping'].includes(state.status)) return false;
  const heartbeatMs = Date.parse(state.heartbeat_at ?? '');
  return Number.isFinite(heartbeatMs) && heartbeatMs > nowMs - staleMs;
}
