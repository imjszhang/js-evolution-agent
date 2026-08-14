/**
 * Per-goal rule cursor: each goal remembers the last evidence id it processed.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';
import { reactorDir } from './paths.mjs';

export function ruleCursorsPath(dataRoot) {
  return join(reactorDir(dataRoot), 'rule-cursors.json');
}

function emptyStore() {
  return { global_cursor: null, goals: {}, updated_at: null };
}

export function readRuleCursors(dataRoot) {
  const raw = readJson(ruleCursorsPath(dataRoot), emptyStore());
  return {
    global_cursor: raw?.global_cursor ?? null,
    goals: raw?.goals && typeof raw.goals === 'object' ? raw.goals : {},
    updated_at: raw?.updated_at ?? null,
  };
}

export function writeRuleCursors(dataRoot, {
  globalCursor = null,
  goalIds = [],
  lastEventId = null,
  goalCursors = null,
  batchId = null,
} = {}) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const file = ruleCursorsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  const at = nowIso();
  return updateJson(file, (raw) => {
    const store = {
      global_cursor: raw?.global_cursor ?? null,
      goals: raw?.goals && typeof raw.goals === 'object' ? { ...raw.goals } : {},
      updated_at: raw?.updated_at ?? null,
    };
    if (globalCursor || lastEventId) {
      store.global_cursor = globalCursor || lastEventId;
    }
    for (const goalId of goalIds) {
      if (!goalId) continue;
      const cursor = goalCursors?.[goalId] ?? null;
      store.goals[goalId] = {
        last_evidence_key: cursor?.evidenceKey
          || store.goals[goalId]?.last_evidence_key
          || null,
        last_event_id: cursor?.eventId
          || lastEventId
          || store.goals[goalId]?.last_event_id
          || null,
        last_batch_id: batchId || store.goals[goalId]?.last_batch_id || null,
        updated_at: at,
      };
    }
    store.updated_at = at;
    return store;
  }, { fallback: emptyStore() });
}

export function eventsAfterCursor(events = [], cursorId = null) {
  if (!cursorId) return events;
  const index = events.findIndex((item) => (
    item.id === cursorId
    || item.evidence_key === cursorId
    || envelopeEvidenceKey(item) === cursorId
  ));
  if (index < 0) return events;
  return events.slice(index + 1);
}

export function goalBucketForEnvelope(envelope = {}) {
  const payload = envelope.payload || {};
  return payload.serves_goal
    || payload.goal_id
    || payload.action?.serves_goal
    || envelope.serves_goal
    || 'global';
}

export function cursorForGoal(cursors, goalId) {
  if (!goalId || goalId === 'global') return cursors?.global_cursor ?? null;
  return cursors?.goals?.[goalId]?.last_evidence_key
    ?? cursors?.goals?.[goalId]?.last_event_id
    ?? null;
}
