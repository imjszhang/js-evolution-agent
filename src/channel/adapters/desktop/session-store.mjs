import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  channelDesktopSessionPath,
  channelDesktopSessionsDir,
} from '../../paths.mjs';
import { nowIso } from '../../types.mjs';
import { normalizeDesktopSessionId } from './config.mjs';

export const DESKTOP_SESSION_SCHEMA_VERSION = 1;

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
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { ...JSON.parse(line), _physical_offset: index };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function uniqueRecords(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const id = String(record?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const { _physical_offset: _, ...value } = record;
    result.push(value);
  }
  return result;
}

export function appendDesktopSessionRecord(root, subject, sessionIdInput, input = {}) {
  const sessionId = normalizeDesktopSessionId(sessionIdInput);
  const file = channelDesktopSessionPath(root, subject, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, '', 'utf-8');
  const release = lockfile.lockSync(file, {
    realpath: false,
    retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
  });
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
  const records = uniqueRecords(parseRecords(file));
  const start = Math.max(0, Number(offset) || 0);
  const boundedLimit = Math.max(0, Math.min(1000, Number(limit) || 50));
  const tailCount = tail == null ? null : Math.max(0, Math.min(1000, Number(tail) || 0));
  const selectedOffset = tailCount == null ? start : Math.max(start, records.length - tailCount);
  const selected = tailCount == null
    ? records.slice(selectedOffset, selectedOffset + boundedLimit)
    : records.slice(selectedOffset);
  const nextOffset = selected.length
    ? Math.min(records.length, records.indexOf(selected[selected.length - 1]) + 1)
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
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
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
