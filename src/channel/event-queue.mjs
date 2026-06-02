import { randomUUID } from 'node:crypto';
import { readJsonSafe, writeJsonFile } from '../cli/utils/files.mjs';
import { channelEventQueuePath } from './paths.mjs';
import { nowIso } from './types.mjs';

const EVENT_STATUSES = new Set(['pending', 'claimed', 'handled', 'failed', 'superseded']);

function emptyQueue() {
  return { events: [] };
}

function readQueue(root, subject) {
  const raw = readJsonSafe(channelEventQueuePath(root, subject), emptyQueue());
  return {
    events: Array.isArray(raw.events) ? raw.events : [],
    updated_at: raw.updated_at ?? null,
  };
}

function writeQueue(root, subject, queue) {
  const next = {
    ...queue,
    updated_at: nowIso(),
  };
  writeJsonFile(channelEventQueuePath(root, subject), next);
  return next;
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
  };
}

export function appendChannelEvent(root, subject, event = {}) {
  const queue = readQueue(root, subject);
  const record = normalizeEvent({ ...event, status: 'pending' });
  queue.events.push(record);
  writeQueue(root, subject, queue);
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
  const queue = readQueue(root, subject);
  const now = nowIso();
  const typeSet = types ? new Set(types) : null;
  const claimed = [];
  for (const event of queue.events) {
    if (event.status !== 'pending') continue;
    if (typeSet && !typeSet.has(event.type)) continue;
    event.status = 'claimed';
    event.claimed_by = runId ?? null;
    event.claimed_at = now;
    claimed.push(event);
    if (claimed.length >= limit) break;
  }
  if (claimed.length) writeQueue(root, subject, queue);
  return claimed;
}

function updateEvents(root, subject, eventIds, patchFn) {
  const ids = new Set(eventIds ?? []);
  if (!ids.size) return [];
  const queue = readQueue(root, subject);
  const updated = [];
  for (const event of queue.events) {
    if (!ids.has(event.id)) continue;
    patchFn(event);
    updated.push(event);
  }
  if (updated.length) writeQueue(root, subject, queue);
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

export function supersedePendingChannelEvents(root, subject, { type, keepLatest = true } = {}) {
  const queue = readQueue(root, subject);
  const pending = queue.events.filter((e) => e.status === 'pending' && (!type || e.type === type));
  if (pending.length <= 1) return [];
  const sorted = [...pending].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const toSupersede = keepLatest ? sorted.slice(1) : sorted;
  const now = nowIso();
  for (const event of toSupersede) {
    event.status = 'superseded';
    event.handled_at = now;
  }
  writeQueue(root, subject, queue);
  return toSupersede;
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
