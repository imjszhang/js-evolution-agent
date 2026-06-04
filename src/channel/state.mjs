import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonSafe, writeJsonFile } from '../cli/utils/files.mjs';
import { getChannelEvent } from './event-queue.mjs';
import { nowIso } from './types.mjs';

const ACTIVE_SPEECH_EVENT_STATUSES = new Set(['pending', 'claimed']);
import {
  channelCooldownPath,
  channelDedupPath,
  channelInboundFailedDir,
  channelInboundPendingDir,
  channelInboundProcessedDir,
  channelOutboxFailedDir,
  channelOutboxPendingDir,
  channelOutboxSentDir,
  channelPresenceStatePath,
  channelReloadRequestPath,
  channelReloadStatePath,
} from './paths.mjs';

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writePendingInbound(root, subject, payload, { label = 'message' } = {}) {
  const dir = ensureDir(channelInboundPendingDir(root, subject));
  const id = safeFilenamePart(payload?.message_id ?? payload?.messageId ?? payload?.event_id ?? randomUUID());
  const file = join(dir, `${timestampForFilename()}-${safeFilenamePart(label)}-${id}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  return { file };
}

export function listAllPendingInbound(root, subject) {
  return listJsonFiles(channelInboundPendingDir(root, subject));
}

export function listPendingInbound(root, subject, { limit = 20 } = {}) {
  return listAllPendingInbound(root, subject).slice(0, Math.max(0, limit));
}

/** Oldest pending inbound files first (filename timestamp prefix). */
export function listPendingInboundBatch(root, subject, { limit = 20 } = {}) {
  return listAllPendingInbound(root, subject).slice(0, Math.max(0, limit));
}

export function countPendingInbound(root, subject) {
  return listAllPendingInbound(root, subject).length;
}

export function summarizeUnclassifiedInbound(root, subject, { previewLimit = 0 } = {}) {
  const files = listAllPendingInbound(root, subject);
  const oldestFile = files[0] ?? null;
  let oldest_at = null;
  if (oldestFile) {
    const payload = readJsonFile(oldestFile);
    oldest_at = payload?.received_at
      ?? payload?.envelope?.received_at
      ?? null;
  }
  const preview = [];
  if (previewLimit > 0) {
    for (const file of files.slice(0, previewLimit)) {
      const payload = readJsonFile(file);
      preview.push({
        file,
        message_id: payload?.message_id ?? payload?.messageId ?? payload?.envelope?.message_id ?? null,
        received_at: payload?.received_at ?? payload?.envelope?.received_at ?? null,
      });
    }
  }
  return {
    pending_unclassified_count: files.length,
    oldest_unclassified_at: oldest_at,
    preview,
  };
}

export function listRecentInboundProcessed(root, subject, { limit = 10 } = {}) {
  const files = listJsonFiles(channelInboundProcessedDir(root, subject));
  return files.slice(-Math.max(0, limit)).reverse();
}

export function markInboundProcessed(root, subject, file, payload = null) {
  const dir = ensureDir(channelInboundProcessedDir(root, subject));
  const target = join(dir, `${timestampForFilename()}-${basename(file)}`);
  if (payload) writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(file, target);
  return target;
}

export function markInboundFailed(root, subject, file, reason, payload = null) {
  const dir = ensureDir(channelInboundFailedDir(root, subject));
  const target = join(dir, `${timestampForFilename()}-${basename(file)}`);
  if (payload) {
    writeFileSync(file, JSON.stringify({
      failed_at: nowIso(),
      reason,
      payload,
    }, null, 2), 'utf-8');
  }
  renameSync(file, target);
  return target;
}

export function readDedup(root, subject) {
  const data = readJsonSafe(channelDedupPath(root, subject), { seen: {} });
  return data && typeof data === 'object' && data.seen ? data : { seen: {} };
}

export function hasSeenMessage(root, subject, messageId) {
  if (!messageId) return false;
  return Boolean(readDedup(root, subject).seen?.[messageId]);
}

export function markMessageSeen(root, subject, messageId, meta = {}) {
  if (!messageId) return null;
  const state = readDedup(root, subject);
  state.seen[messageId] = {
    first_seen_at: state.seen[messageId]?.first_seen_at ?? nowIso(),
    last_seen_at: nowIso(),
    ...meta,
  };
  writeJsonFile(channelDedupPath(root, subject), state);
  return state.seen[messageId];
}

export function readCooldown(root, subject) {
  const data = readJsonSafe(channelCooldownPath(root, subject), { keys: {} });
  return data && typeof data === 'object' && data.keys ? data : { keys: {} };
}

export function cooldownActive(root, subject, key, { nowMs = Date.now() } = {}) {
  if (!key) return false;
  const state = readCooldown(root, subject);
  const until = Date.parse(state.keys?.[key]?.until ?? '');
  return Number.isFinite(until) && until > nowMs;
}

export function setCooldown(root, subject, key, ttlMs, meta = {}) {
  if (!key || !ttlMs) return null;
  const state = readCooldown(root, subject);
  state.keys[key] = {
    until: new Date(Date.now() + ttlMs).toISOString(),
    updated_at: nowIso(),
    ...meta,
  };
  writeJsonFile(channelCooldownPath(root, subject), state);
  return state.keys[key];
}

export function writeOutboxMessage(root, subject, message) {
  const dir = ensureDir(channelOutboxPendingDir(root, subject));
  const key = safeFilenamePart(message.idempotency_key ?? message.id ?? randomUUID());
  const existing = findOutboxByIdempotencyKey(root, subject, message.idempotency_key);
  if (existing) {
    return {
      file: existing.file,
      message: existing.payload?.outbound ?? existing.payload,
      created: false,
      duplicate: true,
      existing_status: existing.status,
    };
  }
  const file = join(dir, `${timestampForFilename()}-${key}.json`);
  writeFileSync(file, JSON.stringify(message, null, 2), 'utf-8');
  return { file, message, created: true, duplicate: false };
}

export function listOutboxPending(root, subject, { limit = 20 } = {}) {
  return listJsonFiles(channelOutboxPendingDir(root, subject)).slice(0, Math.max(0, limit));
}

function outboxPayloadIdempotencyKey(payload) {
  return payload?.idempotency_key ?? payload?.outbound?.idempotency_key ?? null;
}

export function findOutboxByIdempotencyKey(root, subject, idempotencyKey) {
  if (!idempotencyKey) return null;
  for (const [status, dir] of [
    ['pending', channelOutboxPendingDir(root, subject)],
    ['sent', channelOutboxSentDir(root, subject)],
  ]) {
    for (const file of listJsonFiles(dir)) {
      const payload = readJsonFile(file);
      if (outboxPayloadIdempotencyKey(payload) === idempotencyKey) {
        return { status, file, payload };
      }
    }
  }
  return null;
}

export function markOutboxSent(root, subject, file, payload = {}) {
  const dir = ensureDir(channelOutboxSentDir(root, subject));
  const target = join(dir, `${timestampForFilename()}-${basename(file)}`);
  writeFileSync(file, JSON.stringify({
    ...payload,
    sent_at: payload.sent_at ?? nowIso(),
  }, null, 2), 'utf-8');
  renameSync(file, target);
  return target;
}

export function markOutboxFailed(root, subject, file, reason, payload = {}) {
  const dir = ensureDir(channelOutboxFailedDir(root, subject));
  const target = join(dir, `${timestampForFilename()}-${basename(file)}`);
  writeFileSync(file, JSON.stringify({
    ...payload,
    failed_at: nowIso(),
    reason,
  }, null, 2), 'utf-8');
  renameSync(file, target);
  return target;
}

export function ensureParent(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function writeChannelReloadRequest(root, subject, payload = {}) {
  const file = channelReloadRequestPath(root, subject);
  ensureParent(file);
  const record = {
    reason: payload.reason ?? 'reload_requested',
    changed: Array.isArray(payload.changed) ? payload.changed : [],
    requested_at: payload.requested_at ?? nowIso(),
    ...payload,
  };
  writeJsonFile(file, record);
  return { file, request: record };
}

export function readChannelReloadRequest(root, subject) {
  return readJsonSafe(channelReloadRequestPath(root, subject), null);
}

export function consumeChannelReloadRequest(root, subject) {
  const file = channelReloadRequestPath(root, subject);
  if (!existsSync(file)) return null;
  const request = readJsonSafe(file, null);
  try {
    renameSync(file, `${file}.processed-${timestampForFilename()}`);
  } catch {
    writeJsonFile(file, { ...(request ?? {}), consumed_at: nowIso() });
  }
  return request;
}

export function readChannelReloadState(root, subject) {
  return readJsonSafe(channelReloadStatePath(root, subject), {
    last_reload_at: null,
    last_reload_reason: null,
    last_error: null,
    config_fingerprint: null,
  });
}

export function writeChannelReloadState(root, subject, patch = {}) {
  const current = readChannelReloadState(root, subject);
  const next = {
    ...current,
    ...patch,
    updated_at: nowIso(),
  };
  writeJsonFile(channelReloadStatePath(root, subject), next);
  return next;
}

export const PRESENCE_HANDLED_CURSOR_LIMIT = 200;

const DEFAULT_REACTOR_STATE = Object.freeze({
  status: 'idle',
  current_run_id: null,
  started_at: null,
  deadline_at: null,
  event_ids: [],
  last_error: null,
});

const DEFAULT_PRESENCE_STATE = Object.freeze({
  handled_candidates: {},
  last_presence_tick_at: null,
  last_spoken_at: null,
  last_plan: null,
  reactor: { ...DEFAULT_REACTOR_STATE },
  pending_speech_generation: [],
});

function trimPresenceHandledMap(map, limit = PRESENCE_HANDLED_CURSOR_LIMIT) {
  const entries = Object.entries(map ?? {});
  if (entries.length <= limit) return { ...(map ?? {}) };
  const sorted = entries.sort((a, b) => String(b[1]?.handled_at ?? '').localeCompare(String(a[1]?.handled_at ?? '')));
  return Object.fromEntries(sorted.slice(0, limit));
}

export function readPresenceState(root, subject) {
  const raw = readJsonSafe(channelPresenceStatePath(root, subject), {});
  return {
    ...DEFAULT_PRESENCE_STATE,
    ...raw,
    handled_candidates: { ...(raw.handled_candidates ?? {}) },
    reactor: {
      ...DEFAULT_REACTOR_STATE,
      ...(raw.reactor ?? {}),
      event_ids: Array.isArray(raw.reactor?.event_ids) ? [...raw.reactor.event_ids] : [],
    },
    pending_speech_generation: Array.isArray(raw.pending_speech_generation)
      ? [...raw.pending_speech_generation]
      : [],
  };
}

export function isPresenceRunExpired(state, { nowMs = Date.now() } = {}, config = {}) {
  const deadline = Date.parse(state?.reactor?.deadline_at ?? '');
  if (!Number.isFinite(deadline)) return false;
  return nowMs > deadline;
}

export function beginPresenceRun(root, subject, { runId, eventIds = [], deadlineAt = null } = {}) {
  return writePresenceState(root, subject, {
    reactor: {
      status: 'planning',
      current_run_id: runId ?? null,
      started_at: nowIso(),
      deadline_at: deadlineAt,
      event_ids: eventIds,
      last_error: null,
    },
  });
}

export function completePresenceRun(root, subject, { runId = null } = {}) {
  const current = readPresenceState(root, subject);
  if (runId && current.reactor?.current_run_id && current.reactor.current_run_id !== runId) {
    return current;
  }
  return writePresenceState(root, subject, {
    reactor: {
      ...DEFAULT_REACTOR_STATE,
      status: 'idle',
    },
  });
}

export function failPresenceRun(root, subject, { runId = null, error = null } = {}) {
  const current = readPresenceState(root, subject);
  if (runId && current.reactor?.current_run_id && current.reactor.current_run_id !== runId) {
    return current;
  }
  return writePresenceState(root, subject, {
    reactor: {
      ...current.reactor,
      status: 'failed',
      last_error: error ?? current.reactor?.last_error ?? 'failed',
    },
  });
}

export function trackPendingSpeechGeneration(root, subject, entry) {
  const current = readPresenceState(root, subject);
  const pending = [...(current.pending_speech_generation ?? []), entry].slice(-50);
  return writePresenceState(root, subject, { pending_speech_generation: pending });
}

export function clearPendingSpeechGeneration(root, subject, intentId) {
  const current = readPresenceState(root, subject);
  const pending = (current.pending_speech_generation ?? []).filter((e) => e.intent_id !== intentId);
  return writePresenceState(root, subject, { pending_speech_generation: pending });
}

/**
 * Drop pending_speech_generation rows whose event is missing or no longer active.
 * Heals stale viewer counts after failed or completed speech generation.
 */
export function reconcilePendingSpeechGeneration(root, subject) {
  const current = readPresenceState(root, subject);
  const entries = current.pending_speech_generation ?? [];
  if (!entries.length) {
    return { changed: false, state: current };
  }

  const kept = entries.filter((entry) => {
    if (!entry.event_id) return false;
    const event = getChannelEvent(root, subject, entry.event_id);
    if (!event) return false;
    return ACTIVE_SPEECH_EVENT_STATUSES.has(event.status);
  });

  if (kept.length === entries.length) {
    return { changed: false, state: current };
  }
  const state = writePresenceState(root, subject, { pending_speech_generation: kept });
  return { changed: true, state };
}

export function buildPresenceSignalKey(signal) {
  if (!signal || typeof signal !== 'object') return 'unknown';
  if (signal.key) return String(signal.key);
  const parts = [signal.type];
  if (signal.task_id) parts.push(signal.task_id);
  else if (signal.cycle_id) parts.push(signal.cycle_id);
  else if (signal.id) parts.push(signal.id);
  return parts.join(':');
}

export function isExpressionCandidateHandled(root, subject, candidateId) {
  if (!candidateId) return false;
  return Boolean(readPresenceState(root, subject).handled_candidates?.[candidateId]);
}

export function writePresenceState(root, subject, patch = {}) {
  const current = readPresenceState(root, subject);
  const mergedCandidates = patch.handled_candidates
    ? { ...current.handled_candidates, ...patch.handled_candidates }
    : current.handled_candidates;
  const { handled_candidates: _hc, ...restPatch } = patch;
  const next = {
    ...current,
    ...restPatch,
    subject,
    handled_candidates: trimPresenceHandledMap(mergedCandidates),
    updated_at: nowIso(),
  };
  writeJsonFile(channelPresenceStatePath(root, subject), next);
  return next;
}

export function markExpressionCandidateHandled(root, subject, candidateId, meta = {}) {
  if (!candidateId) return readPresenceState(root, subject);
  return writePresenceState(root, subject, {
    handled_candidates: {
      [candidateId]: { handled_at: nowIso(), ...meta },
    },
  });
}

export function markExpressionCandidatesHandled(root, subject, candidateIds, meta = {}) {
  if (!candidateIds?.length) return readPresenceState(root, subject);
  const patch = {};
  for (const id of candidateIds) {
    if (id) patch[id] = { handled_at: nowIso(), ...meta };
  }
  return writePresenceState(root, subject, { handled_candidates: patch });
}
