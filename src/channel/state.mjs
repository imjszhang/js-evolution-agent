import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonSafe, writeJsonFile } from '../infra/files.mjs';
import {
  readJson,
  updateJson,
} from '../infra/json-store.mjs';
import { getChannelEvent } from './event-queue.mjs';
import { nowIso } from './types.mjs';
import {
  handleContractValidation,
  validateChannelEnvelope,
} from '../contracts/index.mjs';
import { redactSecrets } from '../intelligence/redaction.mjs';

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
  channelPresenceHandledIndexPath,
  channelPresenceStatePath,
  channelProcessedIndexPath,
  channelEventsPath,
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

export function listInboundProcessed(root, subject) {
  return listJsonFiles(channelInboundProcessedDir(root, subject));
}

function compactProcessedPayload(file, payload) {
  if (!payload?.envelope) return null;
  return {
    processed_file: file,
    message_id: payload.envelope.message_id ?? null,
    channel: payload.envelope.channel ?? null,
    chat_id: payload.envelope.chat_id ?? null,
    content: String(payload.envelope.content ?? '').slice(0, 500),
    ingest_kind: payload.ingest_result?.kind ?? null,
    brief_kind: payload.ingest_result?.brief?.kind ?? null,
    brief_id: payload.ingest_result?.brief?.id ?? null,
    understanding: payload.classifier?.understanding
      ?? payload.ingest_result?.brief?.metadata?.understanding
      ?? payload.ingest_result?.record?.metadata?.understanding
      ?? null,
  };
}

export function readInboundProcessedIndex(root, subject) {
  const raw = readJson(channelProcessedIndexPath(root, subject), { entries: [] });
  return {
    schema_version: raw?.schema_version ?? null,
    entries: Array.isArray(raw?.entries) ? raw.entries : [],
    invalid_tombstones: Array.isArray(raw?.invalid_tombstones) ? raw.invalid_tombstones : [],
    scan: {
      directory_mtime_ms: raw?.scan?.directory_mtime_ms ?? null,
      pending_files: Array.isArray(raw?.scan?.pending_files) ? raw.scan.pending_files : [],
    },
    updated_at: raw?.updated_at ?? null,
  };
}

function processedDirectoryMtime(root, subject) {
  try {
    return statSync(channelInboundProcessedDir(root, subject)).mtimeMs;
  } catch {
    return null;
  }
}

function processedIndexDocument(current, patch = {}) {
  return {
    schema_version: 2,
    entries: patch.entries ?? current.entries,
    invalid_tombstones: patch.invalid_tombstones ?? current.invalid_tombstones,
    scan: patch.scan ?? current.scan,
    updated_at: nowIso(),
  };
}

function insertProcessedEntry(entries, entry) {
  const next = [...entries];
  let low = 0;
  let high = next.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (String(next[mid].processed_file).localeCompare(String(entry.processed_file)) < 0) low = mid + 1;
    else high = mid;
  }
  if (next[low]?.processed_file === entry.processed_file) next[low] = entry;
  else next.splice(low, 0, entry);
  return next;
}

export function reconcileInboundProcessedIndex(root, subject, { maxFiles = 128 } = {}) {
  let current = readInboundProcessedIndex(root, subject);
  const legacyDetected = current.schema_version != null && current.schema_version < 2;
  const directoryMtime = processedDirectoryMtime(root, subject);
  let directoryListed = false;
  if (
    current.scan.directory_mtime_ms !== directoryMtime
    || (current.scan.directory_mtime_ms == null && directoryMtime != null)
  ) {
    const files = listInboundProcessed(root, subject);
    const known = new Set([
      ...current.entries.map((entry) => entry.processed_file),
      ...current.invalid_tombstones.map((entry) => entry.processed_file),
    ]);
    const pendingFiles = files.filter((file) => !known.has(file));
    current = {
      ...current,
      scan: {
        directory_mtime_ms: directoryMtime,
        pending_files: pendingFiles,
      },
    };
    writeJsonFile(channelProcessedIndexPath(root, subject), processedIndexDocument(current));
    directoryListed = true;
  }

  const pending = [...current.scan.pending_files];
  let entries = current.entries;
  const tombstones = [...current.invalid_tombstones];
  const additions = [];
  let filesExamined = 0;
  const validBudget = Math.max(0, maxFiles);
  while (pending.length && additions.length < validBudget) {
    const file = pending.shift();
    filesExamined += 1;
    const entry = compactProcessedPayload(file, readJsonFile(file));
    if (entry) {
      additions.push(entry);
      entries = insertProcessedEntry(entries, entry);
    } else {
      tombstones.push({
        processed_file: file,
        reason: 'invalid_or_missing_envelope',
        tombstoned_at: nowIso(),
      });
    }
  }

  if (filesExamined > 0) {
    current = {
      ...current,
      entries,
      invalid_tombstones: tombstones,
      scan: { ...current.scan, pending_files: pending },
    };
    writeJsonFile(channelProcessedIndexPath(root, subject), processedIndexDocument(current));
  }
  const totalFiles = entries.length + tombstones.length + pending.length;
  return {
    entries,
    total_files: totalFiles,
    indexed_total: entries.length,
    files_parsed: additions.length,
    files_examined: filesExamined,
    invalid_tombstones: tombstones.length,
    directory_listed: directoryListed,
    legacy_index_detected: legacyDetected,
    scan_complete: pending.length === 0,
  };
}

export function markInboundProcessed(root, subject, file, payload = null) {
  const dir = ensureDir(channelInboundProcessedDir(root, subject));
  const target = join(dir, `${timestampForFilename()}-${basename(file)}`);
  if (payload) writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(file, target);
  const stored = payload ?? readJsonFile(target);
  const entry = compactProcessedPayload(target, stored);
  if (entry) {
    updateJson(channelProcessedIndexPath(root, subject), (raw) => {
      const current = {
        entries: Array.isArray(raw?.entries) ? raw.entries : [],
        invalid_tombstones: Array.isArray(raw?.invalid_tombstones) ? raw.invalid_tombstones : [],
        scan: {
          directory_mtime_ms: processedDirectoryMtime(root, subject),
          pending_files: Array.isArray(raw?.scan?.pending_files)
            ? raw.scan.pending_files.filter((item) => item !== target)
            : [],
        },
      };
      return processedIndexDocument(current, {
        entries: insertProcessedEntry(current.entries, entry),
      });
    }, { fallback: { schema_version: 2, entries: [], invalid_tombstones: [], scan: {} } });
  }
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
  const data = readJson(channelDedupPath(root, subject), { seen: {} });
  return data && typeof data === 'object' && data.seen ? data : { seen: {} };
}

export function hasSeenMessage(root, subject, messageId) {
  if (!messageId) return false;
  return Boolean(readDedup(root, subject).seen?.[messageId]);
}

export function markMessageSeen(root, subject, messageId, meta = {}) {
  if (!messageId) return null;
  let seen = null;
  updateJson(channelDedupPath(root, subject), (raw) => {
    const state = raw && typeof raw === 'object' && raw.seen ? raw : { seen: {} };
    state.seen[messageId] = {
      first_seen_at: state.seen[messageId]?.first_seen_at ?? nowIso(),
      last_seen_at: nowIso(),
      ...meta,
    };
    seen = state.seen[messageId];
    return state;
  }, { fallback: { seen: {} } });
  return seen;
}

export function readCooldown(root, subject) {
  const data = readJson(channelCooldownPath(root, subject), { keys: {} });
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
  let value = null;
  updateJson(channelCooldownPath(root, subject), (raw) => {
    const state = raw && typeof raw === 'object' && raw.keys ? raw : { keys: {} };
    state.keys[key] = {
      until: new Date(Date.now() + ttlMs).toISOString(),
      updated_at: nowIso(),
      ...meta,
    };
    value = state.keys[key];
    return state;
  }, { fallback: { keys: {} } });
  return value;
}

export function writeOutboxMessage(root, subject, message) {
  const safeMessage = redactSecrets(message);
  handleContractValidation('channel_envelope', validateChannelEnvelope({
    id: safeMessage.id ?? safeMessage.idempotency_key ?? 'outbox-unknown',
    subject,
    text: safeMessage.text ?? safeMessage.outbound?.text ?? null,
    target: safeMessage.target ?? safeMessage.outbound?.target ?? null,
    meta: safeMessage.metadata ?? safeMessage.meta ?? null,
  }));
  const dir = ensureDir(channelOutboxPendingDir(root, subject));
  const key = safeFilenamePart(safeMessage.idempotency_key ?? safeMessage.id ?? randomUUID());
  const existing = findOutboxByIdempotencyKey(root, subject, safeMessage.idempotency_key);
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
  writeFileSync(file, JSON.stringify(safeMessage, null, 2), 'utf-8');
  return { file, message: safeMessage, created: true, duplicate: false };
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
    ['sent', channelOutboxSentDir(root, subject)],
    ['pending', channelOutboxPendingDir(root, subject)],
    ['failed', channelOutboxFailedDir(root, subject)],
  ]) {
    for (const file of listJsonFiles(dir).reverse()) {
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
    outbound_reason: payload.reason ?? payload.outbound_reason ?? null,
    reason,
  }, null, 2), 'utf-8');
  renameSync(file, target);
  return target;
}

export function requeueOutboxFailed(root, subject, file, {
  retryAttempt = 1,
} = {}) {
  const payload = readJsonFile(file);
  if (!payload) return { requeued: false, reason: 'failed_record_missing', file: null };
  const idempotencyKey = outboxPayloadIdempotencyKey(payload);
  if (!idempotencyKey) return { requeued: false, reason: 'idempotency_key_missing', file: null };

  const existing = findOutboxByIdempotencyKey(root, subject, idempotencyKey);
  if (existing?.status === 'sent') {
    return { requeued: false, reason: 'already_sent', file: existing.file, status: 'sent' };
  }
  if (existing?.status === 'pending') {
    return { requeued: false, reason: 'already_pending', file: existing.file, status: 'pending' };
  }

  const pendingDir = ensureDir(channelOutboxPendingDir(root, subject));
  const pendingFile = join(
    pendingDir,
    `${timestampForFilename()}-retry-${safeFilenamePart(idempotencyKey)}.json`,
  );
  const {
    failed_at: _failedAt,
    reason: _failureReason,
    outbound_reason: outboundReason,
    retry_scheduled_at: _retryScheduledAt,
    retry_attempt: _retryAttempt,
    retry_pending_file: _retryPendingFile,
    ...outbound
  } = payload;
  writeFileSync(pendingFile, JSON.stringify({
    ...outbound,
    ...(outboundReason ? { reason: outboundReason } : {}),
  }, null, 2), 'utf-8');
  writeFileSync(file, JSON.stringify({
    ...payload,
    retry_scheduled_at: nowIso(),
    retry_attempt: Math.max(1, Number(retryAttempt) || 1),
    retry_pending_file: pendingFile,
  }, null, 2), 'utf-8');
  return {
    requeued: true,
    reason: 'requeued',
    file: pendingFile,
    failed_file: file,
    status: 'pending',
  };
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
  const raw = readJson(channelPresenceStatePath(root, subject), {});
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
  const pending = [
    ...(current.pending_speech_generation ?? []).filter((row) =>
      row.intent_id !== entry.intent_id && row.event_id !== entry.event_id),
    entry,
  ].slice(-50);
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
  return Boolean(readPresenceHandledIndex(root, subject)[candidateId]);
}

function handledCandidatesFromAudit(root, subject) {
  let text = '';
  try {
    text = readFileSync(channelEventsPath(root, subject), 'utf-8');
  } catch {
    return {};
  }
  const handled = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const ids = [
      event.type === 'channel_speech_generated' ? event.candidate_id : null,
      ...(['channel_expression_silenced', 'channel_deliverable_candidates_handled'].includes(event.type)
        ? (Array.isArray(event.candidate_ids) ? event.candidate_ids : [])
        : []),
    ].filter(Boolean);
    for (const candidateId of ids) {
      handled[candidateId] = {
        handled_at: event.recorded_at ?? null,
        outcome: event.type === 'channel_expression_silenced' ? 'silenced' : 'sent',
        migrated_from: 'channel_audit',
      };
    }
  }
  return handled;
}

function migratePresenceHandledIndex(
  root,
  subject,
  processedEntries = [],
  { allowConservativeMarker = false } = {},
) {
  const file = channelPresenceHandledIndexPath(root, subject);
  const existing = existsSync(file) ? readJson(file, { handled_candidates: {} }) : null;
  if (existing?.schema_version >= 2 && existing?.migration) return existing;
  const legacy = readJson(channelPresenceStatePath(root, subject), {});
  const legacyHandled = legacy?.handled_candidates ?? {};
  const auditHandled = handledCandidatesFromAudit(root, subject);
  const recovered = {
    ...(existing?.handled_candidates ?? {}),
    ...legacyHandled,
    ...auditHandled,
  };
  const upgradingLegacyIndex = Boolean(existing && (existing.schema_version ?? 1) < 2);
  const hasLegacyPresenceState = Object.keys(legacyHandled).length > 0
    || Boolean(legacy?.last_presence_tick_at || legacy?.last_spoken_at || legacy?.last_plan);
  const processedThrough = Object.keys(auditHandled).length === 0
    && (allowConservativeMarker || hasLegacyPresenceState || upgradingLegacyIndex)
    && processedEntries.length > 0
    ? processedEntries[processedEntries.length - 1]?.processed_file ?? null
    : null;
  const migration = {
    completed_at: nowIso(),
    source: Object.keys(auditHandled).length > 0
      ? 'channel_audit_and_legacy_state'
      : processedThrough
        ? 'conservative_processed_cursor'
        : 'legacy_state',
    recovered_count: Object.keys(recovered).length,
    conservative_processed_through: processedThrough,
  };
  const document = {
    schema_version: 2,
    subject,
    handled_candidates: recovered,
    migration,
    updated_at: nowIso(),
  };
  if (
    processedEntries.length === 0
    && Object.keys(recovered).length === 0
    && !hasLegacyPresenceState
    && !allowConservativeMarker
  ) {
    return document;
  }
  writeJsonFile(file, document);
  return document;
}

export function readPresenceHandledIndex(root, subject, {
  processedEntries = [],
  allowConservativeMarker = false,
} = {}) {
  const raw = migratePresenceHandledIndex(root, subject, processedEntries, {
    allowConservativeMarker,
  });
  const legacy = readJson(channelPresenceStatePath(root, subject), {});
  return {
    ...(legacy?.handled_candidates ?? {}),
    ...(raw?.handled_candidates ?? {}),
    ...(raw?.migration?.conservative_processed_through
      ? {
        __migration__: {
          processed_through: raw.migration.conservative_processed_through,
          completed_at: raw.migration.completed_at,
        },
      }
      : {}),
  };
}

function writePresenceHandledIndex(root, subject, patch) {
  return updateJson(channelPresenceHandledIndexPath(root, subject), (raw) => ({
    schema_version: 2,
    subject,
    handled_candidates: {
      ...(raw?.handled_candidates ?? {}),
      ...patch,
    },
    migration: raw?.migration ?? {
      completed_at: nowIso(),
      source: 'native_index',
      recovered_count: 0,
      conservative_processed_through: null,
    },
    updated_at: nowIso(),
  }), { fallback: { schema_version: 2, handled_candidates: {}, updated_at: null } });
}

export function writePresenceState(root, subject, patch = {}) {
  return updateJson(channelPresenceStatePath(root, subject), (raw) => {
    const current = {
      ...DEFAULT_PRESENCE_STATE,
      ...(raw ?? {}),
      handled_candidates: { ...(raw?.handled_candidates ?? {}) },
      reactor: {
        ...DEFAULT_REACTOR_STATE,
        ...(raw?.reactor ?? {}),
        event_ids: Array.isArray(raw?.reactor?.event_ids) ? [...raw.reactor.event_ids] : [],
      },
      pending_speech_generation: Array.isArray(raw?.pending_speech_generation)
        ? [...raw.pending_speech_generation]
        : [],
    };
    const mergedCandidates = patch.handled_candidates
      ? { ...current.handled_candidates, ...patch.handled_candidates }
      : current.handled_candidates;
    const { handled_candidates: _hc, ...restPatch } = patch;
    return {
      ...current,
      ...restPatch,
      subject,
      handled_candidates: trimPresenceHandledMap(mergedCandidates),
      updated_at: nowIso(),
    };
  }, { fallback: {} });
}

export function markExpressionCandidateHandled(root, subject, candidateId, meta = {}) {
  if (!candidateId) return readPresenceState(root, subject);
  const handled = { handled_at: nowIso(), ...meta };
  writePresenceHandledIndex(root, subject, { [candidateId]: handled });
  return writePresenceState(root, subject, {
    handled_candidates: {
      [candidateId]: handled,
    },
  });
}

export function markExpressionCandidatesHandled(root, subject, candidateIds, meta = {}) {
  if (!candidateIds?.length) return readPresenceState(root, subject);
  const patch = {};
  for (const id of candidateIds) {
    if (id) patch[id] = { handled_at: nowIso(), ...meta };
  }
  writePresenceHandledIndex(root, subject, patch);
  return writePresenceState(root, subject, { handled_candidates: patch });
}
