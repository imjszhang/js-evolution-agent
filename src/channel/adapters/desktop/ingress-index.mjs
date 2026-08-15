import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  channelDirForSubject,
  channelInboundFailedDir,
  channelInboundPendingDir,
  channelInboundProcessedDir,
} from '../../paths.mjs';
import { readJsonFile } from '../../state.mjs';
import { nowIso } from '../../types.mjs';
import { sessionIdFromDesktopTarget } from './config.mjs';

const INDEX_SCHEMA_VERSION = 1;
const SHARD_COUNT = 64;

function safeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-');
}

function indexDir(root, subject) {
  return join(channelDirForSubject(root, subject), 'desktop', 'ingress-index');
}

function metadataPath(root, subject) {
  return join(indexDir(root, subject), 'metadata.json');
}

function shardPath(root, subject, messageId) {
  const digest = createHash('sha256').update(String(messageId)).digest();
  const shard = String(digest[0] % SHARD_COUNT).padStart(2, '0');
  return join(indexDir(root, subject), `shard-${shard}.jsonl`);
}

function readMetadata(root, subject) {
  try {
    const value = JSON.parse(readFileSync(metadataPath(root, subject), 'utf8'));
    return value?.schema_version === INDEX_SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

function writeMetadata(root, subject, metadata) {
  const dir = indexDir(root, subject);
  mkdirSync(dir, { recursive: true });
  writeFileSync(metadataPath(root, subject), `${JSON.stringify(metadata)}\n`, 'utf8');
}

function parseShard(file) {
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

function extractMessageId(file, payload) {
  const explicit = payload?.message_id
    ?? payload?.messageId
    ?? payload?.envelope?.message_id
    ?? payload?.envelope?.messageId
    ?? null;
  if (explicit) return String(explicit);
  const name = String(file).split('/').pop() ?? '';
  const match = name.match(/-([A-Za-z0-9._-]+)\.json$/);
  return match?.[1] ?? null;
}

function extractSessionId(payload) {
  const envelope = payload?.envelope ?? payload ?? {};
  return envelope.metadata?.session_id
    ?? envelope.session_id
    ?? (String(envelope.chat_id ?? '').startsWith('desktop:')
      ? sessionIdFromDesktopTarget(envelope.chat_id)
      : null);
}

function lookupInShard(root, subject, messageId) {
  const entries = parseShard(shardPath(root, subject, messageId))
    .filter((entry) => String(entry.message_id) === String(messageId));
  return entries.at(-1) ?? null;
}

function scanInboundDirs(root, subject) {
  const found = [];
  for (const [status, dir] of [
    ['pending', channelInboundPendingDir(root, subject)],
    ['processed', channelInboundProcessedDir(root, subject)],
    ['failed', channelInboundFailedDir(root, subject)],
  ]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      const payload = readJsonFile(file, null);
      const messageId = extractMessageId(file, payload);
      if (!messageId) continue;
      found.push({
        message_id: messageId,
        session_id: extractSessionId(payload),
        status,
        file,
        recorded_at: nowIso(),
      });
    }
  }
  return found;
}

function rebuildIngressIndex(root, subject) {
  const dir = indexDir(root, subject);
  mkdirSync(dir, { recursive: true });
  const groups = new Map();
  for (const entry of scanInboundDirs(root, subject)) {
    const file = shardPath(root, subject, entry.message_id);
    const rows = groups.get(file) ?? [];
    rows.push(entry);
    groups.set(file, rows);
  }
  for (const [file, rows] of groups) {
    writeFileSync(file, `${rows.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }
  writeMetadata(root, subject, {
    schema_version: INDEX_SCHEMA_VERSION,
    rebuilt_at: nowIso(),
  });
}

export function recordDesktopIngress(root, subject, {
  message_id,
  session_id = null,
  status = 'pending',
  file = null,
} = {}) {
  if (!message_id) return null;
  const entry = {
    message_id: String(message_id),
    session_id,
    status,
    file,
    recorded_at: nowIso(),
  };
  const path = shardPath(root, subject, entry.message_id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

export function findDesktopIngress(root, subject, messageId) {
  if (!messageId) return null;
  if (!readMetadata(root, subject)) rebuildIngressIndex(root, subject);
  return lookupInShard(root, subject, messageId);
}

export function inboundFilenameMatches(file, messageId) {
  const safe = safeFilenamePart(messageId);
  return String(file).endsWith(`-${safe}.json`);
}
