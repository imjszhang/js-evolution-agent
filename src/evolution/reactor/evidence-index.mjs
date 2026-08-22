/**
 * Rebuildable incremental index over authoritative evidence stores.
 *
 * Historical compact entries live in an append-only journal. The JSON manifest
 * contains only per-source byte cursors, while each reactor keeps a small
 * consumed journal offset. Normal claims therefore inspect source tails and a
 * bounded pending window instead of rewriting or sorting all historical rows.
 */
import { createHash, randomUUID } from 'node:crypto';
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
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { withJsonLock, writeJson } from '../../infra/json-store.mjs';
import {
  STREAM_PATHS,
  projectEvidenceRecord,
} from '../../intelligence/evidence-stream.mjs';
import {
  defaultKindsForReactor,
  inferEvidenceProducer,
  isEligibleForReactor,
} from './eligibility.mjs';
import { reactorDir } from './paths.mjs';

export const EVIDENCE_INDEX_SCHEMA = 'evidence-index.v2';
export const EVIDENCE_CURSOR_SCHEMA = 'evidence-index-cursors.v1';
const JOURNAL_CHUNK_BYTES = 256 * 1024;

function increment(stats, key, amount = 1) {
  if (!stats) return;
  stats[key] = (stats[key] ?? 0) + amount;
}

function countIndexRead(stats, amount) {
  increment(stats, 'index_bytes_read', amount);
}

function countIndexWrite(stats, amount) {
  increment(stats, 'index_bytes_written', amount);
}

function emptyIndex() {
  return {
    schema_version: EVIDENCE_INDEX_SCHEMA,
    generation: null,
    sources: {},
    journal_size: 0,
    updated_at: null,
  };
}

function emptyCursorState() {
  return {
    schema_version: EVIDENCE_CURSOR_SCHEMA,
    reactors: {},
    updated_at: null,
  };
}

function listFiles(absDir, suffix) {
  if (!existsSync(absDir)) return [];
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function sourceDescriptors(dataRoot, kind) {
  const rel = STREAM_PATHS[kind];
  if (!rel) return [];
  if (kind === 'intel_observations') {
    return listFiles(join(dataRoot, rel), '.jsonl')
      .map((name) => ({ mode: 'jsonl', rel: join(rel, name).replace(/\\/g, '/') }));
  }
  if (
    kind === 'verify_reports'
    || kind === 'operator_briefs'
    || kind === 'operator_facts'
    || kind === 'operator_questions'
  ) {
    return [];
  }
  return [{ mode: 'jsonl', rel }];
}

function jsonDirectoryDescriptors(kind) {
  const rel = STREAM_PATHS[kind];
  if (!rel) return [];
  if (kind === 'verify_reports') {
    return [{ rel, idFromName: true, defaultType: null }];
  }
  const operatorSubdirs = kind === 'operator_briefs'
    ? [['pending', 'operator_brief'], ['processed', 'operator_brief']]
    : kind === 'operator_facts'
      ? [['pending', 'operator_fact'], ['digested', 'operator_fact']]
      : kind === 'operator_questions'
        ? [['pending', 'operator_question'], ['resolved', 'operator_question']]
        : null;
  return operatorSubdirs
    ? operatorSubdirs.map(([subdir, defaultType]) => ({
      rel: join(rel, subdir).replace(/\\/g, '/'),
      idFromName: false,
      defaultType,
    }))
    : [];
}

function fileState(absPath) {
  try {
    const stat = statSync(absPath);
    return {
      identity: `${stat.dev}:${stat.ino}`,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
      ctime_ms: stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

function compactEnvelope(envelope, locator) {
  return {
    id: envelope.id,
    kind: envelope.kind,
    type: envelope.type,
    occurred_at: envelope.occurred_at,
    evidence_key: envelope.evidence_key,
    producer: inferEvidenceProducer(envelope),
    producer_batch_id: envelope.producer_batch_id ?? null,
    activation_targets: envelope.activation_targets ?? null,
    provenance: envelope.provenance,
    cycle_id: envelope.cycle_id ?? null,
    subject: envelope.subject ?? null,
    locator,
  };
}

function readRange(absPath, start, length, stats, { index = false } = {}) {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(absPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    if (index) {
      countIndexRead(stats, read);
      increment(stats, 'index_files_read');
    } else {
      increment(stats, 'source_files_read');
      increment(stats, 'source_bytes_read', read);
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse only newline-terminated JSONL records. A torn final append remains
 * behind the source cursor and is retried after the writer completes it.
 */
function parseJsonlTail(dataRoot, descriptor, start, size, startIndex, stats) {
  if (size <= start) return { entries: [], cursor: start, row_count: startIndex };
  const buffer = readRange(join(dataRoot, descriptor.rel), start, size - start, stats);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    increment(stats, 'truncated_source_tails');
    return { entries: [], cursor: start, row_count: startIndex };
  }
  const entries = [];
  let lineStart = 0;
  let rowIndex = startIndex;
  while (lineStart <= lastNewline) {
    const newline = buffer.indexOf(0x0a, lineStart);
    if (newline < 0 || newline > lastNewline) break;
    let contentEnd = newline;
    if (contentEnd > lineStart && buffer[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const slice = buffer.subarray(lineStart, contentEnd);
    if (slice.length) {
      increment(stats, 'records_parsed');
      try {
        const record = JSON.parse(slice.toString('utf8'));
        const envelope = projectEvidenceRecord(descriptor.kind, record, {
          file: descriptor.rel,
          index: rowIndex,
        });
        entries.push(compactEnvelope(envelope, {
          mode: 'jsonl',
          file: descriptor.rel,
          offset: start + lineStart,
          length: contentEnd - lineStart,
          index: rowIndex,
        }));
      } catch {
        increment(stats, 'parse_errors');
      }
      rowIndex += 1;
    }
    lineStart = newline + 1;
  }
  return {
    entries,
    cursor: start + lastNewline + 1,
    row_count: rowIndex,
  };
}

function parseJsonFile(dataRoot, descriptor, stats) {
  increment(stats, 'source_files_read');
  const text = readFileSync(join(dataRoot, descriptor.rel), 'utf8');
  increment(stats, 'source_bytes_read', Buffer.byteLength(text));
  increment(stats, 'records_parsed');
  try {
    const record = JSON.parse(text);
    const envelope = projectEvidenceRecord(descriptor.kind, record, {
      file: descriptor.rel,
      id: descriptor.id ?? null,
      defaultType: descriptor.defaultType ?? null,
    });
    return [compactEnvelope(envelope, {
      mode: 'json',
      file: descriptor.rel,
      id: descriptor.id ?? null,
      default_type: descriptor.defaultType ?? null,
    })];
  } catch {
    increment(stats, 'parse_errors');
    return [];
  }
}

export function evidenceIndexPath(dataRoot) {
  return join(reactorDir(dataRoot), 'evidence-index.json');
}

export function evidenceIndexDir(dataRoot) {
  return join(reactorDir(dataRoot), 'evidence-index');
}

export function evidenceIndexJournalPath(dataRoot) {
  return join(evidenceIndexDir(dataRoot), 'entries.jsonl');
}

export function evidenceIndexCursorPath(dataRoot) {
  return join(evidenceIndexDir(dataRoot), 'cursors.json');
}

function keyDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function markerPath(dataRoot, category, key, reactor = null) {
  const digest = keyDigest(key);
  return join(
    evidenceIndexDir(dataRoot),
    category,
    ...(reactor ? [reactor] : []),
    digest.slice(0, 2),
    digest,
  );
}

function hasMarker(dataRoot, category, key, reactor = null) {
  return existsSync(markerPath(dataRoot, category, key, reactor));
}

function writeMarker(dataRoot, category, key, reactor = null) {
  const path = markerPath(dataRoot, category, key, reactor);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '', { flag: 'wx' });
}

function removeMarker(dataRoot, category, key, reactor = null) {
  rmSync(markerPath(dataRoot, category, key, reactor), { force: true });
}

function readJsonMeasured(path, fallback, stats, metric = 'index_manifest') {
  if (!existsSync(path)) return fallback;
  try {
    const text = readFileSync(path, 'utf8');
    countIndexRead(stats, Buffer.byteLength(text));
    increment(stats, `${metric}_bytes_read`, Buffer.byteLength(text));
    return JSON.parse(text);
  } catch {
    increment(stats, 'index_parse_errors');
    return fallback;
  }
}

function writeJsonMeasured(path, value, stats, metric = 'index_manifest') {
  const bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
  writeJson(path, value);
  countIndexWrite(stats, bytes);
  increment(stats, `${metric}_bytes_written`, bytes);
}

function normalizedIndex(raw) {
  if (raw?.schema_version !== EVIDENCE_INDEX_SCHEMA || !raw.sources || typeof raw.sources !== 'object') {
    return null;
  }
  return raw;
}

function sourceWasReset(prior, state) {
  if (!prior || !state) return false;
  return prior.identity !== state.identity
    || state.size < Number(prior.cursor ?? 0)
    || (
      state.size === Number(prior.size ?? 0)
      && state.mtime_ms !== prior.mtime_ms
    );
}

function clearIndexArtifacts(dataRoot) {
  rmSync(evidenceIndexDir(dataRoot), { recursive: true, force: true });
}

function repairJournalTail(dataRoot, stats) {
  const path = evidenceIndexJournalPath(dataRoot);
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  if (size === 0) return 0;
  const last = readRange(path, size - 1, 1, stats, { index: true });
  if (last[0] === 0x0a) return size;
  const start = Math.max(0, size - JOURNAL_CHUNK_BYTES);
  const tail = readRange(path, start, size - start, stats, { index: true });
  const newline = tail.lastIndexOf(0x0a);
  const repaired = newline < 0 ? 0 : start + newline + 1;
  truncateSync(path, repaired);
  increment(stats, 'truncated_journal_tails_repaired');
  return repaired;
}

function appendJournalEntries(dataRoot, entries, stats) {
  if (!entries.length) return;
  const path = evidenceIndexJournalPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  const body = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  appendFileSync(path, body, 'utf8');
  const bytes = Buffer.byteLength(body);
  countIndexWrite(stats, bytes);
  increment(stats, 'index_journal_bytes_written', bytes);
  increment(stats, 'index_entries_appended', entries.length);
  for (const entry of entries) writeMarker(dataRoot, 'keys', entry.evidence_key);
}

/**
 * Refresh source cursors and append only newly discovered compact entries.
 * A force, legacy schema, source rewrite, or missing journal causes a complete
 * sidecar rebuild from authoritative evidence.
 */
export function refreshEvidenceIndex(dataRoot, {
  kinds,
  force = false,
  stats = null,
} = {}) {
  const path = evidenceIndexPath(dataRoot);
  return withJsonLock(path, () => {
    const raw = readJsonMeasured(path, null, stats);
    let current = normalizedIndex(raw);
    let requested = [...new Set(kinds || Object.keys(STREAM_PATHS))];
    let rebuild = force || (raw != null && !current);
    if (
      current
      && Number(current.journal_size ?? 0) > 0
      && !existsSync(evidenceIndexJournalPath(dataRoot))
    ) {
      rebuild = true;
    }

    let descriptors = requested.flatMap((kind) => (
      sourceDescriptors(dataRoot, kind).map((descriptor) => ({ ...descriptor, kind }))
    ));
    if (!rebuild && current) {
      const resetFile = descriptors.some((descriptor) => {
        const prior = current.sources?.[descriptor.kind]?.files?.[descriptor.rel] ?? null;
        return sourceWasReset(prior, fileState(join(dataRoot, descriptor.rel)));
      });
      const resetDirectory = requested.some((kind) => (
        jsonDirectoryDescriptors(kind).some((directory) => {
          const prior = current.sources?.[kind]?.directories?.[directory.rel] ?? null;
          const state = fileState(join(dataRoot, directory.rel));
          return Boolean(prior && state && prior.identity !== state.identity);
        })
      ));
      rebuild = resetFile || resetDirectory;
    }
    if (rebuild) {
      clearIndexArtifacts(dataRoot);
      current = emptyIndex();
      requested = Object.keys(STREAM_PATHS);
      descriptors = requested.flatMap((kind) => (
        sourceDescriptors(dataRoot, kind).map((descriptor) => ({ ...descriptor, kind }))
      ));
      increment(stats, 'index_rebuilds');
    } else if (!current) {
      current = emptyIndex();
    }

    const repairedJournalSize = repairJournalTail(dataRoot, stats);
    const needsGeneration = !current.generation;
    const next = {
      schema_version: EVIDENCE_INDEX_SCHEMA,
      generation: rebuild || !current.generation ? randomUUID() : current.generation,
      sources: { ...current.sources },
      journal_size: repairedJournalSize,
      updated_at: current.updated_at,
    };
    const newEntries = [];
    const scannedJsonFiles = [];
    let changed = rebuild
      || raw == null
      || needsGeneration
      || repairedJournalSize !== Number(current.journal_size ?? 0);

    for (const kind of requested) {
      const kindDescriptors = descriptors.filter((descriptor) => descriptor.kind === kind);
      const previousFiles = current.sources?.[kind]?.files ?? {};
      const previousDirectories = current.sources?.[kind]?.directories ?? {};
      const files = {};
      const directories = {};
      for (const descriptor of kindDescriptors) {
        const state = fileState(join(dataRoot, descriptor.rel));
        if (!state) continue;
        const prior = previousFiles[descriptor.rel] ?? null;
        if (descriptor.mode === 'jsonl') {
          const start = rebuild ? 0 : Number(prior?.cursor ?? 0);
          const startIndex = rebuild ? 0 : Number(prior?.row_count ?? 0);
          const parsed = parseJsonlTail(
            dataRoot,
            descriptor,
            start,
            state.size,
            startIndex,
            stats,
          );
          files[descriptor.rel] = {
            ...state,
            cursor: parsed.cursor,
            row_count: parsed.row_count,
          };
          for (const entry of parsed.entries) {
            if (!hasMarker(dataRoot, 'keys', entry.evidence_key)) newEntries.push(entry);
          }
          if (parsed.cursor > start) {
            changed = true;
            increment(stats, prior ? 'source_files_incremental' : 'source_files_rebuilt');
          } else {
            increment(stats, 'source_files_reused');
          }
          continue;
        }
        const unchanged = !rebuild
          && prior
          && prior.identity === state.identity
          && prior.size === state.size
          && prior.mtime_ms === state.mtime_ms;
        files[descriptor.rel] = state;
        if (unchanged) {
          increment(stats, 'source_files_reused');
        } else {
          changed = true;
          for (const entry of parseJsonFile(dataRoot, descriptor, stats)) {
            if (!hasMarker(dataRoot, 'keys', entry.evidence_key)) newEntries.push(entry);
          }
          increment(stats, 'source_files_rebuilt');
        }
      }
      for (const directory of jsonDirectoryDescriptors(kind)) {
        const state = fileState(join(dataRoot, directory.rel));
        if (!state) continue;
        const prior = previousDirectories[directory.rel] ?? null;
        const unchanged = !rebuild
          && prior
          && prior.identity === state.identity
          && prior.mtime_ms === state.mtime_ms
          && prior.ctime_ms === state.ctime_ms;
        directories[directory.rel] = state;
        if (unchanged) {
          increment(stats, 'source_directories_reused');
          continue;
        }
        increment(stats, 'source_directories_scanned');
        for (const name of listFiles(join(dataRoot, directory.rel), '.json')) {
          const rel = join(directory.rel, name).replace(/\\/g, '/');
          if (hasMarker(dataRoot, 'source-files', rel)) continue;
          const descriptor = {
            mode: 'json',
            rel,
            kind,
            id: directory.idFromName ? basename(name, '.json') : null,
            defaultType: directory.defaultType,
          };
          for (const entry of parseJsonFile(dataRoot, descriptor, stats)) {
            if (!hasMarker(dataRoot, 'keys', entry.evidence_key)) newEntries.push(entry);
          }
          scannedJsonFiles.push(rel);
        }
      }
      if (JSON.stringify(files) !== JSON.stringify(previousFiles)) changed = true;
      if (JSON.stringify(directories) !== JSON.stringify(previousDirectories)) changed = true;
      next.sources[kind] = { files, directories };
    }

    increment(stats, 'sort_entries', newEntries.length);
    newEntries.sort((a, b) => (
      String(a.occurred_at).localeCompare(String(b.occurred_at))
      || String(a.id).localeCompare(String(b.id))
    ));
    appendJournalEntries(dataRoot, newEntries, stats);
    for (const rel of scannedJsonFiles) writeMarker(dataRoot, 'source-files', rel);
    next.journal_size = existsSync(evidenceIndexJournalPath(dataRoot))
      ? statSync(evidenceIndexJournalPath(dataRoot)).size
      : 0;
    if (changed || newEntries.length) {
      next.updated_at = new Date().toISOString();
      writeJsonMeasured(path, next, stats);
    }
    return next;
  });
}

function readCursorState(dataRoot, stats = null) {
  return readJsonMeasured(
    evidenceIndexCursorPath(dataRoot),
    emptyCursorState(),
    stats,
    'index_cursor',
  );
}

export function readEvidenceCursor(dataRoot, reactor, {
  stats = null,
  generation = null,
} = {}) {
  const state = readCursorState(dataRoot, stats);
  const record = state?.reactors?.[reactor];
  const generationMatches = !generation || record?.generation === generation;
  return {
    initialized: Boolean(record && generationMatches && Number.isFinite(Number(record.offset))),
    offset: Math.max(0, Number(record?.offset ?? 0)),
    generation: record?.generation ?? null,
    updated_at: record?.updated_at ?? null,
  };
}

/**
 * Commit a monotonic reactor journal cursor. consumedKeys are marked before the
 * cursor advances, so a crash can cause replay but cannot lose evidence.
 */
export function commitEvidenceCursor(dataRoot, reactor, offset, {
  consumedKeys = [],
  stats = null,
  expectedGeneration = null,
} = {}) {
  const path = evidenceIndexCursorPath(dataRoot);
  return withJsonLock(evidenceIndexPath(dataRoot), () => {
    const index = normalizedIndex(readJsonMeasured(evidenceIndexPath(dataRoot), null, stats));
    const generation = index?.generation ?? null;
    if (expectedGeneration && generation !== expectedGeneration) {
      throw new Error('Evidence index generation changed before cursor commit');
    }
    const state = readCursorState(dataRoot, stats);
    const prior = state?.reactors?.[reactor];
    const current = prior?.generation === generation
      ? Math.max(0, Number(prior?.offset ?? 0))
      : 0;
    const nextOffset = Math.max(current, Math.max(0, Number(offset) || 0));
    for (const key of new Set(consumedKeys.filter(Boolean))) {
      writeMarker(dataRoot, 'consumed', key, reactor);
    }
    if (nextOffset === current && prior?.generation === generation) return prior;
    const updatedAt = new Date().toISOString();
    const next = {
      schema_version: EVIDENCE_CURSOR_SCHEMA,
      reactors: {
        ...(state?.reactors ?? {}),
        [reactor]: { offset: nextOffset, generation, updated_at: updatedAt },
      },
      updated_at: updatedAt,
    };
    writeJsonMeasured(path, next, stats, 'index_cursor');
    return next.reactors[reactor];
  }, { lockPath: `${evidenceIndexPath(dataRoot)}.lock` });
}

/**
 * Released/failed claims are appended back to the pending journal. This keeps
 * reactor cursors monotonic while preserving the contract that such claims do
 * not permanently cover evidence.
 */
export function requeueIndexedEntries(dataRoot, reactor, entries, { stats = null } = {}) {
  const pending = Array.isArray(entries) ? entries.filter((entry) => entry?.evidence_key) : [];
  if (!pending.length) return 0;
  const path = evidenceIndexPath(dataRoot);
  return withJsonLock(path, () => {
    for (const entry of pending) {
      removeMarker(dataRoot, 'consumed', entry.evidence_key, reactor);
    }
    appendJournalEntries(dataRoot, pending, stats);
    return pending.length;
  });
}

function parseJournalWindow(dataRoot, {
  start,
  onEntry,
  stats,
} = {}) {
  const path = evidenceIndexJournalPath(dataRoot);
  if (!existsSync(path)) return { end: start, stopped: false };
  const size = statSync(path).size;
  let position = Math.min(Math.max(0, start), size);
  let carry = Buffer.alloc(0);
  let carryStart = position;
  while (position < size) {
    const length = Math.min(JOURNAL_CHUNK_BYTES, size - position);
    const chunk = readRange(path, position, length, stats, { index: true });
    if (!chunk.length) break;
    const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const combinedStart = carry.length ? carryStart : position;
    let lineStart = 0;
    while (lineStart < combined.length) {
      const newline = combined.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      const line = combined.subarray(lineStart, newline);
      const lineEndOffset = combinedStart + newline + 1;
      if (line.length) {
        increment(stats, 'index_entries_parsed');
        increment(stats, 'pending_scan_entries');
        try {
          const entry = JSON.parse(line.toString('utf8'));
          if (onEntry(entry, lineEndOffset) === false) {
            return { end: lineEndOffset, stopped: true };
          }
        } catch {
          increment(stats, 'index_parse_errors');
        }
      }
      lineStart = newline + 1;
    }
    carry = combined.subarray(lineStart);
    carryStart = combinedStart + lineStart;
    position += chunk.length;
  }
  return { end: carryStart, stopped: false };
}

/**
 * Read a bounded pending window from one reactor's unconsumed journal suffix.
 * The caller may commit safe_cursor immediately; claim_cursor is safe only
 * after the returned entries are durably claimed.
 */
export function scanPendingEvidence(dataRoot, {
  reactor = 'cognitive',
  kinds = null,
  limit = 256,
  covered = new Set(),
  stats = null,
} = {}) {
  return withJsonLock(evidenceIndexPath(dataRoot), () => {
    const index = normalizedIndex(readJsonMeasured(evidenceIndexPath(dataRoot), null, stats));
    const generation = index?.generation ?? null;
    const allowedKinds = kinds || defaultKindsForReactor(reactor);
    const cursor = readEvidenceCursor(dataRoot, reactor, { stats, generation });
    const startCursor = cursor.initialized ? cursor.offset : 0;
    const cap = Math.max(1, Math.floor(Number(limit) || 256));
    const entries = [];
    const consumedKeys = [];
    let safeCursor = startCursor;
    let claimCursor = startCursor;
    let pendingSeen = false;
    const parsed = parseJournalWindow(dataRoot, {
      start: startCursor,
      stats,
      onEntry: (entry, endOffset) => {
        const key = entry?.evidence_key;
        const eligible = isEligibleForReactor(entry, reactor, { kinds: allowedKinds });
        const alreadyConsumed = key && hasMarker(dataRoot, 'consumed', key, reactor);
        const alreadyCovered = key && (covered.has(key) || covered.has(entry.id));
        if (!eligible || alreadyConsumed || alreadyCovered) {
          if (eligible && alreadyCovered && key) consumedKeys.push(key);
          if (!pendingSeen) safeCursor = endOffset;
          claimCursor = endOffset;
          return true;
        }
        pendingSeen = true;
        entries.push(entry);
        claimCursor = endOffset;
        return entries.length < cap;
      },
    });
    if (!entries.length && !parsed.stopped) {
      safeCursor = parsed.end;
      claimCursor = parsed.end;
    }
    return {
      entries,
      initialized: cursor.initialized,
      generation,
      start_cursor: startCursor,
      safe_cursor: safeCursor,
      claim_cursor: claimCursor,
      consumed_keys: consumedKeys,
      journal_end: parsed.end,
    };
  });
}

export function hydrateIndexedEnvelope(dataRoot, compact, { stats = null } = {}) {
  const locator = compact?.locator;
  if (!locator?.file) return null;
  try {
    let record;
    if (locator.mode === 'jsonl') {
      const buffer = readRange(join(dataRoot, locator.file), locator.offset, locator.length, stats);
      increment(stats, 'payload_records_hydrated');
      record = JSON.parse(buffer.toString('utf8'));
    } else {
      increment(stats, 'source_files_read');
      const text = readFileSync(join(dataRoot, locator.file), 'utf8');
      increment(stats, 'source_bytes_read', Buffer.byteLength(text));
      increment(stats, 'payload_records_hydrated');
      record = JSON.parse(text);
    }
    const envelope = projectEvidenceRecord(compact.kind, record, {
      file: locator.file,
      index: locator.index ?? 0,
      id: locator.id ?? null,
      defaultType: locator.default_type ?? null,
    });
    return envelope.id === compact.id ? envelope : null;
  } catch {
    increment(stats, 'hydrate_errors');
    return null;
  }
}

function readAllJournalEntries(dataRoot, stats = null) {
  const entries = [];
  parseJournalWindow(dataRoot, {
    start: 0,
    stats,
    onEntry: (entry) => {
      entries.push(entry);
      return true;
    },
  });
  return entries;
}

/** Compatibility/debug read. Hot claim paths use scanPendingEvidence instead. */
export function readEvidenceIndex(dataRoot, { kinds, stats = null } = {}) {
  const allowed = new Set(kinds || Object.keys(STREAM_PATHS));
  return readAllJournalEntries(dataRoot, stats).filter((entry) => allowed.has(entry.kind));
}

/** Compatibility API; reactor callers receive only a bounded pending suffix. */
export function readIndexedEvidence(dataRoot, {
  kinds,
  hydrate = true,
  force = false,
  stats = null,
  reactor = null,
  limit = 256,
  covered = new Set(),
} = {}) {
  const requested = [...new Set(kinds || Object.keys(STREAM_PATHS))];
  refreshEvidenceIndex(dataRoot, { kinds: requested, force, stats });
  const compact = reactor
    ? scanPendingEvidence(dataRoot, {
      reactor,
      kinds: requested,
      limit,
      covered,
      stats,
    }).entries
    : readEvidenceIndex(dataRoot, { kinds: requested, stats });
  if (!hydrate) return compact;
  return compact
    .map((entry) => hydrateIndexedEnvelope(dataRoot, entry, { stats }))
    .filter(Boolean);
}
