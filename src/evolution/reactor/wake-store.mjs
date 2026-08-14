/**
 * Durable, mergeable wake intents (S3).
 * Producers write the wake contract only; daemon consumes and enqueues tasks.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { handleContractValidation, validateWakeIntent } from '../../contracts/index.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { nowIso, runtimeForSubject } from '../../infra/runtime-paths.mjs';
import { reactorDir } from './paths.mjs';
import { WAKE_INTENT_KINDS } from '../../contracts/wake-intent.mjs';

export const REACTOR_TASK_TYPES = Object.freeze({
  cognitive: 'cognitive_reaction',
  exec: 'exec_queue',
  verify: 'verify_batch',
  rule: 'rule_reaction',
  memory: 'memory_compaction',
});

export function wakesPath(dataRoot) {
  return join(reactorDir(dataRoot), 'wakes.json');
}

function emptyStore() {
  return { wakes: [], updated_at: nowIso() };
}

export function readWakeStore(dataRoot) {
  const filePath = wakesPath(dataRoot);
  if (!existsSync(filePath)) return emptyStore();
  try {
    const data = readJson(filePath);
    if (!data || !Array.isArray(data.wakes)) return emptyStore();
    return data;
  } catch {
    return emptyStore();
  }
}

function mutateWakeStore(dataRoot, updater) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const filePath = wakesPath(dataRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  return updateJson(filePath, (raw) => {
    const store = {
      wakes: Array.isArray(raw?.wakes) ? raw.wakes : [],
      updated_at: raw?.updated_at ?? nowIso(),
    };
    const next = updater(store) ?? store;
    next.updated_at = nowIso();
    return next;
  }, { fallback: emptyStore() });
}

export function mergeKeyFor(subject, kind) {
  return `${subject}:${kind}`;
}

/**
 * Write or merge a pending wake intent. Does not enqueue a daemon task.
 */
export function enqueueWakeIntent(root, subject, {
  kind,
  reason,
  source = null,
  now = nowIso(),
} = {}) {
  if (!WAKE_INTENT_KINDS.includes(kind)) {
    throw new Error(`Unknown wake kind: ${kind}`);
  }
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const merge_key = mergeKeyFor(subject, kind);
  let created = false;
  let merged = false;
  let intent = null;
  mutateWakeStore(dataRoot, (store) => {
    const existing = store.wakes.find((item) => item.merge_key === merge_key && item.status === 'pending');
    if (existing) {
      existing.updated_at = now;
      existing.reason = reason || existing.reason;
      if (source) existing.source = source;
      handleContractValidation('wake_intent', validateWakeIntent(existing));
      intent = existing;
      merged = true;
      return store;
    }
    intent = {
      id: `wake-${randomUUID().slice(0, 8)}`,
      kind,
      subject,
      created_at: now,
      updated_at: now,
      status: 'pending',
      reason: reason || kind,
      merge_key,
      source,
    };
    handleContractValidation('wake_intent', validateWakeIntent(intent));
    store.wakes.push(intent);
    created = true;
    return store;
  });
  return { intent, created, merged };
}

export function listPendingWakes(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return (readWakeStore(runtime.dataRoot).wakes || []).filter((item) => item.status === 'pending');
}

export function consumeWakeIntent(root, subject, { kind, mergeKey = null } = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const key = mergeKey || mergeKeyFor(subject, kind);
  let target = null;
  mutateWakeStore(dataRoot, (store) => {
    target = store.wakes.find((item) => item.merge_key === key && item.status === 'pending') || null;
    if (!target) return store;
    target.status = 'consumed';
    target.updated_at = nowIso();
    return store;
  });
  return { consumed: Boolean(target), intent: target };
}

export function supersedeWakeIntent(root, subject, { kind } = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const key = mergeKeyFor(subject, kind);
  let count = 0;
  mutateWakeStore(dataRoot, (store) => {
    for (const item of store.wakes) {
      if (item.merge_key === key && item.status === 'pending') {
        item.status = 'superseded';
        item.updated_at = nowIso();
        count += 1;
      }
    }
    return store;
  });
  return { superseded: count };
}
