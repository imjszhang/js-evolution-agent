import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readJson, updateJson } from '../infra/json-store.mjs';
import {
  archiveJsonRecords,
  retentionPolicy,
  terminalArchiveCandidates,
} from '../infra/sidecar-retention.mjs';
import { channelEventQueuePath } from './paths.mjs';
import { nowIso } from './types.mjs';

const EVENT_STATUSES = new Set(['pending', 'claimed', 'handled', 'failed', 'superseded']);

function emptyQueue() {
  return { events: [] };
}

function readQueue(root, subject) {
  const raw = readJson(channelEventQueuePath(root, subject), emptyQueue());
  return {
    events: Array.isArray(raw.events) ? raw.events : [],
    updated_at: raw.updated_at ?? null,
  };
}

function normalizeQueue(queue) {
  const next = {
    ...queue,
    updated_at: nowIso(),
  };
  return next;
}

function updateQueue(root, subject, updater) {
  return updateJson(channelEventQueuePath(root, subject), (raw) => {
    const queue = {
      events: Array.isArray(raw?.events) ? raw.events : [],
      updated_at: raw?.updated_at ?? null,
    };
    return normalizeQueue(updater(queue) ?? queue);
  }, { fallback: emptyQueue() });
}

export function channelEventArchivePath(root, subject) {
  return join(dirname(channelEventQueuePath(root, subject)), 'archive', 'terminal_events.json');
}

function normalizeEvent(event = {}) {
  const type = String(event.type ?? 'unknown').trim() || 'unknown';
  return {
    id: event.id ?? `channel-event-${randomUUID()}`,
    type,
    reason: event.reason ?? null,
    event_ref: event.event_ref ?? null,
    payload_summary: event.payload_summary ?? null,
    payload: event.payload ?? null,
    status: EVENT_STATUSES.has(event.status) ? event.status : 'pending',
    created_at: event.created_at ?? nowIso(),
    claimed_by: event.claimed_by ?? null,
    claimed_at: event.claimed_at ?? null,
    handled_at: event.handled_at ?? null,
    last_error: event.last_error ?? null,
    attempts: Math.max(0, Number(event.attempts) || 0),
    max_attempts: Math.max(1, Number(event.max_attempts) || 1),
    next_attempt_at: event.next_attempt_at ?? null,
  };
}

export function appendChannelEvent(root, subject, event = {}) {
  const record = normalizeEvent({ ...event, status: 'pending' });
  updateQueue(root, subject, (queue) => {
    queue.events.push(record);
    return queue;
  });
  return record;
}

export function listPendingChannelEvents(root, subject, { limit = 50, type = null } = {}) {
  const queue = readQueue(root, subject);
  let rows = queue.events.filter((e) => e.status === 'pending');
  if (type) rows = rows.filter((e) => e.type === type);
  return rows
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, Math.max(0, limit));
}

export function claimChannelEvents(root, subject, { runId, limit = 20, types = null } = {}) {
  const now = nowIso();
  const typeSet = types ? new Set(types) : null;
  const claimed = [];
  updateQueue(root, subject, (queue) => {
    for (const event of queue.events) {
      if (event.status !== 'pending') continue;
      if (typeSet && !typeSet.has(event.type)) continue;
      const nextAttempt = Date.parse(event.next_attempt_at ?? '');
      if (Number.isFinite(nextAttempt) && nextAttempt > Date.now()) continue;
      event.status = 'claimed';
      event.claimed_by = runId ?? null;
      event.claimed_at = now;
      event.attempts = Math.max(0, Number(event.attempts) || 0) + 1;
      claimed.push(event);
      if (claimed.length >= limit) break;
    }
    return queue;
  });
  return claimed;
}

function updateEvents(root, subject, eventIds, patchFn) {
  const ids = new Set(eventIds ?? []);
  if (!ids.size) return [];
  const updated = [];
  updateQueue(root, subject, (queue) => {
    for (const event of queue.events) {
      if (!ids.has(event.id)) continue;
      patchFn(event);
      updated.push(event);
    }
    return queue;
  });
  return updated;
}

export function markChannelEventsHandled(root, subject, eventIds, meta = {}) {
  const now = nowIso();
  return updateEvents(root, subject, eventIds, (event) => {
    event.status = 'handled';
    event.handled_at = now;
    event.last_error = null;
    Object.assign(event, meta.handled_meta ?? {});
  });
}

export function markChannelEventsFailed(root, subject, eventIds, meta = {}) {
  const now = nowIso();
  return updateEvents(root, subject, eventIds, (event) => {
    event.status = 'failed';
    event.handled_at = now;
    event.last_error = meta.error ?? meta.last_error ?? 'failed';
  });
}

export function requeueChannelEvents(root, subject, eventIds, {
  error = 'retryable_failure',
  delayMs = 0,
} = {}) {
  const nextAttemptAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString();
  return updateEvents(root, subject, eventIds, (event) => {
    event.status = 'pending';
    event.claimed_by = null;
    event.claimed_at = null;
    event.handled_at = null;
    event.last_error = error;
    event.next_attempt_at = nextAttemptAt;
  });
}

export function supersedePendingChannelEvents(root, subject, { type, keepLatest = true } = {}) {
  const now = nowIso();
  let toSupersede = [];
  updateQueue(root, subject, (queue) => {
    const pending = queue.events.filter((e) => e.status === 'pending' && (!type || e.type === type));
    if (pending.length <= 1) return queue;
    const sorted = [...pending].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    toSupersede = keepLatest ? sorted.slice(1) : sorted;
    for (const event of toSupersede) {
      event.status = 'superseded';
      event.handled_at = now;
    }
    return queue;
  });
  return toSupersede;
}

export function getChannelEvent(root, subject, eventId) {
  if (!eventId) return null;
  return readQueue(root, subject).events.find((event) => event.id === eventId) ?? null;
}

export function listChannelEvents(root, subject, { type = null } = {}) {
  const rows = readQueue(root, subject).events;
  return type ? rows.filter((event) => event.type === type) : rows;
}

export function cleanupChannelEventQueue(root, subject, {
  now = Date.now(),
  ...options
} = {}) {
  const policy = retentionPolicy('channel_event', options);
  let result = { archived: 0, retained: 0 };
  updateQueue(root, subject, (queue) => {
    const candidates = terminalArchiveCandidates(queue.events, {
      now,
      ...policy,
      isTerminal: (event) => ['handled', 'failed', 'superseded'].includes(event.status),
      timestamp: (event) => event.handled_at || event.created_at,
    });
    if (!candidates.length) {
      result.retained = queue.events.length;
      return queue;
    }
    archiveJsonRecords(channelEventArchivePath(root, subject), candidates, {
      collection: 'events',
      idOf: (event) => event.id,
    });
    const ids = new Set(candidates.map((event) => event.id));
    queue.events = queue.events.filter((event) => !ids.has(event.id));
    result = { archived: candidates.length, retained: queue.events.length };
    return queue;
  });
  return result;
}

export function summarizeChannelEventQueue(root, subject) {
  const queue = readQueue(root, subject);
  const counts = { pending: 0, claimed: 0, handled: 0, failed: 0, superseded: 0 };
  for (const event of queue.events) {
    counts[event.status] = (counts[event.status] ?? 0) + 1;
  }
  return {
    total: queue.events.length,
    counts,
    pending_speech_generation: queue.events.filter((e) =>
      e.status === 'pending' && e.type === 'speech_generation_requested').length,
  };
}
