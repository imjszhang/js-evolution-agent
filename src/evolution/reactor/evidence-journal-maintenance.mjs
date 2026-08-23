/**
 * Bounded-memory inspection and stopped-only rebuild/rollback for the
 * rebuildable evidence-index journal. Authority evidence is read-only here.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { readChannelWorkerState } from '../../channel/worker-state.mjs';
import { readWorkerState } from '../../daemon/daemon-worker-state.mjs';
import { writeJson } from '../../infra/json-store.mjs';
import { isProcessAlive } from '../../infra/process-alive.mjs';
import {
  STREAM_PATHS,
  evidenceSourceSignature,
  projectEvidenceRecord,
} from '../../intelligence/evidence-stream.mjs';
import { readRuleCursors } from './rule-cursors.mjs';
import {
  EVIDENCE_CURSOR_SCHEMA,
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  EVIDENCE_JOURNAL_STATE_SCHEMA,
  compactIndexedEnvelope,
  evidenceIndexBackupsDir,
  evidenceIndexCursorPath,
  evidenceIndexDir,
  evidenceIndexGenerationsDir,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  evidenceJournalMaintenanceStatus,
  evidenceJournalStatePath,
  evidenceSourceFileState,
  jsonDirectoryDescriptors,
  legacyEvidenceIndexDir,
  readEvidenceJournalState,
  resolveEvidenceJournalPolicy,
  sourceDescriptors,
} from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';

export const EVIDENCE_JOURNAL_INSPECT_SCHEMA = 'evidence-journal-inspect.v1';
export const EVIDENCE_JOURNAL_REBUILD_SCHEMA = 'evidence-journal-rebuild.v1';
export const EVIDENCE_JOURNAL_BACKUP_SCHEMA = 'evidence-journal-backup.v1';

const IO_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEDUPE_LEAF_BYTES = 4 * 1024 * 1024;
const ORDER_SEGMENT_BYTES = 4 * 1024 * 1024;
const SAMPLE_LIMIT = 20;
const REACTORS = Object.freeze(['cognitive', 'rule', 'memory']);

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function safeJson(path, fallback = null) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function count(map, key, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function kindStats() {
  return {
    lines: 0,
    bytes: 0,
    unique_keys: 0,
    duplicate_count: 0,
    source_records: 0,
    source_bytes: 0,
    source_unique_keys: 0,
    source_duplicate_count: 0,
    matched_keys: 0,
    missing_keys: 0,
    orphan_keys: 0,
  };
}

function allKindStats() {
  return Object.fromEntries(Object.keys(STREAM_PATHS).map((kind) => [kind, kindStats()]));
}

/**
 * Buffer at most maxLineBytes for one line. Oversized/torn sparse tails are
 * counted without concatenating their full contents.
 */
async function scanLines(path, onLine, {
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  highWaterMark = IO_CHUNK_BYTES,
} = {}) {
  if (!existsSync(path)) {
    return { bytes: 0, physical_lines: 0, complete_end: 0, final_newline: true };
  }
  const bytes = statSync(path).size;
  const stream = createReadStream(path, { highWaterMark });
  let pieces = [];
  let buffered = 0;
  let lineBytes = 0;
  let lineStart = 0;
  let absolute = 0;
  let physicalLines = 0;
  let oversized = false;
  let completeEnd = 0;

  const add = (slice) => {
    if (!slice.length) return;
    lineBytes += slice.length;
    if (oversized) return;
    if (buffered + slice.length > maxLineBytes) {
      pieces = [];
      buffered = 0;
      oversized = true;
      return;
    }
    pieces.push(Buffer.from(slice));
    buffered += slice.length;
  };
  const finish = (terminated) => {
    physicalLines += 1;
    const raw = oversized ? null : Buffer.concat(pieces, buffered);
    onLine({
      raw,
      oversized,
      line_bytes: lineBytes,
      record_bytes: lineBytes + (terminated ? 1 : 0),
      start: lineStart,
      end: absolute + (terminated ? 1 : 0),
      terminated,
      line_number: physicalLines,
    });
    if (terminated) completeEnd = absolute + 1;
    pieces = [];
    buffered = 0;
    lineBytes = 0;
    oversized = false;
    lineStart = absolute + (terminated ? 1 : 0);
  };

  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline < 0) {
        add(chunk.subarray(cursor));
        absolute += chunk.length - cursor;
        cursor = chunk.length;
      } else {
        add(chunk.subarray(cursor, newline));
        absolute += newline - cursor;
        finish(true);
        absolute += 1;
        cursor = newline + 1;
      }
    }
  }
  if (lineBytes > 0 || buffered > 0 || oversized) finish(false);
  return {
    bytes,
    physical_lines: physicalLines,
    complete_end: completeEnd,
    final_newline: bytes === 0 || completeEnd === bytes,
  };
}

class ShardWriter {
  constructor(dir) {
    this.dir = dir;
    this.handles = new Map();
    mkdirSync(dir, { recursive: true });
  }

  write(shard, value) {
    let fd = this.handles.get(shard);
    if (fd == null) {
      const path = join(this.dir, `${shard}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, 'a');
      this.handles.set(shard, fd);
    }
    writeSync(fd, jsonLine(value), null, 'utf8');
  }

  close() {
    for (const fd of this.handles.values()) closeSync(fd);
    this.handles.clear();
  }
}

function shardAt(key, depth) {
  return digest(key)[Math.min(31, depth)].toString(16).padStart(2, '0');
}

async function readRecordFile(path, onRecord) {
  await scanLines(path, ({ raw, oversized }) => {
    if (oversized || !raw?.length) {
      const error = new Error(`Temporary evidence maintenance record exceeded ${DEFAULT_MAX_LINE_BYTES} bytes`);
      error.code = 'evidence_maintenance_temp_record_oversized';
      throw error;
    }
    const record = JSON.parse(raw.toString('utf8'));
    onRecord(record);
  });
}

async function dedupeShard(path, depth, onUnique, workDir) {
  const state = safeStat(path);
  if (!state?.size) return 0;
  if (state.size <= DEDUPE_LEAF_BYTES) {
    const selected = new Map();
    await readRecordFile(path, (record) => {
      if (record?.key) selected.set(record.key, record);
    });
    for (const record of selected.values()) onUnique(record);
    return selected.size;
  }
  if (depth >= 32) {
    let key = null;
    let selected = null;
    await readRecordFile(path, (record) => {
      if (!key) key = record.key;
      if (record.key !== key) {
        const error = new Error('SHA-256 collision prevents bounded evidence-key deduplication');
        error.code = 'evidence_key_hash_collision';
        throw error;
      }
      selected = record;
    });
    if (selected) onUnique(selected);
    return selected ? 1 : 0;
  }

  const children = join(workDir, `split-${depth}-${randomUUID()}`);
  const writer = new ShardWriter(children);
  try {
    await readRecordFile(path, (record) => writer.write(shardAt(record.key, depth), record));
  } finally {
    writer.close();
  }
  let unique = 0;
  for (const name of readdirSync(children).filter((item) => item.endsWith('.jsonl')).sort()) {
    unique += await dedupeShard(join(children, name), depth + 1, onUnique, workDir);
  }
  rmSync(children, { recursive: true, force: true });
  return unique;
}

async function dedupeCandidates(candidateDir, onUnique, workDir) {
  let unique = 0;
  if (!existsSync(candidateDir)) return unique;
  for (const name of readdirSync(candidateDir).filter((item) => item.endsWith('.jsonl')).sort()) {
    unique += await dedupeShard(join(candidateDir, name), 1, onUnique, workDir);
  }
  return unique;
}

function parseJournalEntry(raw) {
  if (!raw?.length) return { empty: true };
  let value;
  try {
    value = JSON.parse(raw.toString('utf8').replace(/\r$/, ''));
  } catch (error) {
    return { valid: false, reason: 'invalid_json', error: error?.message ?? String(error) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, reason: 'invalid_shape' };
  }
  if (typeof value.evidence_key !== 'string' || !value.evidence_key.trim()) {
    return { valid: false, reason: 'missing_evidence_key' };
  }
  if (typeof value.kind !== 'string' || !value.kind.trim()) {
    return { valid: false, reason: 'missing_kind' };
  }
  return { valid: true, value };
}

function stripLeadingUtf8Bom(text, atFileStart = true) {
  return atFileStart && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function scanJournal(path, workDir) {
  const candidateDir = join(workDir, 'journal-candidates');
  const uniqueDir = join(workDir, 'journal-unique');
  const candidates = new ShardWriter(candidateDir);
  const stats = {
    path,
    bytes: 0,
    total_lines: 0,
    valid_lines: 0,
    invalid_lines: 0,
    empty_lines: 0,
    oversized_lines: 0,
    unique_evidence_keys: 0,
    duplicate_count: 0,
    duplicate_rate: 0,
    max_line_bytes: 0,
    final_newline: true,
    invalid_samples: [],
    kinds: allKindStats(),
  };
  try {
    const scanned = await scanLines(path, (line) => {
      if (line.line_bytes === 0) {
        stats.empty_lines += 1;
        return;
      }
      stats.total_lines += 1;
      stats.max_line_bytes = Math.max(stats.max_line_bytes, line.line_bytes);
      if (line.oversized) {
        stats.invalid_lines += 1;
        stats.oversized_lines += 1;
        if (stats.invalid_samples.length < SAMPLE_LIMIT) {
          stats.invalid_samples.push({
            line: line.line_number,
            offset: line.start,
            bytes: line.line_bytes,
            reason: 'line_oversized',
          });
        }
        return;
      }
      const parsed = parseJournalEntry(line.raw);
      if (!parsed.valid) {
        stats.invalid_lines += 1;
        if (stats.invalid_samples.length < SAMPLE_LIMIT) {
          stats.invalid_samples.push({
            line: line.line_number,
            offset: line.start,
            bytes: line.line_bytes,
            reason: parsed.reason,
          });
        }
        return;
      }
      stats.valid_lines += 1;
      const kind = parsed.value.kind;
      if (!stats.kinds[kind]) stats.kinds[kind] = kindStats();
      stats.kinds[kind].lines += 1;
      stats.kinds[kind].bytes += line.record_bytes;
      candidates.write(shardAt(parsed.value.evidence_key, 0), {
        key: parsed.value.evidence_key,
        kind,
      });
    });
    stats.bytes = scanned.bytes;
    stats.final_newline = scanned.final_newline;
  } finally {
    candidates.close();
  }

  const uniqueWriter = new ShardWriter(uniqueDir);
  try {
    stats.unique_evidence_keys = await dedupeCandidates(candidateDir, (record) => {
      uniqueWriter.write(shardAt(record.key, 0), record);
      if (!stats.kinds[record.kind]) stats.kinds[record.kind] = kindStats();
      stats.kinds[record.kind].unique_keys += 1;
    }, workDir);
  } finally {
    uniqueWriter.close();
  }
  stats.duplicate_count = stats.valid_lines - stats.unique_evidence_keys;
  stats.duplicate_rate = stats.valid_lines
    ? Number((stats.duplicate_count / stats.valid_lines).toFixed(6))
    : 0;
  for (const item of Object.values(stats.kinds)) {
    item.duplicate_count = item.lines - item.unique_keys;
  }
  return { stats, uniqueDir };
}

function sourceSummary() {
  return {
    records: 0,
    valid_records: 0,
    invalid_records: 0,
    bytes: 0,
    unique_keys: 0,
    duplicate_count: 0,
    unreadable: 0,
    invalid_samples: [],
    kinds: allKindStats(),
    sources: {},
  };
}

function sourceKind(summary, kind) {
  if (!summary.kinds[kind]) summary.kinds[kind] = kindStats();
  if (!summary.sources[kind]) {
    summary.sources[kind] = {
      records: 0,
      valid_records: 0,
      invalid_records: 0,
      bytes: 0,
      unique_keys: 0,
      duplicate_count: 0,
      files: 0,
      unreadable: 0,
    };
  }
  return summary.sources[kind];
}

function sourceRecord(summary, kind, recordBytes, valid) {
  const item = sourceKind(summary, kind);
  summary.records += 1;
  summary.bytes += recordBytes;
  item.records += 1;
  item.bytes += recordBytes;
  summary.kinds[kind].source_records += 1;
  summary.kinds[kind].source_bytes += recordBytes;
  if (valid) {
    summary.valid_records += 1;
    item.valid_records += 1;
  } else {
    summary.invalid_records += 1;
    item.invalid_records += 1;
  }
}

function sourceError(summary, kind, detail, { unreadable = false } = {}) {
  const item = sourceKind(summary, kind);
  if (unreadable) {
    item.unreadable += 1;
    summary.unreadable += 1;
  }
  if (summary.invalid_samples.length < SAMPLE_LIMIT) summary.invalid_samples.push({ kind, ...detail });
}

function sourceCandidate(writer, summary, envelope, locator, orderState, includeEntries) {
  const key = envelope?.evidence_key;
  if (!key) return false;
  const entry = includeEntries ? compactIndexedEnvelope(envelope, locator) : null;
  const encodedBytes = includeEntries ? Buffer.byteLength(jsonLine(entry)) : Buffer.byteLength(key);
  const record = {
    key,
    kind: envelope.kind,
    order_position: orderState.bytes,
    ...(includeEntries ? { entry } : {}),
  };
  orderState.bytes += encodedBytes;
  writer.write(shardAt(key, 0), record);
  return true;
}

async function scanAuthoritySources(dataRoot, workDir, { includeEntries = false } = {}) {
  const candidateDir = join(workDir, 'source-candidates');
  const uniqueDir = join(workDir, 'source-unique');
  const writer = new ShardWriter(candidateDir);
  const summary = sourceSummary();
  const manifestSources = {};
  const sourceFiles = [];
  const orderState = { bytes: 0 };

  try {
    for (const kind of Object.keys(STREAM_PATHS)) {
      const files = {};
      const directories = {};
      const kindSummary = sourceKind(summary, kind);
      for (const descriptor of sourceDescriptors(dataRoot, kind)) {
        const absolute = join(dataRoot, descriptor.rel);
        const state = evidenceSourceFileState(absolute);
        if (!state) continue;
        kindSummary.files += 1;
        let rowIndex = 0;
        try {
          const scanned = await scanLines(absolute, (line) => {
            if (!line.line_bytes) return;
            const currentIndex = rowIndex;
            rowIndex += 1;
            if (line.oversized) {
              sourceRecord(summary, kind, line.record_bytes, false);
              sourceError(summary, kind, {
                file: descriptor.rel,
                line: line.line_number,
                reason: 'line_oversized',
                bytes: line.line_bytes,
              });
              return;
            }
            try {
              const record = JSON.parse(stripLeadingUtf8Bom(
                line.raw.toString('utf8').replace(/\r$/, ''),
                line.start === 0,
              ));
              const envelope = projectEvidenceRecord(kind, record, {
                file: descriptor.rel,
                index: currentIndex,
              });
              const valid = sourceCandidate(writer, summary, envelope, {
                mode: 'jsonl',
                file: descriptor.rel,
                offset: line.start,
                length: line.line_bytes - (line.raw.at(-1) === 0x0d ? 1 : 0),
                index: currentIndex,
              }, orderState, includeEntries);
              sourceRecord(summary, kind, line.record_bytes, valid);
            } catch (error) {
              sourceRecord(summary, kind, line.record_bytes, false);
              sourceError(summary, kind, {
                file: descriptor.rel,
                line: line.line_number,
                reason: 'invalid_json',
                error: error?.message ?? String(error),
              });
            }
          });
          files[descriptor.rel] = {
            ...state,
            cursor: scanned.complete_end,
            row_count: rowIndex,
          };
          if (!scanned.final_newline) {
            sourceError(summary, kind, {
              file: descriptor.rel,
              reason: 'truncated_jsonl_tail',
            });
          }
        } catch (error) {
          sourceError(summary, kind, {
            file: descriptor.rel,
            reason: 'source_unreadable',
            error: error?.message ?? String(error),
          }, { unreadable: true });
        }
      }

      for (const directory of jsonDirectoryDescriptors(kind)) {
        const absoluteDir = join(dataRoot, directory.rel);
        const dirState = evidenceSourceFileState(absoluteDir);
        if (!dirState) continue;
        directories[directory.rel] = dirState;
        let names = [];
        try {
          names = readdirSync(absoluteDir).filter((name) => name.endsWith('.json')).sort();
        } catch (error) {
          sourceError(summary, kind, {
            file: directory.rel,
            reason: 'source_directory_unreadable',
            error: error?.message ?? String(error),
          }, { unreadable: true });
          continue;
        }
        for (const name of names) {
          const rel = join(directory.rel, name).replace(/\\/g, '/');
          const absolute = join(dataRoot, rel);
          const state = safeStat(absolute);
          kindSummary.files += 1;
          sourceFiles.push(rel);
          if (!state) {
            sourceError(
              summary,
              kind,
              { file: rel, reason: 'source_unreadable' },
              { unreadable: true },
            );
            continue;
          }
          if (state.size > DEFAULT_MAX_LINE_BYTES) {
            sourceRecord(summary, kind, state.size, false);
            sourceError(summary, kind, {
              file: rel,
              reason: 'json_file_oversized',
              bytes: state.size,
            });
            continue;
          }
          try {
            const record = JSON.parse(stripLeadingUtf8Bom(readFileSync(absolute, 'utf8')));
            const id = directory.idFromName ? basename(name, '.json') : null;
            const envelope = projectEvidenceRecord(kind, record, {
              file: rel,
              id,
              defaultType: directory.defaultType,
            });
            const valid = sourceCandidate(writer, summary, envelope, {
              mode: 'json',
              file: rel,
              id,
              default_type: directory.defaultType,
            }, orderState, includeEntries);
            sourceRecord(summary, kind, state.size, valid);
          } catch (error) {
            sourceRecord(summary, kind, state.size, false);
            sourceError(summary, kind, {
              file: rel,
              reason: 'invalid_json',
              error: error?.message ?? String(error),
            });
          }
        }
      }
      manifestSources[kind] = { files, directories };
    }
  } finally {
    writer.close();
  }

  const uniqueWriter = new ShardWriter(uniqueDir);
  try {
    summary.unique_keys = await dedupeCandidates(candidateDir, (record) => {
      uniqueWriter.write(shardAt(record.key, 0), record);
      const item = sourceKind(summary, record.kind);
      item.unique_keys += 1;
      summary.kinds[record.kind].source_unique_keys += 1;
    }, workDir);
  } finally {
    uniqueWriter.close();
  }
  summary.duplicate_count = summary.valid_records - summary.unique_keys;
  for (const [kind, item] of Object.entries(summary.sources)) {
    item.duplicate_count = item.valid_records - item.unique_keys;
    summary.kinds[kind].source_duplicate_count = item.duplicate_count;
  }
  return {
    summary,
    uniqueDir,
    candidateDir,
    manifestSources,
    sourceFiles,
  };
}

async function loadUniqueMap(path) {
  const map = new Map();
  if (!existsSync(path)) return map;
  await readRecordFile(path, (record) => map.set(record.key, record.kind));
  return map;
}

async function partitionUnique(path, dir, depth) {
  const writer = new ShardWriter(dir);
  try {
    if (existsSync(path)) {
      await readRecordFile(path, (record) => writer.write(shardAt(record.key, depth), record));
    }
  } finally {
    writer.close();
  }
}

async function compareUniqueFiles(journalPath, sourcePath, depth, result, workDir) {
  const totalBytes = (safeStat(journalPath)?.size ?? 0) + (safeStat(sourcePath)?.size ?? 0);
  if (totalBytes > DEDUPE_LEAF_BYTES && depth < 32) {
    const split = join(workDir, `compare-${depth}-${randomUUID()}`);
    const journalDir = join(split, 'journal');
    const sourceDir = join(split, 'source');
    await partitionUnique(journalPath, journalDir, depth);
    await partitionUnique(sourcePath, sourceDir, depth);
    const names = new Set([
      ...(existsSync(journalDir) ? readdirSync(journalDir) : []),
      ...(existsSync(sourceDir) ? readdirSync(sourceDir) : []),
    ]);
    for (const name of [...names].sort()) {
      await compareUniqueFiles(
        join(journalDir, name),
        join(sourceDir, name),
        depth + 1,
        result,
        workDir,
      );
    }
    rmSync(split, { recursive: true, force: true });
    return;
  }
  if (totalBytes > DEDUPE_LEAF_BYTES) {
    const error = new Error('Hash collision prevents bounded source reconciliation');
    error.code = 'evidence_reconciliation_hash_collision';
    throw error;
  }
  const journal = await loadUniqueMap(journalPath);
  const source = await loadUniqueMap(sourcePath);
  for (const [key, kind] of source) {
    if (journal.has(key)) {
      result.matched_keys += 1;
      result.kinds[kind].matched_keys += 1;
    } else {
      result.missing_keys += 1;
      result.kinds[kind].missing_keys += 1;
      if (result.missing_samples.length < SAMPLE_LIMIT) result.missing_samples.push(key);
    }
  }
  for (const [key, kind] of journal) {
    if (source.has(key)) continue;
    result.orphan_keys += 1;
    if (!result.kinds[kind]) result.kinds[kind] = kindStats();
    result.kinds[kind].orphan_keys += 1;
    if (result.orphan_samples.length < SAMPLE_LIMIT) result.orphan_samples.push(key);
  }
}

async function reconcileUnique(journalDir, sourceDir, workDir, journal, source) {
  const result = {
    status: 'ok',
    ok: true,
    matched_keys: 0,
    missing_keys: 0,
    orphan_keys: 0,
    unknown_records: journal.invalid_lines + source.invalid_records + source.unreadable,
    missing_samples: [],
    orphan_samples: [],
    unknown_reasons: [],
    kinds: allKindStats(),
  };
  for (const [kind, stats] of Object.entries(journal.kinds)) {
    if (!result.kinds[kind]) result.kinds[kind] = kindStats();
    Object.assign(result.kinds[kind], stats);
  }
  for (const [kind, stats] of Object.entries(source.kinds)) {
    if (!result.kinds[kind]) result.kinds[kind] = kindStats();
    Object.assign(result.kinds[kind], {
      ...result.kinds[kind],
      source_records: stats.source_records,
      source_bytes: stats.source_bytes,
      source_unique_keys: stats.source_unique_keys,
      source_duplicate_count: stats.source_duplicate_count,
    });
  }
  const names = new Set([
    ...(existsSync(journalDir) ? readdirSync(journalDir) : []),
    ...(existsSync(sourceDir) ? readdirSync(sourceDir) : []),
  ]);
  for (const name of [...names].sort()) {
    await compareUniqueFiles(
      join(journalDir, name),
      join(sourceDir, name),
      1,
      result,
      workDir,
    );
  }
  if (journal.invalid_lines) result.unknown_reasons.push('journal_invalid_lines');
  if (source.invalid_records) result.unknown_reasons.push('authority_invalid_records');
  if (source.unreadable) result.unknown_reasons.push('authority_sources_unreadable');
  if (result.unknown_records > 0) result.status = 'unknown';
  else if (result.missing_keys || result.orphan_keys) result.status = 'mismatch';
  result.ok = result.status === 'ok';
  return result;
}

function cursorProjection(cursorState, generation) {
  const reactors = {};
  for (const reactor of REACTORS) {
    const record = cursorState?.reactors?.[reactor] ?? null;
    reactors[reactor] = {
      offset: Number.isFinite(Number(record?.offset)) ? Math.max(0, Number(record.offset)) : null,
      generation: record?.generation ?? null,
      generation_matches: Boolean(record && record.generation === generation),
      initialized: Boolean(record && Number.isFinite(Number(record.offset))),
      updated_at: record?.updated_at ?? null,
    };
  }
  return {
    schema_version: cursorState?.schema_version ?? null,
    reactors,
    updated_at: cursorState?.updated_at ?? null,
  };
}

async function inspectAt(dataRoot, {
  journalPath = evidenceIndexJournalPath(dataRoot),
  cursorPath = evidenceIndexCursorPath(dataRoot),
  manifest = safeJson(evidenceIndexPath(dataRoot), null),
  workDir,
  env = process.env,
} = {}) {
  const journalScan = await scanJournal(journalPath, workDir);
  const sourceScan = await scanAuthoritySources(dataRoot, workDir);
  const reconciliation = await reconcileUnique(
    journalScan.uniqueDir,
    sourceScan.uniqueDir,
    workDir,
    journalScan.stats,
    sourceScan.summary,
  );
  const generation = manifest?.generation ?? null;
  const cursors = safeJson(cursorPath, { reactors: {} });
  const storedMaintenance = readEvidenceJournalState(dataRoot, { env });
  const policy = resolveEvidenceJournalPolicy(env);
  const maintenanceStatus = evidenceJournalMaintenanceStatus(journalScan.stats.bytes, policy);
  return {
    schema_version: EVIDENCE_JOURNAL_INSPECT_SCHEMA,
    generated_at: new Date().toISOString(),
    read_only: true,
    manifest: {
      path: evidenceIndexPath(dataRoot),
      schema_version: manifest?.schema_version ?? null,
      generation,
      active_directory: manifest?.active_directory ?? null,
      journal_size: Number(manifest?.journal_size ?? 0),
      updated_at: manifest?.updated_at ?? null,
    },
    journal: journalScan.stats,
    cursors: cursorProjection(cursors, generation),
    rule_cursors: readRuleCursors(dataRoot),
    authoritative_sources: sourceScan.summary,
    reconciliation,
    maintenance: {
      ...storedMaintenance,
      journal_bytes: journalScan.stats.bytes,
      journal_bytes_source: 'inspect_scan',
      stored_journal_bytes: storedMaintenance.journal_bytes,
      rotate_bytes: policy.rotate_bytes,
      block_bytes: policy.block_bytes,
      status: maintenanceStatus,
      maintenance_due: maintenanceStatus !== 'ok',
      blocked: maintenanceStatus === 'blocked',
      reason: maintenanceStatus === 'ok' ? null : 'evidence_journal_rotation_required',
    },
  };
}

export async function inspectEvidenceJournal(dataRoot, options = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'jea-evidence-journal-inspect-'));
  try {
    return await inspectAt(dataRoot, { ...options, workDir });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function inspectEvidenceMaintenanceWorkers(root, subject) {
  const cycle = readWorkerState(root, subject);
  const channel = readChannelWorkerState(root, subject);
  const live = [];
  if (
    cycle
    && ['running', 'stopping'].includes(cycle.status)
    && isProcessAlive(cycle.pid)
  ) {
    live.push({ domain: 'cycle', pid: cycle.pid, worker_id: cycle.worker_id ?? null });
  }
  for (const [role, worker] of Object.entries(channel?.workers ?? {})) {
    if (
      worker
      && ['running', 'stopping'].includes(worker.status)
      && isProcessAlive(worker.pid)
    ) {
      live.push({ domain: 'channel', role, pid: worker.pid, worker_id: worker.worker_id ?? null });
    }
  }
  if (
    channel
    && ['running', 'stopping'].includes(channel.status)
    && isProcessAlive(channel.pid)
    && !live.some((item) => item.domain === 'channel' && item.pid === channel.pid)
  ) {
    live.push({ domain: 'channel', role: 'coordinator', pid: channel.pid, worker_id: channel.worker_id ?? null });
  }
  return { stopped: live.length === 0, live };
}

export function assertEvidenceMaintenanceStopped(root, subject) {
  const state = inspectEvidenceMaintenanceWorkers(root, subject);
  if (!state.stopped) {
    const error = new Error('Evidence journal writes require all Cycle and Channel workers to be stopped');
    error.code = 'evidence_journal_workers_running';
    error.details = state;
    throw error;
  }
  return state;
}

function markerPath(activeDir, category, key, reactor = null) {
  const hex = digest(key).toString('hex');
  return join(activeDir, category, ...(reactor ? [reactor] : []), hex.slice(0, 2), hex);
}

function writeKeyMarker(activeDir, entry) {
  const path = markerPath(activeDir, 'keys', entry.evidence_key);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, jsonLine(entry), { flag: 'wx' });
}

function copyConsumedMarkers(dataRoot, stageDir) {
  const source = join(evidenceIndexDir(dataRoot), 'consumed');
  if (!existsSync(source)) return false;
  cpSync(source, join(stageDir, 'consumed'), {
    recursive: true,
    force: false,
    mode: constants.COPYFILE_FICLONE,
  });
  return true;
}

function writeSourceFileMarkers(stageDir, files) {
  for (const rel of files) {
    const hex = digest(rel).toString('hex');
    const path = join(stageDir, 'source-files', hex.slice(0, 2), hex);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', { flag: 'wx' });
  }
}

async function buildStageFromAuthority(dataRoot, stageDir, workDir, generation) {
  const source = await scanAuthoritySources(dataRoot, workDir, { includeEntries: true });
  if (source.summary.invalid_records || source.summary.unreadable) {
    const error = new Error('Authoritative evidence contains invalid or unreadable records; rebuild failed closed');
    error.code = 'evidence_authority_unknown';
    error.details = source.summary;
    throw error;
  }
  const segmentsDir = join(workDir, 'ordered-segments');
  const segments = new ShardWriter(segmentsDir);
  try {
    await dedupeCandidates(source.candidateDir, (record) => {
      const segment = String(Math.floor(record.order_position / ORDER_SEGMENT_BYTES)).padStart(12, '0');
      segments.write(segment, record);
    }, workDir);
  } finally {
    segments.close();
  }

  mkdirSync(stageDir, { recursive: true });
  const journalPath = join(stageDir, 'entries.jsonl');
  const fd = openSync(journalPath, 'w');
  let bytes = 0;
  let lines = 0;
  try {
    const names = existsSync(segmentsDir)
      ? readdirSync(segmentsDir).filter((name) => name.endsWith('.jsonl')).sort()
      : [];
    for (const name of names) {
      const records = [];
      await readRecordFile(join(segmentsDir, name), (record) => records.push(record));
      records.sort((a, b) => a.order_position - b.order_position);
      for (const record of records) {
        const line = jsonLine(record.entry);
        writeSync(fd, line, null, 'utf8');
        bytes += Buffer.byteLength(line);
        lines += 1;
        writeKeyMarker(stageDir, record.entry);
      }
    }
  } finally {
    closeSync(fd);
  }
  copyConsumedMarkers(dataRoot, stageDir);
  writeSourceFileMarkers(stageDir, source.sourceFiles);
  const migratedAt = new Date().toISOString();
  const reactors = Object.fromEntries(REACTORS.map((reactor) => [
    reactor,
    {
      offset: 0,
      generation,
      updated_at: migratedAt,
      migration: 'safe_replay_from_zero',
    },
  ]));
  writeJson(join(stageDir, 'cursors.json'), {
    schema_version: EVIDENCE_CURSOR_SCHEMA,
    reactors,
    updated_at: migratedAt,
  });
  const policy = resolveEvidenceJournalPolicy();
  writeJson(join(stageDir, 'journal-state.json'), {
    schema_version: EVIDENCE_JOURNAL_STATE_SCHEMA,
    generation,
    journal_bytes: bytes,
    journal_lines: lines,
    unique_evidence_keys: source.summary.unique_keys,
    duplicate_count: 0,
    rotate_bytes: policy.rotate_bytes,
    block_bytes: policy.block_bytes,
    status: evidenceJournalMaintenanceStatus(bytes, policy),
    maintenance_due: bytes >= policy.rotate_bytes,
    blocked: bytes >= policy.block_bytes,
    reason: bytes >= policy.rotate_bytes ? 'evidence_journal_rotation_required' : null,
    observed_at: migratedAt,
    last_rebuild_at: migratedAt,
  });
  return { source, bytes, lines, migratedAt };
}

function createBackup(dataRoot, manifest, activeDir, {
  reason,
  now = new Date(),
} = {}) {
  const id = `${timestampForPath(now)}-${randomUUID().slice(0, 8)}`;
  const dir = join(evidenceIndexBackupsDir(dataRoot), id);
  const sidecar = join(dir, 'sidecar');
  mkdirSync(dir, { recursive: true });
  if (existsSync(activeDir)) {
    cpSync(activeDir, sidecar, {
      recursive: true,
      force: false,
      mode: constants.COPYFILE_FICLONE,
    });
  } else {
    mkdirSync(sidecar, { recursive: true });
  }
  const metadata = {
    schema_version: EVIDENCE_JOURNAL_BACKUP_SCHEMA,
    backup_id: id,
    created_at: now.toISOString(),
    reason,
    source_manifest: manifest,
    source_active_directory: relative(reactorDir(dataRoot), activeDir).replace(/\\/g, '/'),
    sidecar_directory: 'sidecar',
  };
  writeJson(join(dir, 'backup.json'), metadata);
  return { id, path: dir, sidecar, metadata };
}

function rebuildNeeded(inspect, force) {
  return Boolean(
    force
    || inspect.manifest.schema_version !== EVIDENCE_INDEX_GENERATION_SCHEMA
    || inspect.journal.duplicate_count > 0
    || inspect.reconciliation.missing_keys > 0
    || inspect.reconciliation.orphan_keys > 0
    || inspect.maintenance.maintenance_due,
  );
}

function operationError(error, fallback) {
  if (!error.code) error.code = fallback;
  return error;
}

export async function rebuildEvidenceJournal(dataRoot, {
  root = null,
  subject = null,
  dryRun = true,
  force = false,
  assertStopped = null,
  failpoint = null,
} = {}) {
  const before = await inspectEvidenceJournal(dataRoot);
  const needed = rebuildNeeded(before, force);
  const resultBase = {
    schema_version: EVIDENCE_JOURNAL_REBUILD_SCHEMA,
    operation: 'rebuild',
    dry_run: dryRun,
    subject,
    needed,
    before,
    invariants: {
      authority_mutated: false,
      dedupe_key: 'evidence_key',
      cursor_migration: 'safe_replay_from_zero',
      consumed_markers_preserved: true,
      pointer_switch: 'atomic_manifest_rename',
    },
  };
  if (
    before.authoritative_sources.invalid_records > 0
    || before.authoritative_sources.unreadable > 0
  ) {
    return {
      ...resultBase,
      status: 'blocked',
      block_reason: 'authoritative_source_reconciliation_unknown',
    };
  }
  if (dryRun) {
    return { ...resultBase, status: needed ? 'would_rebuild' : 'not_needed' };
  }
  if (!needed) return { ...resultBase, status: 'not_needed' };

  const stoppedCheck = assertStopped
    ?? (() => assertEvidenceMaintenanceStopped(root, subject));
  stoppedCheck();
  const sourceSignature = evidenceSourceSignature(dataRoot);
  const generation = randomUUID();
  const generations = evidenceIndexGenerationsDir(dataRoot);
  mkdirSync(generations, { recursive: true });
  const stageDir = join(generations, `.${generation}.tmp`);
  const finalDir = join(generations, generation);
  const workDir = mkdtempSync(join(tmpdir(), 'jea-evidence-journal-rebuild-'));
  const currentManifest = safeJson(evidenceIndexPath(dataRoot), null);
  const currentActive = evidenceIndexDir(dataRoot, currentManifest);
  let switched = false;
  let backup = null;
  try {
    const built = await buildStageFromAuthority(dataRoot, stageDir, workDir, generation);
    const activeDirectory = relative(reactorDir(dataRoot), finalDir).replace(/\\/g, '/');
    const nextManifest = {
      schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
      generation,
      active_directory: activeDirectory,
      sources: built.source.manifestSources,
      journal_size: built.bytes,
      journal_summary: {
        schema_version: EVIDENCE_JOURNAL_INSPECT_SCHEMA,
        bytes: built.bytes,
        lines: built.lines,
        valid_lines: built.lines,
        invalid_lines: 0,
        unique_evidence_keys: built.source.summary.unique_keys,
        duplicate_count: 0,
        source_unique_keys: built.source.summary.unique_keys,
        source_records: built.source.summary.records,
        rebuilt_at: built.migratedAt,
      },
      cursor_migration: {
        strategy: 'safe_replay_from_zero',
        reactors: REACTORS,
        exact_offset_mapping: false,
        evidence_loss_possible: false,
        replay_possible: true,
        consumed_markers_preserved: true,
      },
      updated_at: built.migratedAt,
    };
    const validationWork = mkdtempSync(join(tmpdir(), 'jea-evidence-journal-validate-'));
    let validation;
    try {
      validation = await inspectAt(dataRoot, {
        journalPath: join(stageDir, 'entries.jsonl'),
        cursorPath: join(stageDir, 'cursors.json'),
        manifest: nextManifest,
        workDir: validationWork,
      });
    } finally {
      rmSync(validationWork, { recursive: true, force: true });
    }
    const cursorInvariant = REACTORS.every((reactor) => (
      validation.cursors.reactors[reactor].offset === 0
      && validation.cursors.reactors[reactor].generation_matches
    ));
    if (
      validation.journal.invalid_lines
      || validation.journal.duplicate_count
      || validation.journal.valid_lines !== built.source.summary.unique_keys
      || !validation.reconciliation.ok
      || !cursorInvariant
    ) {
      const error = new Error('Staged evidence journal failed schema/count/reconciliation/cursor validation');
      error.code = 'evidence_journal_stage_validation_failed';
      error.details = { validation, cursor_invariant: cursorInvariant };
      throw error;
    }
    if (evidenceSourceSignature(dataRoot) !== sourceSignature) {
      const error = new Error('Authoritative evidence changed during rebuild; refusing pointer switch');
      error.code = 'evidence_authority_changed';
      throw error;
    }
    stoppedCheck();
    if (failpoint === 'before_backup') throw operationError(new Error('Injected rebuild failure'), 'injected_failure');
    backup = createBackup(dataRoot, currentManifest, currentActive, { reason: 'pre-rebuild' });
    if (failpoint === 'before_switch') throw operationError(new Error('Injected rebuild failure'), 'injected_failure');
    renameSync(stageDir, finalDir);
    writeJson(evidenceIndexPath(dataRoot), nextManifest);
    switched = true;
    return {
      ...resultBase,
      status: 'completed',
      generation,
      backup_path: backup.path,
      after: validation,
      journal_bytes_before: before.journal.bytes,
      journal_bytes_after: built.bytes,
      duplicate_rows_removed: before.journal.duplicate_count,
      cursor_migration: nextManifest.cursor_migration,
    };
  } catch (error) {
    if (!switched) {
      rmSync(stageDir, { recursive: true, force: true });
      rmSync(finalDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function listEvidenceJournalBackups(dataRoot) {
  const root = evidenceIndexBackupsDir(dataRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name);
      return { id: entry.name, path, metadata: safeJson(join(path, 'backup.json'), null) };
    })
    .filter((entry) => entry.metadata?.schema_version === EVIDENCE_JOURNAL_BACKUP_SCHEMA)
    .sort((a, b) => b.id.localeCompare(a.id));
}

export async function rollbackEvidenceJournal(dataRoot, {
  root = null,
  subject = null,
  backupId = null,
  dryRun = true,
  assertStopped = null,
} = {}) {
  const backups = listEvidenceJournalBackups(dataRoot);
  const selected = backupId
    ? backups.find((item) => item.id === backupId || item.path === backupId)
    : backups[0];
  if (!selected) {
    const error = new Error('No evidence journal backup matched the rollback request');
    error.code = 'evidence_journal_backup_not_found';
    throw error;
  }
  const backupSidecar = join(selected.path, selected.metadata.sidecar_directory);
  const backupManifest = selected.metadata.source_manifest ?? {};
  const workDir = mkdtempSync(join(tmpdir(), 'jea-evidence-journal-rollback-inspect-'));
  let inspect;
  try {
    inspect = await inspectAt(dataRoot, {
      journalPath: join(backupSidecar, 'entries.jsonl'),
      cursorPath: join(backupSidecar, 'cursors.json'),
      manifest: backupManifest,
      workDir,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const base = {
    schema_version: EVIDENCE_JOURNAL_REBUILD_SCHEMA,
    operation: 'rollback',
    dry_run: dryRun,
    subject,
    backup_id: selected.id,
    backup_path: selected.path,
    inspect,
  };
  if (!inspect.reconciliation.ok) {
    return { ...base, status: 'blocked', block_reason: 'backup_source_reconciliation_failed' };
  }
  if (dryRun) return { ...base, status: 'would_rollback' };
  const stoppedCheck = assertStopped
    ?? (() => assertEvidenceMaintenanceStopped(root, subject));
  stoppedCheck();

  const generation = randomUUID();
  const generations = evidenceIndexGenerationsDir(dataRoot);
  mkdirSync(generations, { recursive: true });
  const stageDir = join(generations, `.${generation}.tmp`);
  const finalDir = join(generations, generation);
  const currentManifest = safeJson(evidenceIndexPath(dataRoot), null);
  const currentActive = evidenceIndexDir(dataRoot, currentManifest);
  let switched = false;
  try {
    cpSync(backupSidecar, stageDir, {
      recursive: true,
      force: false,
      mode: constants.COPYFILE_FICLONE,
    });
    const at = new Date().toISOString();
    const cursorPath = join(stageDir, 'cursors.json');
    const priorCursors = safeJson(cursorPath, { reactors: {} });
    writeJson(cursorPath, {
      schema_version: EVIDENCE_CURSOR_SCHEMA,
      reactors: {
        ...priorCursors.reactors,
        ...Object.fromEntries(REACTORS.map((reactor) => [
          reactor,
          {
            offset: 0,
            generation,
            updated_at: at,
            migration: 'rollback_safe_replay_from_zero',
          },
        ])),
      },
      updated_at: at,
    });
    const nextManifest = {
      ...backupManifest,
      schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
      generation,
      active_directory: relative(reactorDir(dataRoot), finalDir).replace(/\\/g, '/'),
      journal_size: inspect.journal.bytes,
      journal_summary: {
        bytes: inspect.journal.bytes,
        lines: inspect.journal.valid_lines,
        valid_lines: inspect.journal.valid_lines,
        invalid_lines: inspect.journal.invalid_lines,
        unique_evidence_keys: inspect.journal.unique_evidence_keys,
        duplicate_count: inspect.journal.duplicate_count,
        rebuilt_at: at,
      },
      cursor_migration: {
        strategy: 'rollback_safe_replay_from_zero',
        reactors: REACTORS,
        exact_offset_mapping: false,
        evidence_loss_possible: false,
        replay_possible: true,
      },
      updated_at: at,
    };
    writeJson(join(stageDir, 'journal-state.json'), {
      ...readEvidenceJournalState(dataRoot),
      schema_version: EVIDENCE_JOURNAL_STATE_SCHEMA,
      generation,
      journal_bytes: inspect.journal.bytes,
      journal_lines: inspect.journal.valid_lines,
      unique_evidence_keys: inspect.journal.unique_evidence_keys,
      duplicate_count: inspect.journal.duplicate_count,
      status: evidenceJournalMaintenanceStatus(
        inspect.journal.bytes,
        resolveEvidenceJournalPolicy(),
      ),
      observed_at: at,
      last_rebuild_at: at,
      rollback_from: selected.id,
    });
    stoppedCheck();
    const currentBackup = createBackup(dataRoot, currentManifest, currentActive, {
      reason: `pre-rollback:${selected.id}`,
    });
    renameSync(stageDir, finalDir);
    writeJson(evidenceIndexPath(dataRoot), nextManifest);
    switched = true;
    return {
      ...base,
      status: 'completed',
      generation,
      previous_generation_backup: currentBackup.path,
      cursor_migration: nextManifest.cursor_migration,
    };
  } finally {
    if (!switched) {
      rmSync(stageDir, { recursive: true, force: true });
      rmSync(finalDir, { recursive: true, force: true });
    }
  }
}

export function evidenceJournalBoundedProjection(dataRoot, options = {}) {
  const manifest = safeJson(evidenceIndexPath(dataRoot), null);
  const state = readEvidenceJournalState(dataRoot, options);
  return {
    schema_version: state.schema_version,
    generation: manifest?.generation ?? null,
    manifest_schema: manifest?.schema_version ?? null,
    journal: {
      bytes: state.journal_bytes,
      lines: state.journal_lines ?? manifest?.journal_summary?.lines ?? null,
      unique_evidence_keys: state.unique_evidence_keys
        ?? manifest?.journal_summary?.unique_evidence_keys
        ?? null,
      duplicate_count: state.duplicate_count
        ?? manifest?.journal_summary?.duplicate_count
        ?? null,
    },
    maintenance: {
      status: state.status,
      due: state.maintenance_due,
      blocked: state.blocked,
      reason: state.reason,
      rotate_bytes: state.rotate_bytes,
      block_bytes: state.block_bytes,
      last_rebuild_at: state.last_rebuild_at,
    },
  };
}

export function assessEvidenceJournalMaintenance(dataRoot, { env = process.env } = {}) {
  const projection = evidenceJournalBoundedProjection(dataRoot, {
    env,
    refreshBytes: true,
  });
  const current = safeJson(evidenceJournalStatePath(dataRoot), {});
  writeJson(evidenceJournalStatePath(dataRoot), {
    ...current,
    schema_version: EVIDENCE_JOURNAL_STATE_SCHEMA,
    generation: projection.generation,
    journal_bytes: projection.journal.bytes,
    rotate_bytes: projection.maintenance.rotate_bytes,
    block_bytes: projection.maintenance.block_bytes,
    status: projection.maintenance.status,
    maintenance_due: projection.maintenance.due,
    blocked: projection.maintenance.blocked,
    reason: projection.maintenance.reason,
    observed_at: new Date().toISOString(),
  });
  return projection;
}

export const __test = Object.freeze({
  scanLines,
  dedupeCandidates,
  legacyEvidenceIndexDir,
});
