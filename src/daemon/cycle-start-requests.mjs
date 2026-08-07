import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { writeJsonAtomic } from '../infra/atomic-json-write.mjs';
import { runtimeForSubject, nowIso } from './evolve-runs.mjs';

export { QueueWriteError, isQueueWriteError } from '../infra/atomic-json-write.mjs';

const HISTORY_LIMIT = 20;

export function cycleStartRequestsPath(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'cycle-start-requests.json');
}

export function cycleStartRequestsLockPath(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'cycle-start-requests.lock');
}

function emptyStore() {
  return { pending: null, history: [], updated_at: nowIso() };
}

function readStoreFile(filePath) {
  if (!existsSync(filePath)) return emptyStore();
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data || typeof data !== 'object') return emptyStore();
    return {
      pending: data.pending ?? null,
      history: Array.isArray(data.history) ? data.history : [],
      updated_at: data.updated_at ?? nowIso(),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(root, subject, store) {
  const filePath = cycleStartRequestsPath(root, subject);
  const next = { ...store, updated_at: nowIso() };
  writeJsonAtomic(filePath, next);
  return next;
}

function ensureStoreFiles(root, subject) {
  const dataPath = cycleStartRequestsPath(root, subject);
  const lockPath = cycleStartRequestsLockPath(root, subject);
  mkdirSync(dirname(dataPath), { recursive: true });
  if (!existsSync(dataPath)) {
    writeJsonAtomic(dataPath, emptyStore());
  }
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '', 'utf-8');
  }
}

export function withCycleStartRequestsLock(root, subject, fn) {
  ensureStoreFiles(root, subject);
  const lockPath = cycleStartRequestsLockPath(root, subject);
  let release;
  try {
    release = lockfile.lockSync(lockPath);
  } catch (e) {
    throw new Error(`Cycle start requests are locked for subject ${subject}: ${e?.message || e}`);
  }
  try {
    return fn();
  } finally {
    try { release?.(); } catch {}
  }
}

function mergeMeta(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const prev = Array.isArray(merged[key]) ? merged[key] : [];
      merged[key] = [...new Set([...prev, ...value])];
    } else if (typeof value === 'object' && !Array.isArray(value) && typeof merged[key] === 'object' && merged[key]) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function normalizeReason(reason) {
  const value = String(reason || 'manual').trim();
  return value || 'manual';
}

export function readPendingCycleStartRequest(root, subject) {
  const store = readStoreFile(cycleStartRequestsPath(root, subject));
  return store.pending;
}

export function readCycleStartRequestsStore(root, subject) {
  return readStoreFile(cycleStartRequestsPath(root, subject));
}

export function enqueueCycleStartRequest(root, subject, { reason = 'manual', meta = {} } = {}) {
  const normalizedReason = normalizeReason(reason);
  return withCycleStartRequestsLock(root, subject, () => {
    const filePath = cycleStartRequestsPath(root, subject);
    const store = readStoreFile(filePath);
    const now = nowIso();
    let created = false;

    if (!store.pending) {
      store.pending = {
        request_id: randomUUID(),
        reasons: [normalizedReason],
        created_at: now,
        updated_at: now,
        meta: { ...meta },
        deferred_count: 0,
      };
      created = true;
    } else {
      if (!store.pending.reasons.includes(normalizedReason)) {
        store.pending.reasons.push(normalizedReason);
      }
      store.pending.meta = mergeMeta(store.pending.meta, meta);
      store.pending.updated_at = now;
    }

    const saved = writeStore(root, subject, store);
    return {
      created,
      merged: !created,
      request: saved.pending,
    };
  });
}

export function consumeCycleStartRequest(root, subject, requestId) {
  return withCycleStartRequestsLock(root, subject, () => {
    const filePath = cycleStartRequestsPath(root, subject);
    const store = readStoreFile(filePath);
    if (!store.pending || store.pending.request_id !== requestId) {
      return { consumed: false, reason: 'request_not_found' };
    }
    const consumed = { ...store.pending, consumed_at: nowIso() };
    store.history = [consumed, ...store.history].slice(0, HISTORY_LIMIT);
    store.pending = null;
    writeStore(root, subject, store);
    return { consumed: true, request: consumed };
  });
}

export function deferCycleStartRequest(root, subject, requestId, { blockedReason = null } = {}) {
  return withCycleStartRequestsLock(root, subject, () => {
    const filePath = cycleStartRequestsPath(root, subject);
    const store = readStoreFile(filePath);
    if (!store.pending || store.pending.request_id !== requestId) {
      return { deferred: false, reason: 'request_not_found' };
    }
    store.pending.deferred_count = (store.pending.deferred_count ?? 0) + 1;
    store.pending.last_deferred_at = nowIso();
    if (blockedReason) store.pending.last_blocked_reason = blockedReason;
    store.pending.updated_at = nowIso();
    writeStore(root, subject, store);
    return { deferred: true, request: store.pending };
  });
}

export function summarizePendingCycleStartRequest(pending) {
  if (!pending) return null;
  return {
    request_id: pending.request_id,
    reasons: pending.reasons ?? [],
    created_at: pending.created_at,
    updated_at: pending.updated_at,
    deferred_count: pending.deferred_count ?? 0,
    last_blocked_reason: pending.last_blocked_reason ?? null,
  };
}
