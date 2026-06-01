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
