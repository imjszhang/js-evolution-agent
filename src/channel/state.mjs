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
import { nowIso } from './types.mjs';
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

export function listPendingInbound(root, subject, { limit = 20 } = {}) {
  return listJsonFiles(channelInboundPendingDir(root, subject)).slice(0, Math.max(0, limit));
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
  const file = join(dir, `${timestampForFilename()}-${key}.json`);
  writeFileSync(file, JSON.stringify(message, null, 2), 'utf-8');
  return { file, message };
}

export function listOutboxPending(root, subject, { limit = 20 } = {}) {
  return listJsonFiles(channelOutboxPendingDir(root, subject)).slice(0, Math.max(0, limit));
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
  handled_messages: {},
  handled_signals: {},
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
    handled_messages: { ...(raw.handled_messages ?? {}) },
    handled_signals: { ...(raw.handled_signals ?? {}) },
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

export function buildPresenceSignalKey(signal) {
  if (!signal || typeof signal !== 'object') return 'unknown';
  if (signal.key) return String(signal.key);
  const parts = [signal.type];
  if (signal.task_id) parts.push(signal.task_id);
  else if (signal.cycle_id) parts.push(signal.cycle_id);
  else if (signal.id) parts.push(signal.id);
  return parts.join(':');
}

export function isPresenceMessageHandled(root, subject, messageId) {
  if (!messageId) return false;
  return Boolean(readPresenceState(root, subject).handled_messages?.[messageId]);
}

export function isPresenceSignalHandled(root, subject, signalKey) {
  if (!signalKey) return false;
  return Boolean(readPresenceState(root, subject).handled_signals?.[signalKey]);
}

export function writePresenceState(root, subject, patch = {}) {
  const current = readPresenceState(root, subject);
  const mergedMessages = patch.handled_messages
    ? { ...current.handled_messages, ...patch.handled_messages }
    : current.handled_messages;
  const mergedSignals = patch.handled_signals
    ? { ...current.handled_signals, ...patch.handled_signals }
    : current.handled_signals;
  const { handled_messages: _hm, handled_signals: _hs, ...restPatch } = patch;
  const next = {
    ...current,
    ...restPatch,
    subject,
    handled_messages: trimPresenceHandledMap(mergedMessages),
    handled_signals: trimPresenceHandledMap(mergedSignals),
    updated_at: nowIso(),
  };
  writeJsonFile(channelPresenceStatePath(root, subject), next);
  return next;
}

export function markPresenceMessageHandled(root, subject, messageId, meta = {}) {
  if (!messageId) return readPresenceState(root, subject);
  return writePresenceState(root, subject, {
    handled_messages: {
      [messageId]: { handled_at: nowIso(), ...meta },
    },
  });
}

export function markPresenceSignalHandled(root, subject, signalKey, meta = {}) {
  if (!signalKey) return readPresenceState(root, subject);
  return writePresenceState(root, subject, {
    handled_signals: {
      [signalKey]: { handled_at: nowIso(), ...meta },
    },
  });
}

export function markPresenceMessagesHandled(root, subject, messageIds, meta = {}) {
  if (!messageIds?.length) return readPresenceState(root, subject);
  const patch = {};
  for (const id of messageIds) {
    if (id) patch[id] = { handled_at: nowIso(), ...meta };
  }
  return writePresenceState(root, subject, { handled_messages: patch });
}

export function markPresenceSignalsHandled(root, subject, signalKeys, meta = {}) {
  if (!signalKeys?.length) return readPresenceState(root, subject);
  const patch = {};
  for (const key of signalKeys) {
    if (key) patch[key] = { handled_at: nowIso(), ...meta };
  }
  return writePresenceState(root, subject, { handled_signals: patch });
}
