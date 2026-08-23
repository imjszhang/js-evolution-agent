/**
 * Read-only closure integrity projection.
 *
 * Historical records without correlation metadata are deliberately classified
 * as legacy_unknown. This module never infers causality from timestamps.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractBeliefContext } from '../contracts/belief-context.mjs';
import {
  claimsTerminalArchivePath,
  readClaimLedgerReadonly,
  coveredEventIds,
} from '../evolution/reactor/claim-ledger.mjs';
import { scanTerminalClaims } from '../evolution/reactor/claim-terminal-store.mjs';
import {
  defaultKindsForReactor,
  envelopeEvidenceKey,
  isEligibleForReactor,
} from '../evolution/reactor/eligibility.mjs';
import {
  projectEvidenceRecord,
  readEvidenceStream,
} from './evidence-stream.mjs';
import { STORE_FILES } from './evidence-audit.mjs';
import { evaluateClosureTarget } from './closure-target.mjs';
import {
  evidenceJournalBoundedProjection,
} from '../evolution/reactor/evidence-journal-maintenance.mjs';

export const CLOSURE_AUDIT_SCHEMA = 'closure-audit.v1';
export const CLOSURE_AUDIT_METRICS = Object.freeze([
  'decision_coverage',
  'causal_correlation',
  'batch_scoped_refs',
  'duplicate_settlement_candidates',
  'standing_memory_freshness',
  'evidence_backlog',
  'daemon_task_backlog',
]);

const EXECUTABLE_ACTIONS = new Set(['agent_run', 'agent_execute']);
const SETTLEMENT_CHANGES = new Set([
  'create',
  'strengthen',
  'weaken',
  'validate',
  'refute',
  'retire',
  'reopen',
  'updated',
  'patched',
  'applied',
  'settled',
]);

function ratio(covered, total) {
  return total > 0 ? Number((covered / total).toFixed(4)) : null;
}

function parseTime(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

function readJsonDocument(path, fallback, {
  required = true,
  validate = () => true,
  maxBytes = null,
} = {}) {
  if (!existsSync(path)) {
    return {
      state: 'missing',
      value: fallback,
      required,
      reason: required ? 'required_source_missing' : 'optional_source_missing',
    };
  }
  try {
    if (Number.isFinite(maxBytes) && statSync(path).size > maxBytes) {
      return {
        state: 'oversized',
        value: fallback,
        required,
        reason: 'source_oversized',
        bytes: statSync(path).size,
      };
    }
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!validate(value)) {
      return {
        state: 'corrupt',
        value: fallback,
        required,
        reason: 'invalid_json_shape',
      };
    }
    return { state: 'ok', value, required, reason: null };
  } catch (error) {
    return {
      state: 'corrupt',
      value: fallback,
      required,
      reason: 'invalid_json',
      error: String(error?.message || error),
    };
  }
}

function readJsonlDocument(path, { required = true } = {}) {
  if (!existsSync(path)) {
    return {
      state: 'missing',
      value: [],
      required,
      reason: required ? 'required_source_missing' : 'optional_source_missing',
    };
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      state: 'corrupt',
      value: [],
      required,
      reason: 'source_unreadable',
      error: String(error?.message || error),
    };
  }
  const lines = text.split('\n');
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      const truncated = index === lines.length - 1 && !text.endsWith('\n');
      return {
        state: 'corrupt',
        value: [],
        required,
        reason: truncated ? 'truncated_jsonl_line' : 'invalid_jsonl',
        line: index + 1,
        error: String(error?.message || error),
      };
    }
  }
  return { state: 'ok', value: rows, required, reason: null };
}

function readJsonDirectory(path, { required = true } = {}) {
  if (!existsSync(path)) {
    return {
      state: 'missing',
      value: [],
      required,
      reason: required ? 'required_source_missing' : 'optional_source_missing',
    };
  }
  let names;
  try {
    names = readdirSync(path).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    return {
      state: 'corrupt',
      value: [],
      required,
      reason: 'source_unreadable',
      error: String(error?.message || error),
    };
  }
  const rows = [];
  for (const name of names) {
    try {
      rows.push({
        file: name,
        value: JSON.parse(readFileSync(join(path, name), 'utf8')),
      });
    } catch (error) {
      return {
        state: 'corrupt',
        value: [],
        required,
        reason: 'invalid_json',
        file: name,
        error: String(error?.message || error),
      };
    }
  }
  return { state: 'ok', value: rows, required, reason: null };
}

function projectStrictJsonl(kind, relativePath, doc) {
  if (doc.state !== 'ok') return [];
  return doc.value.map((record, index) => projectEvidenceRecord(kind, record, {
    file: relativePath,
    index,
  }));
}

function projectStrictJsonDirectory(kind, relativeDir, doc) {
  if (doc.state !== 'ok') return [];
  return doc.value.map(({ file, value }) => projectEvidenceRecord(kind, value, {
    file: join(relativeDir, file).replace(/\\/g, '/'),
    id: file.replace(/\.json$/i, ''),
  }));
}

function firstValue(record, paths) {
  for (const path of paths) {
    let value = record;
    for (const part of path.split('.')) value = value?.[part];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function actionRunSpec(decision) {
  return decision?.action?.params?.run_spec
    ?? decision?.action?.run_spec
    ?? {};
}

function actionContext(decision) {
  return extractBeliefContext(decision?.action);
}

function hasContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && String(value).trim().length > 0;
}

function hasCurrentRecordMarker(record, fields = null) {
  const schema = Number(record?.schema_version ?? record?.schemaVersion);
  if (Number.isFinite(schema) && schema >= 1) return true;
  const values = fields ?? [
    'producer_batch_id',
    'batch_id',
    'reaction_id',
    'decision_id',
    'execution_id',
    'settlement_id',
    'verification_window_id',
  ];
  return values.some((field) => firstValue(record, [
    field,
    `metadata.${field}`,
  ]));
}

function decisionCoverage(decisions) {
  let beliefBound = 0;
  let explicitNoBelief = 0;
  let beliefLegacyUnknown = 0;
  let beliefFailed = 0;
  let expectedOutputCovered = 0;
  let expectedOutputLegacyUnknown = 0;
  let expectedOutputFailed = 0;
  let executable = 0;

  for (const decision of decisions) {
    const context = actionContext(decision);
    const relation = firstValue(context, ['belief_relation']);
    const bound = Boolean(firstValue(context, ['belief_id']));
    const noBeliefReason = firstValue(context, [
      'no_belief_reason',
      'mechanical_reason',
      'belief_exemption_reason',
    ]) || (decision?.action?.origin === 'mechanical_guard' ? 'mechanical_guard' : null);
    const currentRecord = hasCurrentRecordMarker(decision);
    if (bound || relation === 'create_belief') beliefBound += 1;
    else if (noBeliefReason) explicitNoBelief += 1;
    else if (currentRecord) beliefFailed += 1;
    else beliefLegacyUnknown += 1;

    if (!EXECUTABLE_ACTIONS.has(decision?.action?.type)) continue;
    executable += 1;
    const spec = actionRunSpec(decision);
    const expected = spec.expected_output
      ?? spec.expectedOutput
      ?? decision?.action?.params?.expected_output
      ?? decision?.action?.params?.expectedOutput;
    if (hasContent(expected)) expectedOutputCovered += 1;
    else if (currentRecord) expectedOutputFailed += 1;
    else expectedOutputLegacyUnknown += 1;
  }

  const beliefKnown = beliefBound + explicitNoBelief;
  return {
    decisions_total: decisions.length,
    belief_binding: {
      bound: beliefBound,
      explicit_no_belief_reason: explicitNoBelief,
      failed: beliefFailed,
      legacy_unknown: beliefLegacyUnknown,
      known_coverage: beliefKnown,
      coverage_ratio: ratio(beliefKnown, decisions.length),
    },
    expected_output: {
      executable_decisions: executable,
      covered: expectedOutputCovered,
      failed: expectedOutputFailed,
      legacy_unknown: expectedOutputLegacyUnknown,
      coverage_ratio: ratio(expectedOutputCovered, executable),
    },
  };
}

function correlationSummary(records, requiredFields, resolver, {
  causalFields = requiredFields,
  isCurrentRecord = (record) => hasCurrentRecordMarker(record),
} = {}) {
  let reopenable = 0;
  let partial = 0;
  let legacyUnknown = 0;
  const missingByField = Object.fromEntries(requiredFields.map((field) => [field, 0]));
  const reopenableIds = [];

  for (const record of records) {
    const fields = resolver(record);
    const missing = requiredFields.filter((field) => !fields[field]);
    for (const field of missing) missingByField[field] += 1;
    if (missing.length === 0) {
      reopenable += 1;
      reopenableIds.push(fields);
    } else if (causalFields.every((field) => !fields[field]) && !isCurrentRecord(record, fields)) {
      legacyUnknown += 1;
    } else {
      partial += 1;
    }
  }
  return {
    total: records.length,
    reopenable,
    partial,
    legacy_unknown: legacyUnknown,
    coverage_ratio: ratio(reopenable, records.length),
    missing_by_field: missingByField,
    reopenable_ids: reopenableIds,
  };
}

function decisionCorrelation(decision) {
  return {
    producer_batch_id: firstValue(decision, [
      'producer_batch_id',
      'batch_id',
      'metadata.producer_batch_id',
      'metadata.batch_id',
    ]),
    reaction_id: firstValue(decision, ['reaction_id', 'metadata.reaction_id']),
    decision_id: firstValue(decision, ['decision_id', 'id']),
  };
}

function receiptCorrelation(receipt) {
  return {
    receipt_id: firstValue(receipt, ['id', 'receipt_id']),
    producer_batch_id: firstValue(receipt, ['producer_batch_id', 'batch_id']),
    reaction_id: firstValue(receipt, ['reaction_id']),
    decision_id: firstValue(receipt, ['decision_id', 'action.decision_id']),
    execution_id: firstValue(receipt, ['execution_id', 'exec_cycle_id']),
    belief_id: firstValue(receipt, ['belief_id', 'action.params.run_spec.context.belief_id']),
  };
}

function verifyCorrelation(report) {
  const executionIds = report?.execution_ids
    ?? report?.verified_execution_ids
    ?? report?.executions
    ?? (report?.execution_id ? [report.execution_id] : []);
  return {
    producer_batch_id: firstValue(report, ['producer_batch_id', 'batch_id']),
    reaction_id: firstValue(report, ['reaction_id']),
    decision_id: firstValue(report, ['decision_id', 'decision_ids.0']),
    execution_id: Array.isArray(executionIds) && executionIds.length
      ? String(executionIds[0])
      : null,
    verify_id: firstValue(report, ['verify_id', 'verification_id', 'id']),
    belief_id: firstValue(report, ['belief_id']),
  };
}

function eventRefs(record) {
  return Array.isArray(record?.evidence_refs)
    ? record.evidence_refs.map((ref) => String(ref))
    : [];
}

function settlementTarget(record, kind) {
  return kind === 'belief'
    ? firstValue(record, ['belief_id', 'after.id'])
    : firstValue(record, ['goal_id', 'target_goal_id', 'patch.goal_id']);
}

function settlementWindow(record) {
  const direct = firstValue(record, [
    'settlement_id',
    'verification_window_id',
    'verify_id',
    'verification_id',
    'verify_report_id',
    'execution_id',
    'producer_batch_id',
  ]);
  if (direct) return direct;
  return eventRefs(record).find((ref) => /^(?:verify_report|verify_reports|action_receipt|action_receipts):/.test(ref))
    ?? null;
}

function settlementRecords(envelopes) {
  const records = [];
  for (const envelope of envelopes) {
    let kind = null;
    if (envelope.kind === 'belief_events') kind = 'belief';
    if (envelope.kind === 'goal_events') kind = 'goal';
    if (!kind) continue;
    const payload = envelope.payload ?? {};
    const change = String(payload.change ?? payload.type ?? '').toLowerCase();
    const target = settlementTarget(payload, kind);
    if (!target || !SETTLEMENT_CHANGES.has(change)) continue;
    records.push({
      id: envelope.id,
      kind,
      target_id: target,
      change,
      window_id: settlementWindow(payload),
      occurred_at: envelope.occurred_at,
      payload,
    });
  }
  return records;
}

function duplicateSettlements(settlements) {
  const groups = new Map();
  let legacyUnknown = 0;
  for (const item of settlements) {
    if (!item.window_id) {
      legacyUnknown += 1;
      continue;
    }
    const key = `${item.kind}:${item.target_id}:${item.window_id}`;
    const group = groups.get(key) ?? {
      kind: item.kind,
      target_id: item.target_id,
      window_id: item.window_id,
      event_ids: [],
    };
    group.event_ids.push(item.id);
    groups.set(key, group);
  }
  const candidates = [...groups.values()]
    .filter((group) => group.event_ids.length > 1)
    .sort((a, b) => `${a.kind}:${a.target_id}:${a.window_id}`.localeCompare(`${b.kind}:${b.target_id}:${b.window_id}`));
  return {
    settlement_events: settlements.length,
    comparable_events: settlements.length - legacyUnknown,
    legacy_unknown: legacyUnknown,
    candidate_groups: candidates.length,
    duplicate_event_count: candidates.reduce((sum, group) => sum + group.event_ids.length - 1, 0),
    candidates,
  };
}

function latestSettlementTime(settlements) {
  const values = settlements
    .filter((item) => (
      item.kind === 'belief'
      && item.window_id
      && ['validate', 'refute', 'retire'].includes(item.change)
    ))
    .map((item) => parseTime(item.occurred_at))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function memoryFreshness(memoryDoc, memoryState, settlements, nowMs) {
  const settledBeliefs = settlements.filter((item) => (
    item.kind === 'belief'
    && item.window_id
    && ['validate', 'refute', 'retire'].includes(item.change)
  ));
  const latestSettled = [...settledBeliefs]
    .sort((a, b) => (
      (parseTime(a.occurred_at) ?? 0) - (parseTime(b.occurred_at) ?? 0)
      || String(a.id).localeCompare(String(b.id))
    ))
    .at(-1) ?? null;
  const latestSettledCursor = latestSettled?.id ? `belief_events:${latestSettled.id}` : null;
  const memoryCursor = memoryDoc?.last_settled_cursor ?? null;
  if (memoryState === 'corrupt') {
    return {
      exists: true,
      status: 'corrupt',
      updated_at: null,
      age_ms: null,
      latest_settlement_at: null,
      settlement_lag_ms: null,
      last_settled_cursor: null,
      latest_settled_cursor: latestSettledCursor,
      cursor_status: 'corrupt',
    };
  }
  if (memoryState === 'missing') {
    const settlementMs = latestSettlementTime(settlements);
    return {
      exists: false,
      status: settlementMs == null ? 'not_applicable' : 'missing',
      updated_at: null,
      age_ms: null,
      latest_settlement_at: settlementMs == null
        ? null
        : new Date(settlementMs).toISOString(),
      settlement_lag_ms: null,
      last_settled_cursor: null,
      latest_settled_cursor: latestSettledCursor,
      cursor_status: latestSettledCursor ? 'missing' : 'empty',
    };
  }
  const memoryMs = parseTime(memoryDoc?.updated_at ?? memoryDoc?.generated_at ?? memoryDoc?.timestamp);
  const settlementMs = latestSettlementTime(settlements);
  if (memoryMs == null) {
    return {
      exists: true,
      status: 'legacy_unknown',
      updated_at: null,
      age_ms: null,
      latest_settlement_at: settlementMs == null ? null : new Date(settlementMs).toISOString(),
      settlement_lag_ms: null,
      last_settled_cursor: memoryCursor,
      latest_settled_cursor: latestSettledCursor,
      cursor_status: memoryCursor ? 'legacy_unknown' : 'missing',
    };
  }
  const lag = settlementMs == null ? 0 : Math.max(0, settlementMs - memoryMs);
  const cursorStatus = latestSettledCursor == null
    ? (memoryCursor ? 'ahead_or_retained' : 'empty')
    : memoryCursor === latestSettledCursor
      ? 'current'
      : memoryCursor
        ? 'behind'
        : 'missing';
  return {
    exists: true,
    status: lag > 0 || cursorStatus === 'behind' || cursorStatus === 'missing' ? 'stale' : 'fresh',
    updated_at: new Date(memoryMs).toISOString(),
    age_ms: Math.max(0, nowMs - memoryMs),
    latest_settlement_at: settlementMs == null ? null : new Date(settlementMs).toISOString(),
    settlement_lag_ms: lag,
    last_settled_cursor: memoryCursor,
    latest_settled_cursor: latestSettledCursor,
    cursor_status: cursorStatus,
    freshness: memoryDoc?.freshness ?? null,
  };
}

function ageBucket(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  if (ageMs < 3600_000) return 'under_1h';
  if (ageMs < 24 * 3600_000) return '1h_to_24h';
  if (ageMs < 7 * 24 * 3600_000) return '1d_to_7d';
  return 'over_7d';
}

function evidenceBacklog(envelopes, ledger, nowMs) {
  const covered = coveredEventIds(ledger, { now: nowMs, reactor: 'cognitive' });
  const kinds = defaultKindsForReactor('cognitive');
  const pending = envelopes.filter((envelope) => {
    if (!isEligibleForReactor(envelope, 'cognitive', { kinds })) return false;
    const key = envelopeEvidenceKey(envelope);
    return !covered.has(key) && !covered.has(envelope.id);
  });
  const byKind = {};
  const ageBuckets = {
    under_1h: 0,
    '1h_to_24h': 0,
    '1d_to_7d': 0,
    over_7d: 0,
    unknown: 0,
  };
  const keyCounts = new Map();
  let oldestAge = null;
  let oldestId = null;
  for (const envelope of pending) {
    byKind[envelope.kind] = (byKind[envelope.kind] ?? 0) + 1;
    const key = envelopeEvidenceKey(envelope);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    const occurred = parseTime(envelope.occurred_at);
    const age = occurred == null ? null : Math.max(0, nowMs - occurred);
    ageBuckets[ageBucket(age)] += 1;
    if (age != null && (oldestAge == null || age > oldestAge)) {
      oldestAge = age;
      oldestId = envelope.id;
    }
  }
  const duplicates = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([evidence_key, count]) => ({ evidence_key, count }))
    .sort((a, b) => a.evidence_key.localeCompare(b.evidence_key));
  return {
    pending_count: pending.length,
    by_kind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
    oldest_age_ms: oldestAge,
    oldest_id: oldestId,
    age_buckets: ageBuckets,
    duplicate_keys: duplicates.length,
    duplicate_envelope_count: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
    duplicates,
  };
}

function daemonBacklog(tasks) {
  const counts = {};
  for (const task of tasks) {
    const status = task?.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return {
    total: tasks.length,
    pending: counts.pending ?? 0,
    running: counts.running ?? 0,
    active: (counts.pending ?? 0) + (counts.running ?? 0),
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function sourceDiagnostic(name, path, doc) {
  return {
    source: name,
    path,
    state: doc.state,
    required: doc.required !== false,
    reason: doc.reason ?? null,
    ...(doc.line ? { line: doc.line } : {}),
    ...(doc.file ? { file: doc.file } : {}),
    ...(doc.error ? { error: doc.error } : {}),
  };
}

/**
 * Build the complete closure audit using only read APIs and filesystem reads.
 */
export function runClosureAudit({
  subject,
  namespace,
  runtimeRoot,
  dataRoot,
  nowMs = Date.now(),
} = {}) {
  const evolutionDir = join(dataRoot, 'evolution');
  const queuePath = join(evolutionDir, 'pending_decisions.json');
  const claimsFile = join(evolutionDir, 'reactor', 'claims.json');
  const beliefsPath = join(dataRoot, STORE_FILES.beliefs);
  const memoryPath = join(dataRoot, STORE_FILES.standing_memory);
  const tasksPath = join(evolutionDir, 'tasks', 'pending_tasks.json');
  const claimsArchiveFile = join(evolutionDir, 'reactor', 'archive', 'claims.json');
  const claimsTerminalArchiveFile = claimsTerminalArchivePath(dataRoot);
  const claimsArchiveMarkerFile = join(evolutionDir, 'reactor', 'archive', 'claims-archive-migration.json');
  const claimsIndexFile = join(evolutionDir, 'reactor', 'archive', 'claims-covered-index.json');
  const actionReceiptsPath = join(dataRoot, STORE_FILES.action_receipts);
  const beliefEventsPath = join(dataRoot, STORE_FILES.belief_events);
  const goalEventsPath = join(dataRoot, STORE_FILES.goal_events);
  const verifyReportsPath = join(dataRoot, STORE_FILES.verify_reports);
  const objectValue = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

  const queueDoc = readJsonDocument(queuePath, { decisions: [] }, {
    validate: (value) => objectValue(value) && Array.isArray(value.decisions),
  });
  const claimsDoc = readJsonDocument(claimsFile, { claims: [], updated_at: null }, {
    validate: (value) => objectValue(value) && Array.isArray(value.claims),
    maxBytes: 16 * 1024 * 1024,
  });
  const claimsArchiveMarkerDoc = readJsonDocument(claimsArchiveMarkerFile, null, {
    required: false,
    validate: (value) => objectValue(value) && value.status === 'copied',
  });
  const rawClaimsArchiveDoc = readJsonDocument(claimsArchiveFile, { claims: [] }, {
    required: false,
    validate: (value) => objectValue(value) && Array.isArray(value.claims),
    maxBytes: 16 * 1024 * 1024,
  });
  const claimsArchiveDoc = rawClaimsArchiveDoc.state === 'oversized'
    && claimsArchiveMarkerDoc.state === 'ok'
    ? {
      state: 'ok',
      value: { claims: [] },
      required: false,
      reason: 'legacy_archive_migrated',
    }
    : rawClaimsArchiveDoc;
  const terminalFingerprints = new Map();
  let terminalConflicts = 0;
  let terminalConflictCheckTruncated = false;
  const terminalArchiveStats = scanTerminalClaims(claimsTerminalArchiveFile, (claim) => {
    if (!claim.batch_id) return;
    const fingerprint = JSON.stringify(claim);
    if (terminalFingerprints.has(claim.batch_id)) {
      if (terminalFingerprints.get(claim.batch_id) !== fingerprint) terminalConflicts += 1;
      return;
    }
    if (terminalFingerprints.size >= 100_000) {
      terminalConflictCheckTruncated = true;
      return;
    }
    terminalFingerprints.set(claim.batch_id, fingerprint);
  });
  const claimsTerminalArchiveDoc = !existsSync(claimsTerminalArchiveFile)
    ? { state: 'missing', value: [], required: false, reason: 'optional_source_missing' }
    : terminalArchiveStats.invalid > 0
      ? {
        state: 'corrupt',
        value: [],
        required: false,
        reason: 'invalid_jsonl',
        error: `${terminalArchiveStats.invalid} invalid terminal claim line(s)`,
      }
      : {
        state: 'ok',
        value: [],
        required: false,
        reason: terminalConflicts
          ? 'duplicate_claim_conflicts'
          : terminalConflictCheckTruncated
            ? 'duplicate_claim_check_bounded'
            : null,
      };
  const claimsIndexDoc = readJsonDocument(claimsIndexFile, { reactors: {} }, {
    required: false,
    validate: (value) => objectValue(value) && objectValue(value.reactors),
  });
  const beliefsDoc = readJsonDocument(beliefsPath, null, { validate: objectValue });
  const memoryDoc = readJsonDocument(memoryPath, null, { validate: objectValue });
  const tasksDoc = readJsonDocument(tasksPath, { tasks: [] }, {
    validate: (value) => objectValue(value) && Array.isArray(value.tasks),
  });
  const actionReceiptsDoc = readJsonlDocument(actionReceiptsPath);
  const beliefEventsDoc = readJsonlDocument(beliefEventsPath);
  const goalEventsDoc = readJsonlDocument(goalEventsPath);
  const verifyReportsDoc = readJsonDirectory(verifyReportsPath);
  const evidenceDocs = [
    ['action_receipts', actionReceiptsPath, actionReceiptsDoc],
    ['belief_events', beliefEventsPath, beliefEventsDoc],
    ['goal_events', goalEventsPath, goalEventsDoc],
    ['verify_reports', verifyReportsPath, verifyReportsDoc],
  ];

  const decisions = queueDoc.state === 'ok' && Array.isArray(queueDoc.value?.decisions)
    ? queueDoc.value.decisions
    : [];
  const claimReadSafe = (claimsDoc.state === 'ok' || claimsDoc.state === 'missing')
    && claimsArchiveDoc.state !== 'corrupt'
    && claimsTerminalArchiveDoc.state !== 'corrupt'
    && claimsIndexDoc.state !== 'corrupt';
  const ledger = claimReadSafe
    ? readClaimLedgerReadonly(dataRoot)
    : { claims: [], updated_at: null };
  const tasks = tasksDoc.state === 'ok' && Array.isArray(tasksDoc.value?.tasks)
    ? tasksDoc.value.tasks
    : [];
  const requiredKinds = new Set([
    'action_receipts',
    'belief_events',
    'goal_events',
    'verify_reports',
  ]);
  let envelopes = [
    ...projectStrictJsonl('action_receipts', STORE_FILES.action_receipts, actionReceiptsDoc),
    ...projectStrictJsonl('belief_events', STORE_FILES.belief_events, beliefEventsDoc),
    ...projectStrictJsonl('goal_events', STORE_FILES.goal_events, goalEventsDoc),
    ...projectStrictJsonDirectory('verify_reports', STORE_FILES.verify_reports, verifyReportsDoc),
  ];
  let streamState = evidenceDocs.every(([, , doc]) => doc.state === 'ok') ? 'ok' : 'corrupt';
  let streamReason = streamState === 'ok' ? null : 'required_evidence_source_invalid';
  let streamError = null;
  try {
    const optionalEnvelopes = readEvidenceStream(dataRoot)
      .filter((envelope) => !requiredKinds.has(envelope.kind));
    envelopes.push(...optionalEnvelopes);
    envelopes.sort((a, b) => (
      String(a.occurred_at).localeCompare(String(b.occurred_at))
      || String(a.id).localeCompare(String(b.id))
    ));
  } catch (error) {
    streamState = 'corrupt';
    streamReason = 'evidence_stream_read_failed';
    streamError = String(error?.message || error);
  }
  const receipts = envelopes
    .filter((envelope) => envelope.kind === 'action_receipts')
    .map((envelope) => envelope.payload ?? {});
  const verifyReports = envelopes
    .filter((envelope) => envelope.kind === 'verify_reports')
    .map((envelope) => ({ id: envelope.id, ...(envelope.payload ?? {}) }));
  const settlements = settlementRecords(envelopes);

  const receiptBatchRefs = receipts
    .filter((record) => firstValue(record, ['producer_batch_id', 'batch_id']))
    .map((record) => ({
      receipt_id: firstValue(record, ['id', 'receipt_id']),
      producer_batch_id: firstValue(record, ['producer_batch_id', 'batch_id']),
      decision_id: firstValue(record, ['decision_id']),
      execution_id: firstValue(record, ['execution_id', 'exec_cycle_id']),
      reaction_id: firstValue(record, ['reaction_id']),
      belief_id: firstValue(record, ['belief_id']),
    }));
  const verifyBatchRefs = verifyReports
    .filter((record) => firstValue(record, ['producer_batch_id', 'batch_id']))
    .map((record) => ({
      verify_id: firstValue(record, ['verify_id', 'verification_id', 'id']),
      producer_batch_id: firstValue(record, ['producer_batch_id', 'batch_id']),
      reaction_id: firstValue(record, ['reaction_id']),
      decision_ids: record?.decision_ids ?? (record?.decision_id ? [record.decision_id] : []),
      execution_ids: record?.execution_ids
        ?? record?.verified_execution_ids
        ?? (record?.execution_id ? [record.execution_id] : []),
    }));

  const audit = {
    schema_version: CLOSURE_AUDIT_SCHEMA,
    generated_at: new Date(nowMs).toISOString(),
    subject,
    namespace,
    runtime: runtimeRoot,
    compatibility: {
      historical_missing_metadata: 'legacy_unknown',
      causality_inference: 'disabled',
    },
    metrics: {
      decision_coverage: decisionCoverage(decisions),
      causal_correlation: {
        decisions: correlationSummary(
          decisions,
          ['producer_batch_id', 'reaction_id', 'decision_id'],
          decisionCorrelation,
          { causalFields: ['producer_batch_id', 'reaction_id'] },
        ),
        receipts: correlationSummary(
          receipts,
          ['producer_batch_id', 'reaction_id', 'decision_id', 'execution_id'],
          receiptCorrelation,
          {
            causalFields: ['producer_batch_id', 'reaction_id'],
            isCurrentRecord: (record) => hasCurrentRecordMarker(record, [
              'producer_batch_id',
              'batch_id',
              'reaction_id',
            ]),
          },
        ),
        verify_reports: correlationSummary(
          verifyReports,
          ['producer_batch_id', 'reaction_id', 'execution_id', 'verify_id'],
          verifyCorrelation,
          {
            causalFields: ['producer_batch_id', 'reaction_id'],
            isCurrentRecord: (record) => hasCurrentRecordMarker(record, [
              'producer_batch_id',
              'batch_id',
              'reaction_id',
            ]),
          },
        ),
        settlement_events: correlationSummary(
          settlements,
          ['target_id', 'verification_window_id'],
          (item) => ({
            event_id: item.id,
            target_id: item.target_id,
            verification_window_id: item.window_id,
            producer_batch_id: firstValue(item.payload, ['producer_batch_id']),
            reaction_id: firstValue(item.payload, ['reaction_id']),
            decision_id: firstValue(item.payload, ['decision_id']),
            execution_id: firstValue(item.payload, ['execution_id']),
            belief_id: firstValue(item.payload, ['belief_id']),
          }),
          {
            causalFields: ['verification_window_id'],
            isCurrentRecord: (item) => hasCurrentRecordMarker(item.payload),
          },
        ),
      },
      batch_scoped_refs: {
        receipts: {
          total: receipts.length,
          covered: receiptBatchRefs.length,
          legacy_unknown: receipts.length - receiptBatchRefs.length,
          coverage_ratio: ratio(receiptBatchRefs.length, receipts.length),
          refs: receiptBatchRefs,
        },
        verify_reports: {
          total: verifyReports.length,
          covered: verifyBatchRefs.length,
          legacy_unknown: verifyReports.length - verifyBatchRefs.length,
          coverage_ratio: ratio(verifyBatchRefs.length, verifyReports.length),
          refs: verifyBatchRefs,
        },
      },
      duplicate_settlement_candidates: duplicateSettlements(settlements),
      standing_memory_freshness: memoryFreshness(
        memoryDoc.value,
        memoryDoc.state,
        settlements,
        nowMs,
      ),
      evidence_backlog: evidenceBacklog(envelopes, ledger, nowMs),
      // Journal maintenance never scans entries.jsonl on the closure path.
      evidence_journal: evidenceJournalBoundedProjection(dataRoot),
      daemon_task_backlog: daemonBacklog(tasks),
    },
    diagnostics: [
      sourceDiagnostic('decision_queue', queuePath, queueDoc),
      sourceDiagnostic('claim_ledger', claimsFile, claimsDoc),
      sourceDiagnostic('claim_archive', claimsArchiveFile, claimsArchiveDoc),
      sourceDiagnostic('claim_archive_migration', claimsArchiveMarkerFile, claimsArchiveMarkerDoc),
      sourceDiagnostic('claim_terminal_archive', claimsTerminalArchiveFile, claimsTerminalArchiveDoc),
      sourceDiagnostic('claim_covered_index', claimsIndexFile, claimsIndexDoc),
      sourceDiagnostic('current_beliefs', beliefsPath, beliefsDoc),
      sourceDiagnostic('standing_memory', memoryPath, memoryDoc),
      sourceDiagnostic('daemon_tasks', tasksPath, tasksDoc),
      ...evidenceDocs.map(([name, path, doc]) => sourceDiagnostic(name, path, doc)),
      {
        source: 'evidence_stream',
        path: dataRoot,
        state: streamState,
        required: true,
        reason: streamReason,
        ...(streamError ? { error: streamError } : {}),
      },
    ],
  };
  audit.gate = evaluateClosureTarget(audit);
  audit.ok = audit.gate.ok;
  audit.status = audit.gate.status;
  return audit;
}

function flatten(value, prefix, lines) {
  if (Array.isArray(value)) {
    lines.push(`${prefix}: ${JSON.stringify(value)}`);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      lines.push(`${prefix}: {}`);
      return;
    }
    for (const [key, child] of entries) {
      flatten(child, prefix ? `${prefix}.${key}` : key, lines);
    }
    return;
  }
  lines.push(`${prefix}: ${value == null ? 'null' : value}`);
}

/** Human output exposes the exact same stable keys as JSON. */
export function renderClosureAuditText(audit) {
  const lines = ['# Closure Audit'];
  flatten(audit, '', lines);
  return `${lines.join('\n')}\n`;
}
