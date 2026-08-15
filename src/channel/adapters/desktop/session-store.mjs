import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import lockfile from 'proper-lockfile';
import {
  channelDirForSubject,
  channelDesktopSessionPath,
  channelDesktopSessionsDir,
} from '../../paths.mjs';
import { nowIso } from '../../types.mjs';
import { normalizeDesktopSessionId } from './config.mjs';

export const DESKTOP_SESSION_SCHEMA_VERSION = 1;
const sessionReadCache = new Map();
const MAX_SESSION_CACHE_ENTRIES = 100;
const MAX_SESSION_CACHE_BYTES = 16 * 1024 * 1024;

function trimSessionReadCache(protectedFile = null) {
  let bytes = [...sessionReadCache.values()]
    .reduce((sum, entry) => sum + entry.size, 0);
  const oldestFirst = [...sessionReadCache.entries()]
    .filter(([file]) => file !== protectedFile)
    .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
  while (
    sessionReadCache.size > MAX_SESSION_CACHE_ENTRIES
    || bytes > MAX_SESSION_CACHE_BYTES
  ) {
    const [file, entry] = oldestFirst.shift() ?? [];
    if (!file) break;
    sessionReadCache.delete(file);
    bytes -= entry.size;
  }
}

function stableRecordId(input) {
  const explicit = String(input.id ?? input.message_id ?? input.messageId ?? '').trim();
  if (explicit) return explicit;
  const material = JSON.stringify({
    session_id: input.session_id,
    direction: input.direction,
    role: input.role,
    content: input.content,
    created_at: input.created_at,
    idempotency_key: input.idempotency_key ?? null,
  });
  return `desktop-${createHash('sha256').update(material).digest('hex').slice(0, 24)}`;
}

function parseRecords(file) {
  if (!existsSync(file)) {
    sessionReadCache.delete(file);
    return [];
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    sessionReadCache.delete(file);
    return [];
  }
  const identity = `${stat.dev}:${stat.ino}`;
  let cached = sessionReadCache.get(file);
  if (!cached || cached.identity !== identity || stat.size < cached.size) {
    cached = {
      identity,
      size: 0,
      partial: '',
      decoder: new StringDecoder('utf8'),
      physicalOffset: 0,
      records: [],
      uniqueRecords: [],
      seenIds: new Set(),
      lastAccess: Date.now(),
    };
  }
  cached.lastAccess = Date.now();
  if (stat.size > cached.size) {
    const length = stat.size - cached.size;
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(file, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, length, cached.size);
    } finally {
      closeSync(fd);
    }
    cached.size += bytesRead;
    cached.partial += cached.decoder.write(buffer.subarray(0, bytesRead));
    const lines = cached.partial.split(/\r?\n/);
    cached.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const physicalOffset = cached.physicalOffset;
      cached.physicalOffset += 1;
      try {
        const record = { ...JSON.parse(line), _physical_offset: physicalOffset };
        cached.records.push(record);
        const id = String(record.id ?? '').trim();
        if (id && !cached.seenIds.has(id)) {
          cached.seenIds.add(id);
          const { _physical_offset: _, ...value } = record;
          cached.uniqueRecords.push(value);
        }
      } catch {
        // Preserve physical offsets while ignoring malformed records.
      }
    }
  }
  sessionReadCache.set(file, cached);
  trimSessionReadCache(file);
  return cached.records;
}

function readUniqueRecords(file) {
  parseRecords(file);
  return sessionReadCache.get(file)?.uniqueRecords ?? [];
}

function lockSessionFile(file) {
  let lastError = null;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return lockfile.lockSync(file, { realpath: false });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ELOCKED' || attempt === 5) throw error;
      Atomics.wait(sleeper, 0, 0, 10 * (attempt + 1));
    }
  }
  throw lastError;
}

export function appendDesktopSessionRecord(root, subject, sessionIdInput, input = {}) {
  const sessionId = normalizeDesktopSessionId(sessionIdInput);
  const file = channelDesktopSessionPath(root, subject, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, '', 'utf-8');
  const release = lockSessionFile(file);
  try {
    const existing = parseRecords(file);
    const createdAt = input.created_at ?? nowIso();
    const base = {
      ...input,
      schema_version: DESKTOP_SESSION_SCHEMA_VERSION,
      session_id: sessionId,
      target: `desktop:${sessionId}`,
      created_at: createdAt,
    };
    const id = stableRecordId(base);
    const duplicate = existing.find((record) => record.id === id);
    if (duplicate) {
      const { _physical_offset: _, ...record } = duplicate;
      return { file, record, created: false, duplicate: true };
    }
    const record = {
      ...base,
      id,
      offset: existing.length,
    };
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
    return { file, record, created: true, duplicate: false };
  } finally {
    release();
  }
}

export function readDesktopSession(root, subject, sessionIdInput, {
  offset = 0,
  limit = 50,
  tail = null,
} = {}) {
  const sessionId = normalizeDesktopSessionId(sessionIdInput);
  const file = channelDesktopSessionPath(root, subject, sessionId);
  const records = readUniqueRecords(file);
  const start = Math.max(0, Number(offset) || 0);
  const boundedLimit = Math.max(0, Math.min(1000, Number(limit) || 50));
  const tailCount = tail == null ? null : Math.max(0, Math.min(1000, Number(tail) || 0));
  const selectedOffset = tailCount == null ? start : Math.max(start, records.length - tailCount);
  const selected = tailCount == null
    ? records.slice(selectedOffset, selectedOffset + boundedLimit)
    : records.slice(selectedOffset);
  const nextOffset = selected.length
    ? Math.min(records.length, selectedOffset + selected.length)
    : Math.min(start, records.length);
  return {
    schema_version: DESKTOP_SESSION_SCHEMA_VERSION,
    subject,
    session_id: sessionId,
    records: selected,
    offset: selectedOffset,
    next_offset: nextOffset,
    total: records.length,
  };
}

export function listDesktopSessions(root, subject) {
  const dir = channelDesktopSessionsDir(root, subject);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const liveFiles = new Set(names.map((name) => channelDesktopSessionPath(
    root,
    subject,
    name.slice(0, -'.jsonl'.length),
  )));
  for (const file of sessionReadCache.keys()) {
    if (dirname(file) === dir && !liveFiles.has(file)) sessionReadCache.delete(file);
  }
  return names.map((name) => {
      const sessionId = name.slice(0, -'.jsonl'.length);
      const view = readDesktopSession(root, subject, sessionId, { tail: 1 });
      return {
        session_id: sessionId,
        target: `desktop:${sessionId}`,
        message_count: view.total,
        last_message_at: view.records[0]?.created_at ?? null,
      };
    });
}

export function withDesktopIngressLock(root, subject, messageId, callback) {
  const lockId = createHash('sha256').update(String(messageId)).digest('hex').slice(0, 32);
  const file = join(
    channelDirForSubject(root, subject),
    'desktop',
    'ingress-locks',
    `${lockId}.lock`,
  );
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, '', 'utf8');
  const release = lockSessionFile(file);
  try {
    return callback();
  } finally {
    release();
  }
}
