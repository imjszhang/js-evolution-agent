/**
 * Virtual evidence-stream read view (Phase 1).
 * Pure fs reads — projects scattered stores into EvidenceEnvelope[] without writing.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EVIDENCE_SOURCE_KINDS,
  evidenceKey,
  validateEvidenceEnvelope,
} from '../contracts/evidence-envelope.mjs';
import { STORE_FILES, readJsonlSafe } from './evidence-audit.mjs';

export const EVIDENCE_STREAM_SCHEMA = 'evidence-stream.v1';

/** Paths relative to dataRoot (= <JEA_HOME>/subjects/<ns>/data). */
const STREAM_PATHS = Object.freeze({
  action_receipts: STORE_FILES.action_receipts,
  evolution_events: STORE_FILES.evolution_events,
  probe_results: STORE_FILES.probe_results,
  goal_events: STORE_FILES.goal_events,
  belief_events: STORE_FILES.belief_events,
  intel_observations: STORE_FILES.intel_observations,
  reports: STORE_FILES.reports,
  verify_reports: STORE_FILES.verify_reports,
  operator_briefs: 'evolution/operator_briefs',
  operator_facts: STORE_FILES.operator_facts,
  operator_questions: 'evolution/operator_questions',
  channel_events: 'channel/events.jsonl',
});

function readTextSafe(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonSafe(absPath) {
  const text = readTextSafe(absPath);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function listJsonFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(dirPath, name));
  } catch {
    return [];
  }
}

function listJsonlFiles(dirPath) {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(dirPath, entry.name));
  } catch {
    return [];
  }
}

function pickOccurredAt(record, fallbacks = []) {
  const candidates = [
    record?.recorded_at,
    record?.created_at,
    record?.generated_at,
    record?.timestamp,
    record?.occurred_at,
    ...fallbacks,
  ];
  for (const value of candidates) {
    if (value != null && String(value).trim()) return String(value);
  }
  return '1970-01-01T00:00:00.000Z';
}

const ANON_PREFIX = Object.freeze({
  action_receipts: 'receipt-anon-',
  evolution_events: 'evt-anon-',
  probe_results: 'probe-result-anon-',
  goal_events: 'goal-event-anon-',
  belief_events: 'belief-event-anon-',
  intel_observations: 'obs-anon-',
  reports: 'report-anon-',
  verify_reports: 'verify-anon-',
  operator_briefs: 'brief-anon-',
  operator_facts: 'operator-fact-anon-',
  operator_questions: 'operator-question-anon-',
  channel_events: 'channel-event-anon-',
});

/** Deterministic id for legacy rows that predate required-id writers. */
function syntheticId(kind, file, row, index) {
  const digest = createHash('sha1')
    .update(JSON.stringify({ file, index, row }))
    .digest('hex')
    .slice(0, 16);
  return `${ANON_PREFIX[kind] ?? 'anon-'}${digest}`;
}

function makeEnvelope({
  id,
  kind,
  type,
  occurred_at,
  provenance,
  cycle_id = null,
  subject = null,
  payload = null,
}) {
  const producer = payload?.producer
    ?? payload?.evidence_producer
    ?? null;
  const activationTargets = payload?.activation_targets ?? null;
  const producerBatchId = payload?.producer_batch_id ?? payload?.batch_id ?? null;
  return {
    id: String(id),
    kind,
    type: String(type || kind),
    occurred_at: String(occurred_at),
    evidence_key: evidenceKey(kind, id),
    producer,
    producer_batch_id: producerBatchId == null ? null : String(producerBatchId),
    activation_targets: Array.isArray(activationTargets) ? activationTargets : null,
    provenance: {
      store: provenance.store ?? kind,
      file: provenance.file ?? null,
      id: provenance.id ?? String(id),
    },
    cycle_id: cycle_id == null || cycle_id === '' ? null : String(cycle_id),
    subject: subject == null || subject === '' ? null : String(subject),
    payload,
  };
}

function projectJsonlRows(kind, relPath, rows, {
  typeFrom = (row) => row?.type || row?.action_type || row?.kind || kind,
  idFrom = (row) => row?.id ?? row?.receipt_id ?? null,
  cycleFrom = (row) => row?.cycle_id ?? row?.exec_cycle_id ?? row?.intel_cycle_id ?? null,
  subjectFrom = (row) => row?.subject ?? null,
  occurredFrom = (row) => pickOccurredAt(row),
} = {}) {
  const envelopes = [];
  let disk = 0;
  let index = 0;
  for (const row of rows) {
    disk += 1;
    const rawId = idFrom(row);
    const id = (rawId != null && String(rawId).trim())
      ? String(rawId).trim()
      : syntheticId(kind, relPath, row, index);
    index += 1;
    envelopes.push(makeEnvelope({
      id,
      kind,
      type: typeFrom(row),
      occurred_at: occurredFrom(row),
      provenance: { store: kind, file: relPath, id: String(id) },
      cycle_id: cycleFrom(row),
      subject: subjectFrom(row),
      payload: row,
    }));
  }
  return { envelopes, disk };
}

function loadOperatorDirRecords(dataRoot, relBase, subdirs) {
  const records = [];
  for (const sub of subdirs) {
    const relDir = join(relBase, sub);
    const absDir = join(dataRoot, relDir);
    for (const absFile of listJsonFiles(absDir)) {
      const raw = readJsonSafe(absFile);
      if (!raw || typeof raw !== 'object') continue;
      const file = join(relDir, basename(absFile)).replace(/\\/g, '/');
      records.push({ record: raw, file, sub });
    }
  }
  return records;
}

function projectOperatorKind(kind, dataRoot, relBase, subdirs, defaultType) {
  const loaded = loadOperatorDirRecords(dataRoot, relBase, subdirs);
  const envelopes = [];
  let index = 0;
  for (const { record, file } of loaded) {
    const rawId = record?.id;
    const id = (rawId != null && String(rawId).trim())
      ? String(rawId).trim()
      : syntheticId(kind, file, record, index);
    index += 1;
    envelopes.push(makeEnvelope({
      id,
      kind,
      type: record?.type || record?.kind || defaultType,
      occurred_at: pickOccurredAt(record),
      provenance: { store: kind, file, id: String(id) },
      cycle_id: record?.cycle_id ?? null,
      subject: record?.subject ?? null,
      payload: record,
    }));
  }
  return { envelopes, disk: loaded.length };
}

function projectVerifyReports(dataRoot) {
  const relDir = STREAM_PATHS.verify_reports;
  const absDir = join(dataRoot, relDir);
  if (!existsSync(absDir)) return { envelopes: [], disk: 0 };
  let entries = [];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { envelopes: [], disk: 0 };
  }
  const envelopes = [];
  let disk = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    disk += 1;
    const id = basename(entry.name, '.json');
    const file = join(relDir, entry.name).replace(/\\/g, '/');
    const report = readJsonSafe(join(absDir, entry.name)) ?? {};
    envelopes.push(makeEnvelope({
      id,
      kind: 'verify_reports',
      type: 'verify_report',
      occurred_at: pickOccurredAt(report, [report?.semantic?.timestamp]),
      provenance: { store: 'verify_reports', file, id },
      cycle_id: report?.cycle_id ?? (String(id).startsWith('cycle-') ? id : null),
      subject: report?.subject ?? null,
      payload: report,
    }));
  }
  return { envelopes, disk };
}

function projectIntelObservations(dataRoot) {
  const relDir = STREAM_PATHS.intel_observations;
  const absDir = join(dataRoot, relDir);
  const envelopes = [];
  let disk = 0;
  for (const absFile of listJsonlFiles(absDir)) {
    const file = join(relDir, basename(absFile)).replace(/\\/g, '/');
    const rows = readJsonlSafe(absFile);
    const projected = projectJsonlRows('intel_observations', file, rows, {
      typeFrom: (row) => row?.kind || row?.type || 'observation',
      occurredFrom: (row) => pickOccurredAt(row),
    });
    disk += projected.disk;
    envelopes.push(...projected.envelopes);
  }
  return { envelopes, disk };
}

function projectChannelEvents(dataRoot) {
  const relPath = STREAM_PATHS.channel_events;
  const rows = readJsonlSafe(join(dataRoot, relPath));
  return projectJsonlRows('channel_events', relPath, rows, {
    typeFrom: (row) => row?.type || 'channel_event',
  });
}

function projectJsonlStore(kind, dataRoot) {
  const relPath = STREAM_PATHS[kind];
  const rows = readJsonlSafe(join(dataRoot, relPath));
  return projectJsonlRows(kind, relPath, rows);
}

/**
 * Load all projected envelopes for a dataRoot (unsorted).
 * @param {string} dataRoot
 * @returns {{ envelopes: object[], diskCounts: Record<string, number> }}
 */
export function loadEvidenceStreamRaw(dataRoot) {
  if (!dataRoot) throw new Error('loadEvidenceStreamRaw requires dataRoot');

  const byKind = {
    action_receipts: projectJsonlStore('action_receipts', dataRoot),
    evolution_events: projectJsonlStore('evolution_events', dataRoot),
    probe_results: projectJsonlStore('probe_results', dataRoot),
    goal_events: projectJsonlStore('goal_events', dataRoot),
    belief_events: projectJsonlStore('belief_events', dataRoot),
    intel_observations: projectIntelObservations(dataRoot),
    reports: projectJsonlStore('reports', dataRoot),
    verify_reports: projectVerifyReports(dataRoot),
    operator_briefs: projectOperatorKind(
      'operator_briefs',
      dataRoot,
      STREAM_PATHS.operator_briefs,
      ['pending', 'processed'],
      'operator_brief',
    ),
    operator_facts: projectOperatorKind(
      'operator_facts',
      dataRoot,
      STREAM_PATHS.operator_facts,
      ['pending', 'digested'],
      'operator_fact',
    ),
    operator_questions: projectOperatorKind(
      'operator_questions',
      dataRoot,
      STREAM_PATHS.operator_questions,
      ['pending', 'resolved'],
      'operator_question',
    ),
    channel_events: projectChannelEvents(dataRoot),
  };

  const envelopes = [];
  const diskCounts = {};
  for (const kind of EVIDENCE_SOURCE_KINDS) {
    const projected = byKind[kind] ?? { envelopes: [], disk: 0 };
    diskCounts[kind] = projected.disk;
    envelopes.push(...projected.envelopes);
  }
  return { envelopes, diskCounts };
}

function normalizeKinds(kinds) {
  if (kinds == null) return null;
  const list = Array.isArray(kinds)
    ? kinds
    : String(kinds).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  return new Set(list);
}

/**
 * Virtual read view: merge scattered evidence sources into a sorted envelope stream.
 *
 * @param {string} dataRoot <JEA_HOME>/subjects/<ns>/data
 * @param {{ since?: string, limit?: number, kinds?: string[]|string, cycleId?: string }} [opts]
 * @returns {object[]}
 */
export function readEvidenceStream(dataRoot, {
  since = null,
  limit = null,
  kinds = null,
  cycleId = null,
} = {}) {
  const { envelopes } = loadEvidenceStreamRaw(dataRoot);
  const kindSet = normalizeKinds(kinds);
  const sinceMs = since ? Date.parse(String(since)) : NaN;
  const cycle = cycleId ? String(cycleId) : null;

  let filtered = envelopes;
  if (kindSet) {
    filtered = filtered.filter((e) => kindSet.has(e.kind));
  }
  if (Number.isFinite(sinceMs)) {
    filtered = filtered.filter((e) => {
      const t = Date.parse(e.occurred_at);
      return Number.isFinite(t) ? t >= sinceMs : true;
    });
  }
  if (cycle) {
    filtered = filtered.filter((e) => e.cycle_id === cycle || e.id === cycle);
  }

  filtered = [...filtered].sort((a, b) => {
    const at = String(a.occurred_at);
    const bt = String(b.occurred_at);
    if (at !== bt) return at.localeCompare(bt);
    return String(a.id).localeCompare(String(b.id));
  });

  if (limit != null && Number.isFinite(Number(limit)) && Number(limit) >= 0) {
    filtered = filtered.slice(0, Math.floor(Number(limit)));
  }
  return filtered;
}

/**
 * Reconcile: compare projected stream against per-source disk counts and contract validity.
 *
 * @param {string} dataRoot
 * @returns {object}
 */
export function reconcileEvidenceStream(dataRoot) {
  const { envelopes, diskCounts } = loadEvidenceStreamRaw(dataRoot);
  const streamCounts = {};
  for (const kind of EVIDENCE_SOURCE_KINDS) streamCounts[kind] = 0;

  const idCounts = new Map();
  const contractErrors = [];
  for (const envelope of envelopes) {
    streamCounts[envelope.kind] = (streamCounts[envelope.kind] ?? 0) + 1;
    const key = `${envelope.kind}:${envelope.id}`;
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
    const validation = validateEvidenceEnvelope(envelope);
    if (!validation.ok) {
      contractErrors.push({
        id: envelope.id,
        kind: envelope.kind,
        errors: validation.errors,
      });
    }
  }

  const duplicateIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));

  const sources = EVIDENCE_SOURCE_KINDS.map((kind) => {
    const disk = diskCounts[kind] ?? 0;
    const stream = streamCounts[kind] ?? 0;
    return {
      kind,
      disk,
      stream,
      ok: disk === stream,
    };
  });

  const mismatched = sources.filter((s) => !s.ok);
  // Count parity + contract validity are hard gates. Duplicate source ids are
  // reported as data-quality warnings (legacy append-only history may repeat).
  const ok = mismatched.length === 0 && contractErrors.length === 0;

  return {
    schema_version: EVIDENCE_STREAM_SCHEMA,
    ok,
    total: envelopes.length,
    sources,
    mismatched,
    duplicate_ids: duplicateIds,
    contract_errors: contractErrors.slice(0, 50),
    contract_error_count: contractErrors.length,
  };
}
