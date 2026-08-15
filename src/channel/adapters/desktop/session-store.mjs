import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  channelDirForSubject,
  channelDesktopSessionPath,
  channelDesktopSessionsDir,
} from '../../paths.mjs';
import { nowIso } from '../../types.mjs';
import { normalizeDesktopSessionId } from './config.mjs';

export const DESKTOP_SESSION_SCHEMA_VERSION = 1;
const INDEX_SCHEMA_VERSION = 1;
const INDEX_CHUNK_BYTES = 64 * 1024;

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

function sessionIndexPaths(root, subject, sessionId) {
  const dir = join(channelDirForSubject(root, subject), 'desktop', 'session-index', sessionId);
  return {
    dir,
    metadata: join(dir, 'metadata.json'),
    offsets: join(dir, 'offsets.bin'),
    ids: join(dir, 'ids'),
  };
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function readMetadata(paths) {
  try {
    const value = JSON.parse(readFileSync(paths.metadata, 'utf8'));
    return value?.schema_version === INDEX_SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function writeMetadata(paths, metadata) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.metadata, `${JSON.stringify(metadata)}\n`, 'utf8');
}

function bucketPath(paths, id) {
  const prefix = createHash('sha256').update(id).digest('hex').slice(0, 2);
  return join(paths.ids, `${prefix}.jsonl`);
}

function readBucket(paths, id) {
  const file = bucketPath(paths, id);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function findIndexedId(paths, id) {
  return readBucket(paths, id).find((entry) => entry.id === id) ?? null;
}

function appendIndexEntry(paths, id, logicalOffset, byteOffset) {
  mkdirSync(paths.ids, { recursive: true });
  const offsetBuffer = Buffer.allocUnsafe(8);
  offsetBuffer.writeBigUInt64LE(BigInt(byteOffset));
  appendFileSync(paths.offsets, offsetBuffer);
  appendFileSync(
    bucketPath(paths, id),
    `${JSON.stringify({ id, offset: logicalOffset, byte_offset: byteOffset })}\n`,
    'utf8',
  );
}

function appendIndexBatch(paths, offsets, bucketAppends) {
  if (offsets.length) {
    mkdirSync(paths.ids, { recursive: true });
    const buffer = Buffer.allocUnsafe(offsets.length * 8);
    offsets.forEach((offset, index) => {
      buffer.writeBigUInt64LE(BigInt(offset), index * 8);
    });
    appendFileSync(paths.offsets, buffer);
  }
  for (const [file, entries] of bucketAppends) {
    appendFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }
}

function resetIndex(paths, identity) {
  rmSync(paths.dir, { recursive: true, force: true });
  mkdirSync(paths.ids, { recursive: true });
  writeFileSync(paths.offsets, Buffer.alloc(0));
  const metadata = {
    schema_version: INDEX_SCHEMA_VERSION,
    identity,
    scanned_size: 0,
    total: 0,
  };
  writeMetadata(paths, metadata);
  return metadata;
}

function reconcileSessionIndex(root, subject, sessionId, file) {
  const paths = sessionIndexPaths(root, subject, sessionId);
  if (!existsSync(file)) {
    return {
      paths,
      metadata: {
        schema_version: INDEX_SCHEMA_VERSION,
        identity: null,
        scanned_size: 0,
        total: 0,
      },
    };
  }
  const stat = statSync(file);
  const identity = fileIdentity(stat);
  let metadata = readMetadata(paths);
  if (
    !metadata
    || metadata.identity !== identity
    || stat.size < Number(metadata.scanned_size ?? 0)
    || !existsSync(paths.offsets)
    || !existsSync(paths.ids)
    || (existsSync(paths.offsets) && statSync(paths.offsets).size !== Number(metadata.total ?? 0) * 8)
  ) {
    metadata = resetIndex(paths, identity);
  }
  if (stat.size <= metadata.scanned_size) return { paths, metadata };

  const bucketSets = new Map();
  const indexedOffsets = [];
  const bucketAppends = new Map();
  const fd = openSync(file, 'r');
  let position = Number(metadata.scanned_size);
  let partial = Buffer.alloc(0);
  let partialStart = position;
  try {
    while (position < stat.size) {
      const length = Math.min(INDEX_CHUNK_BYTES, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = partial.length
        ? Buffer.concat([partial, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const dataStart = partialStart;
      let cursor = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const lineStart = dataStart + cursor;
        const line = data.subarray(cursor, newline).toString('utf8').trim();
        cursor = newline + 1;
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          const id = String(record?.id ?? '').trim();
          if (!id) continue;
          const bucket = bucketPath(paths, id);
          let seen = bucketSets.get(bucket);
          if (!seen) {
            seen = new Set(readBucket(paths, id).map((entry) => entry.id));
            bucketSets.set(bucket, seen);
          }
          if (seen.has(id)) continue;
          seen.add(id);
          indexedOffsets.push(lineStart);
          const entries = bucketAppends.get(bucket) ?? [];
          entries.push({ id, offset: metadata.total, byte_offset: lineStart });
          bucketAppends.set(bucket, entries);
          metadata.total += 1;
        } catch {
          // Malformed complete records are skipped without blocking later lines.
        }
      }
      partial = data.subarray(cursor);
      partialStart = dataStart + cursor;
    }
  } finally {
    closeSync(fd);
  }
  appendIndexBatch(paths, indexedOffsets, bucketAppends);
  metadata.scanned_size = partialStart;
  metadata.identity = identity;
  writeMetadata(paths, metadata);
  return { paths, metadata };
}

function readIndexedOffset(paths, logicalOffset) {
  const buffer = Buffer.allocUnsafe(8);
  const fd = openSync(paths.offsets, 'r');
  try {
    const bytesRead = readSync(fd, buffer, 0, 8, logicalOffset * 8);
    return bytesRead === 8 ? Number(buffer.readBigUInt64LE()) : null;
  } finally {
    closeSync(fd);
  }
}

function readIndexedRecord(file, paths, metadata, logicalOffset) {
  if (logicalOffset < 0 || logicalOffset >= metadata.total) return null;
  const start = readIndexedOffset(paths, logicalOffset);
  const next = logicalOffset + 1 < metadata.total
    ? readIndexedOffset(paths, logicalOffset + 1)
    : metadata.scanned_size;
  if (start == null || next == null || next <= start) return null;
  const buffer = Buffer.allocUnsafe(next - start);
  const fd = openSync(file, 'r');
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const newline = buffer.indexOf(0x0a, 0);
    const text = buffer.subarray(0, newline < 0 ? bytesRead : newline).toString('utf8').trim();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
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
    const createdAt = input.created_at ?? nowIso();
    const base = {
      ...input,
      schema_version: DESKTOP_SESSION_SCHEMA_VERSION,
      session_id: sessionId,
      target: `desktop:${sessionId}`,
      created_at: createdAt,
    };
    const id = stableRecordId(base);
    const { paths, metadata } = reconcileSessionIndex(root, subject, sessionId, file);
    const duplicate = findIndexedId(paths, id);
    if (duplicate) {
      const record = readIndexedRecord(file, paths, metadata, duplicate.offset);
      return { file, record, created: false, duplicate: true };
    }
    const byteOffset = statSync(file).size;
    const record = {
      ...base,
      id,
      offset: metadata.total,
    };
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(file, line, 'utf-8');
    appendIndexEntry(paths, id, metadata.total, byteOffset);
    metadata.total += 1;
    metadata.scanned_size = byteOffset + Buffer.byteLength(line);
    metadata.identity = fileIdentity(statSync(file));
    writeMetadata(paths, metadata);
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
  const release = existsSync(file) ? lockSessionFile(file) : null;
  try {
    const { paths, metadata } = reconcileSessionIndex(root, subject, sessionId, file);
    const start = Math.max(0, Number(offset) || 0);
    const boundedLimit = Math.max(0, Math.min(1000, Number(limit) || 50));
    const tailCount = tail == null ? null : Math.max(0, Math.min(1000, Number(tail) || 0));
    const selectedOffset = tailCount == null ? start : Math.max(start, metadata.total - tailCount);
    const end = tailCount == null
      ? Math.min(metadata.total, selectedOffset + boundedLimit)
      : metadata.total;
    const selected = [];
    for (let logicalOffset = selectedOffset; logicalOffset < end; logicalOffset += 1) {
      const record = readIndexedRecord(file, paths, metadata, logicalOffset);
      if (record) selected.push(record);
    }
    const nextOffset = selected.length
      ? Math.min(metadata.total, selectedOffset + selected.length)
      : Math.min(start, metadata.total);
    return {
      schema_version: DESKTOP_SESSION_SCHEMA_VERSION,
      subject,
      session_id: sessionId,
      records: selected,
      offset: selectedOffset,
      next_offset: nextOffset,
      total: metadata.total,
    };
  } finally {
    release?.();
  }
}

export function listDesktopSessions(root, subject) {
  const dir = channelDesktopSessionsDir(root, subject);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
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
  const digest = createHash('sha256').update(String(messageId)).digest();
  const lockId = String(digest[0] % 64).padStart(2, '0');
  const file = join(
    channelDirForSubject(root, subject),
    'desktop',
    'ingress-locks',
    `shard-${lockId}.lock`,
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
