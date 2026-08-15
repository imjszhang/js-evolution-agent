/**
 * Mechanical evidence-reference audit for JEA subject runtime data.
 * Pure fs reads — does not use IntelligenceStore (typed reads are limit-capped).
 *
 * Uses js-traceability/core only for narrative ID extraction (explicitSourceIds).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { explicitSourceIds } from 'js-traceability/core';
import { isOperatorFact, normalizeSupersedes } from './operator-facts.mjs';
import { resolveIntelReportRecordPath } from './report-paths.mjs';

export const EVIDENCE_AUDIT_SCHEMA = 'evidence-audit.v1';

/** Paths relative to dataRoot (= <JEA_HOME>/subjects/<ns>/data). */
export const STORE_FILES = Object.freeze({
  action_receipts: 'intelligence/action_receipts/action-receipts.jsonl',
  verify_reports: 'evolution/verify_reports',
  intel_observations: 'intelligence/intel_observations',
  operator_facts: 'evolution/operator_facts',
  reports: 'intelligence/reports/index.jsonl',
  probe_results: 'intelligence/probe_results/probe-results.jsonl',
  goal_events: 'intelligence/goal_events/goal-events.jsonl',
  evolution_events: 'intelligence/evolution_events/evolution-events.jsonl',
  belief_events: 'intelligence/beliefs/belief-events.jsonl',
  retrospectives: 'intelligence/retrospectives/retrospectives.jsonl',
  beliefs: 'intelligence/beliefs/current_beliefs.json',
  standing_memory: 'intelligence/memory/standing_memory.json',
});

export const REF_TYPE_ALIASES = Object.freeze({
  action_receipt: 'action_receipts',
  action_receipts: 'action_receipts',
  verify_report: 'verify_reports',
  verify_reports: 'verify_reports',
  observation: 'intel_observations',
  observations: 'intel_observations',
  intel_observation: 'intel_observations',
  intel_observations: 'intel_observations',
  operator_fact: 'operator_facts',
  operator_facts: 'operator_facts',
  intel_report: 'reports',
  intel_reports: 'reports',
  report: 'reports',
  reports: 'reports',
  probe_result: 'probe_results',
  probe_results: 'probe_results',
  goal_event: 'goal_events',
  goal_events: 'goal_events',
  evolution_event: 'evolution_events',
  evolution_events: 'evolution_events',
  belief_event: 'belief_events',
  belief_events: 'belief_events',
  retrospective: 'retrospectives',
  retrospectives: 'retrospectives',
  latest_review: 'retrospectives',
  belief: 'beliefs',
  beliefs: 'beliefs',
});

export const SKIP_REF_TYPES = Object.freeze([
  'agent_context',
  'standing_memory',
  'operator_brief',
  'human_guidance',
  'machine_context',
]);

/**
 * Longest prefixes first so belief-event- beats belief-.
 * Verify report filenames are either legacy `exec-YYYYMMDD-HHMMSS` or current
 * `cycle-<id>`; both resolve to verify_reports. Typed refs should use the
 * on-disk basename: `verify_report:exec-…` or `verify_report:cycle-…`.
 */
export const ID_PREFIX_TO_STORE = Object.freeze([
  ['belief-event-', 'belief_events'],
  ['probe-result-', 'probe_results'],
  ['goal-event-', 'goal_events'],
  ['receipt-', 'action_receipts'],
  ['report-', 'reports'],
  ['retro-', 'retrospectives'],
  ['exec-', 'verify_reports'],
  ['cycle-', 'verify_reports'],
  ['operator-fact-', 'operator_facts'],
  ['obs-', 'intel_observations'],
  ['evt-', 'evolution_events'],
  ['belief-', 'beliefs'],
]);

export const RETENTION_PRONE_STORES = Object.freeze(['intel_observations']);

/**
 * Narrative citation IDs: typed uuid-ish ids, exec-YYYYMMDD-HHMMSS, and cycle-….
 * Passed to js-traceability explicitSourceIds via sourceIdPattern.
 */
export const NARRATIVE_ID_PATTERN = /\b(?:(?:obs|receipt|evt|probe-result|goal-event|belief-event|retro|report)-[0-9a-f][0-9a-f-]{7,}|exec-\d{8}-\d{6}|cycle-\d{8,}-\w+)\b/gi;

/** Parse a non-negative integer option; invalid / missing → fallback (0 is kept). */
export function parseCountOption(value, fallback) {
  if (value == null || value === true || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const MAX_NARRATIVE_FINDINGS_PER_DOC = 20;
const QUICK_FINDINGS_CAP = 10;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

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

/** Parse JSONL; skip empty and invalid lines. Missing file → []. */
export function readJsonlSafe(absPath) {
  const text = readTextSafe(absPath);
  if (text == null) return [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // tolerate corrupt lines
    }
  }
  return rows;
}

function guessStoreFromId(id) {
  const raw = String(id ?? '');
  for (const [prefix, store] of ID_PREFIX_TO_STORE) {
    if (raw.startsWith(prefix)) return store;
  }
  return null;
}

function normalizeRefType(type) {
  if (type == null || type === '') return null;
  const key = String(type).trim().toLowerCase();
  if (SKIP_REF_TYPES.includes(key)) return { skip: true, type: key };
  const canonical = REF_TYPE_ALIASES[key];
  if (canonical) return { skip: false, type: canonical };
  return { skip: false, type: null, unknown: key };
}

/**
 * Parse one evidence ref (string / goal-event object / standing-memory typed ref).
 * @returns {{ type: string|null, id: string|null, skip?: boolean, unknownType?: string }|null}
 */
export function parseRef(raw) {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    const colon = text.indexOf(':');
    if (colon > 0) {
      const typePart = text.slice(0, colon).trim();
      const idPart = text.slice(colon + 1).trim();
      if (!idPart) return { type: null, id: text };
      const norm = normalizeRefType(typePart);
      if (norm.skip) return { type: norm.type, id: idPart, skip: true };
      if (norm.unknown) return { type: null, id: idPart, unknownType: norm.unknown };
      return { type: norm.type, id: idPart };
    }
    const guessed = guessStoreFromId(text);
    if (guessed) return { type: guessed, id: text };
    return { type: null, id: text };
  }

  if (typeof raw === 'object') {
    if (raw.source_type != null || raw.source_id != null) {
      const id = raw.source_id != null ? String(raw.source_id).trim() : '';
      if (!id) return null;
      const norm = normalizeRefType(raw.source_type);
      if (norm?.skip) return { type: norm.type, id, skip: true };
      if (norm?.unknown) return { type: null, id, unknownType: norm.unknown };
      if (norm?.type) return { type: norm.type, id };
      const guessed = guessStoreFromId(id);
      return { type: guessed, id };
    }

    const id = raw.id != null ? String(raw.id).trim() : '';
    const typeRaw = raw.type != null ? String(raw.type).trim() : '';
    if (typeRaw && id) {
      const norm = normalizeRefType(typeRaw);
      if (norm.skip) return { type: norm.type, id, skip: true };
      if (norm.unknown) return { type: null, id, unknownType: norm.unknown };
      return { type: norm.type, id };
    }
    if (raw.ref != null && typeof raw.ref === 'string') {
      return parseRef(raw.ref);
    }
    if (id) {
      const guessed = guessStoreFromId(id);
      return { type: guessed, id };
    }
  }

  return null;
}

/**
 * Strip surrounding `[…]` from a narrative typed-ref form.
 * @param {unknown} raw
 * @returns {string}
 */
export function stripEvidenceRefBrackets(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('[') && text.endsWith(']') && text.length >= 2) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/**
 * True when `raw` parses as a store typed ref whose id exists in `sets`
 * (from {@link buildEvidenceIndex}). Bracketed forms like
 * `[action_receipts:receipt-…]` are accepted. Skip / unknown types fail.
 *
 * @param {unknown} raw
 * @param {{ sets?: Map<string, Set<string>> }|null|undefined} index
 * @returns {boolean}
 */
export function evidenceRefExists(raw, index = null) {
  const sets = index?.sets;
  if (!(sets instanceof Map)) return false;
  const stripped = stripEvidenceRefBrackets(raw);
  if (!stripped) return false;
  const parsed = parseRef(stripped);
  if (!parsed || parsed.skip || parsed.unknownType) return false;
  if (!parsed.type || !parsed.id) return false;
  return sets.get(parsed.type)?.has(parsed.id) === true;
}

function loadJsonlIds(absPath, { idFields = ['id'] } = {}) {
  const ids = new Set();
  for (const row of readJsonlSafe(absPath)) {
    for (const field of idFields) {
      const value = row?.[field];
      if (value != null && String(value).trim()) ids.add(String(value).trim());
    }
    // action receipts: legacy receipt_id
    if (row?.receipt_id != null && String(row.receipt_id).trim()) {
      ids.add(String(row.receipt_id).trim());
    }
  }
  return ids;
}

function loadDirJsonlIds(dirPath) {
  const ids = new Set();
  if (!existsSync(dirPath)) return ids;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    for (const id of loadJsonlIds(join(dirPath, entry.name))) ids.add(id);
  }
  return ids;
}

function loadVerifyReportIds(dirPath) {
  const ids = new Set();
  if (!existsSync(dirPath)) return ids;
  let entries = [];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    ids.add(basename(entry.name, '.json'));
  }
  return ids;
}

function loadBeliefIds(absPath) {
  const ids = new Set();
  const doc = readJsonSafe(absPath);
  for (const belief of asArray(doc?.beliefs)) {
    if (belief?.id != null && String(belief.id).trim()) ids.add(String(belief.id).trim());
  }
  return ids;
}

/**
 * @returns {{ counts: Record<string, number>, sets: Map<string, Set<string>> }}
 */
export function buildEvidenceIndex({ dataRoot }) {
  const root = String(dataRoot ?? '');
  const sets = new Map();

  const put = (name, idSet) => {
    sets.set(name, idSet);
  };

  put('action_receipts', loadJsonlIds(join(root, STORE_FILES.action_receipts)));
  put('verify_reports', loadVerifyReportIds(join(root, STORE_FILES.verify_reports)));
  put('intel_observations', loadDirJsonlIds(join(root, STORE_FILES.intel_observations)));
  {
    // operator_facts live as individual JSON files under pending/ and digested/.
    const factIds = new Set();
    for (const sub of ['pending', 'digested']) {
      const dir = join(root, STORE_FILES.operator_facts, sub);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(join(dir, name), 'utf-8'));
          if (raw?.id) factIds.add(String(raw.id));
        } catch {
          // skip invalid
        }
      }
    }
    put('operator_facts', factIds);
  }
  put('reports', loadJsonlIds(join(root, STORE_FILES.reports), { idFields: ['id', 'cycle_id'] }));
  put('probe_results', loadJsonlIds(join(root, STORE_FILES.probe_results)));
  put('goal_events', loadJsonlIds(join(root, STORE_FILES.goal_events)));
  put('evolution_events', loadJsonlIds(join(root, STORE_FILES.evolution_events)));
  put('belief_events', loadJsonlIds(join(root, STORE_FILES.belief_events)));
  put('retrospectives', loadJsonlIds(join(root, STORE_FILES.retrospectives)));
  put('beliefs', loadBeliefIds(join(root, STORE_FILES.beliefs)));

  const counts = {};
  for (const [name, idSet] of sets) counts[name] = idSet.size;
  return { counts, sets };
}

function makeFinding(rule, severity, location, ref, message) {
  return { rule, severity, location, ref: ref ?? null, message };
}

function refDisplay(parsed, raw) {
  if (typeof raw === 'string') return raw;
  if (parsed?.type && parsed?.id) return `${parsed.type}:${parsed.id}`;
  if (parsed?.id) return String(parsed.id);
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function checkRefAgainstIndex(parsed, index, {
  location,
  raw,
  danglingSeverity = 'error',
  findings,
  counters,
}) {
  if (!parsed) return;
  if (parsed.skip) {
    counters.skipped += 1;
    return;
  }
  if (parsed.unknownType) {
    findings.push(makeFinding(
      'unknown_ref_type',
      'warning',
      location,
      refDisplay(parsed, raw),
      `Unknown evidence ref type '${parsed.unknownType}'`,
    ));
    return;
  }
  if (parsed.type == null) {
    findings.push(makeFinding(
      'unknown_id_shape',
      'warning',
      location,
      refDisplay(parsed, raw),
      `Could not resolve store for evidence id '${parsed.id}'`,
    ));
    return;
  }
  const idSet = index.sets.get(parsed.type);
  if (idSet?.has(parsed.id)) return;

  let severity = danglingSeverity;
  let message = `Dangling evidence ref ${refDisplay(parsed, raw)} (store=${parsed.type})`;
  if (RETENTION_PRONE_STORES.includes(parsed.type)) {
    severity = 'warning';
    message += '; target may have been removed by retention';
  }
  findings.push(makeFinding('dangling_ref', severity, location, refDisplay(parsed, raw), message));
}

function scanBeliefEvidenceRefs(beliefsDoc, index, findings, counters, { forceWarning = false } = {}) {
  for (const belief of asArray(beliefsDoc?.beliefs)) {
    const beliefId = belief?.id ?? 'unknown';
    for (const raw of asArray(belief?.evidence_refs)) {
      const parsed = parseRef(raw);
      checkRefAgainstIndex(parsed, index, {
        location: `current_beliefs:${beliefId}`,
        raw,
        danglingSeverity: forceWarning ? 'warning' : 'error',
        findings,
        counters,
      });
    }
  }
}

function scanStandingMemory(dataRoot, index, findings, counters) {
  const doc = readJsonSafe(join(dataRoot, STORE_FILES.standing_memory));
  if (!doc) return;
  asArray(doc.typed_evidence_refs).forEach((raw, i) => {
    const parsed = parseRef(raw);
    checkRefAgainstIndex(parsed, index, {
      location: `standing_memory:typed_evidence_refs[${i}]`,
      raw,
      danglingSeverity: 'error',
      findings,
      counters,
    });
  });
  asArray(doc.evidence_refs).forEach((raw, i) => {
    const parsed = parseRef(typeof raw === 'string' ? raw : raw);
    checkRefAgainstIndex(parsed, index, {
      location: `standing_memory:evidence_refs[${i}]`,
      raw,
      danglingSeverity: 'warning',
      findings,
      counters,
    });
  });
}

function scanRecentJsonlRefs(absPath, {
  index,
  findings,
  counters,
  events,
  locationPrefix,
  refsFromRow,
}) {
  const rows = readJsonlSafe(absPath);
  const recent = rows.slice(-Math.max(0, events));
  recent.forEach((row, offset) => {
    const absIndex = rows.length - recent.length + offset;
    const rowId = row?.id ?? String(absIndex);
    for (const raw of refsFromRow(row)) {
      const parsed = parseRef(raw);
      checkRefAgainstIndex(parsed, index, {
        location: `${locationPrefix}:${rowId}`,
        raw,
        danglingSeverity: 'warning',
        findings,
        counters,
      });
    }
  });
}

function applyR1({ dataRoot, index, findings, counters, events, includeEventLogs }) {
  const beliefsDoc = readJsonSafe(join(dataRoot, STORE_FILES.beliefs));
  if (beliefsDoc) scanBeliefEvidenceRefs(beliefsDoc, index, findings, counters);
  scanStandingMemory(dataRoot, index, findings, counters);

  if (!includeEventLogs) return;

  scanRecentJsonlRefs(join(dataRoot, STORE_FILES.belief_events), {
    index,
    findings,
    counters,
    events,
    locationPrefix: 'belief_events',
    refsFromRow: (row) => asArray(row?.evidence_refs),
  });

  scanRecentJsonlRefs(join(dataRoot, STORE_FILES.goal_events), {
    index,
    findings,
    counters,
    events,
    locationPrefix: 'goal_events',
    refsFromRow: (row) => {
      const refs = [...asArray(row?.evidence_refs)];
      if (row?.ref != null) refs.push(row.ref);
      return refs;
    },
  });
}

function applyR2({ dataRoot, index, findings }) {
  const beliefsDoc = readJsonSafe(join(dataRoot, STORE_FILES.beliefs));
  if (!beliefsDoc) return;

  for (const belief of asArray(beliefsDoc.beliefs)) {
    const status = belief?.status ?? null;
    if (status === 'refuted' || status === 'retired') continue;
    const needsGate = status === 'validated' || belief?.confidence === 'high';
    if (!needsGate) continue;

    const beliefId = belief?.id ?? 'unknown';
    const refs = asArray(belief?.evidence_refs);
    if (refs.length === 0) {
      findings.push(makeFinding(
        'ungrounded_status',
        'error',
        `current_beliefs:${beliefId}`,
        null,
        `Belief has status=${status ?? 'n/a'} confidence=${belief?.confidence ?? 'n/a'} but no evidence_refs`,
      ));
      continue;
    }

    const parsedRefs = refs.map((raw) => ({ raw, parsed: parseRef(raw) })).filter((x) => x.parsed && !x.parsed.skip);
    const hardRefs = parsedRefs.filter((x) => (
      x.parsed.type === 'verify_reports' || x.parsed.type === 'action_receipts'
    ) && index.sets.get(x.parsed.type)?.has(x.parsed.id));

    if (hardRefs.length === 0) {
      findings.push(makeFinding(
        'weak_grounding',
        'warning',
        `current_beliefs:${beliefId}`,
        null,
        'No evidence_refs resolve to an existing verify_report or action_receipt',
      ));
      continue;
    }

    const verifyHits = hardRefs.filter((x) => x.parsed.type === 'verify_reports');
    if (verifyHits.length === 0) continue;

    let allFailed = true;
    let sawSemantic = false;
    for (const hit of verifyHits) {
      const report = readJsonSafe(join(dataRoot, STORE_FILES.verify_reports, `${hit.parsed.id}.json`));
      const semanticStatus = report?.semantic?.status;
      if (semanticStatus == null || semanticStatus === 'unavailable') {
        allFailed = false;
        continue;
      }
      sawSemantic = true;
      if (semanticStatus !== 'failed') allFailed = false;
    }
    if (sawSemantic && allFailed) {
      findings.push(makeFinding(
        'failed_verification_grounding',
        'warning',
        `current_beliefs:${beliefId}`,
        null,
        'All referenced verify_reports have semantic.status=failed',
      ));
    }
  }
}

function detectSupersedeCycles(edges) {
  const nodes = new Set();
  for (const [from, tos] of edges) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (visiting.has(node)) {
      const idx = path.indexOf(node);
      cycles.push([...path.slice(idx), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of edges.get(node) ?? []) {
      dfs(next, [...path, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of nodes) dfs(node, []);
  return cycles;
}

function applyR3({ dataRoot, index, findings }) {
  const obsDir = join(dataRoot, STORE_FILES.intel_observations);
  const observations = [];
  if (existsSync(obsDir)) {
    let entries = [];
    try {
      entries = readdirSync(obsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      observations.push(...readJsonlSafe(join(obsDir, entry.name)));
    }
  }

  const obsIds = index.sets.get('intel_observations') ?? new Set();
  const edges = new Map();

  for (const record of observations) {
    if (!isOperatorFact(record)) continue;
    const fromId = record?.id != null ? String(record.id).trim() : '';
    if (!fromId) continue;
    for (const target of normalizeSupersedes(record.supersedes)) {
      if (!obsIds.has(target)) {
        findings.push(makeFinding(
          'dangling_supersede',
          'warning',
          `operator_fact:${fromId}`,
          target,
          `supersedes target '${target}' not found in intel_observations (may be retention)`,
        ));
      }
      if (!edges.has(fromId)) edges.set(fromId, new Set());
      edges.get(fromId).add(target);
    }
  }

  const seenCycles = new Set();
  for (const cycle of detectSupersedeCycles(edges)) {
    const key = [...new Set(cycle)].sort().join('|');
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    findings.push(makeFinding(
      'supersede_cycle',
      'error',
      `operator_fact:${cycle[0]}`,
      cycle.join(' -> '),
      `operator_fact supersedes cycle detected: ${cycle.join(' -> ')}`,
    ));
  }
}

function resolveDiaryPath(dataRoot, diaryPath) {
  if (!diaryPath) return null;
  if (isAbsolute(diaryPath) && existsSync(diaryPath)) return diaryPath;
  const candidates = [
    join(dataRoot, diaryPath),
    join(dataRoot, '..', diaryPath),
    diaryPath,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function applyR4({ dataRoot, index, findings, reports, diaries }) {
  const runtimeRoot = join(dataRoot, '..');
  const reportRows = readJsonlSafe(join(dataRoot, STORE_FILES.reports));
  const recentReports = reportRows.slice(-Math.max(0, reports));

  for (const record of recentReports) {
    const cycleId = record?.cycle_id ?? record?.id ?? 'unknown';
    const location = `report:${cycleId}`;
    const mdPath = resolveIntelReportRecordPath(runtimeRoot, record);
    if (!mdPath || !existsSync(mdPath)) {
      findings.push(makeFinding(
        'narrative_source_missing',
        'warning',
        location,
        record?.md_path ?? null,
        'Intel report markdown file not found',
      ));
      continue;
    }
    scanNarrativeText(readTextSafe(mdPath) ?? '', index, findings, location);
  }

  const evoRows = readJsonlSafe(join(dataRoot, STORE_FILES.evolution_events));
  const diaryRows = evoRows.filter((row) => row?.type === 'evolution_diary');
  const recentDiaries = diaryRows.slice(-Math.max(0, diaries));

  for (const row of recentDiaries) {
    const cycleId = row?.cycle_id ?? row?.id ?? 'unknown';
    const location = `diary:${cycleId}`;
    const mdPath = resolveDiaryPath(dataRoot, row?.diary_path);
    if (!mdPath) {
      findings.push(makeFinding(
        'narrative_source_missing',
        'warning',
        location,
        row?.diary_path ?? null,
        'Evolution diary markdown file not found',
      ));
      continue;
    }
    scanNarrativeText(readTextSafe(mdPath) ?? '', index, findings, location);
  }
}

function scanNarrativeText(text, index, findings, location) {
  const ids = explicitSourceIds(text, { sourceIdPattern: NARRATIVE_ID_PATTERN });
  let reported = 0;
  let truncated = false;
  for (const id of ids) {
    const store = guessStoreFromId(id);
    if (!store) continue;
    if (index.sets.get(store)?.has(id)) continue;
    if (reported >= MAX_NARRATIVE_FINDINGS_PER_DOC) {
      truncated = true;
      break;
    }
    reported += 1;
    let message = `Narrative citation '${id}' not found in ${store}`;
    if (RETENTION_PRONE_STORES.includes(store)) {
      message += '; target may have been removed by retention';
    }
    findings.push(makeFinding('narrative_dangling_ref', 'warning', location, id, message));
  }
  if (truncated && findings.length) {
    const last = findings[findings.length - 1];
    if (last.location === location && last.rule === 'narrative_dangling_ref') {
      last.message += ` (truncated after ${MAX_NARRATIVE_FINDINGS_PER_DOC} findings for this document)`;
    }
  }
}

function partitionFindings(findings) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  return { errors, warnings };
}

function buildAuditResult({ dataRoot, index, findings, skipped }) {
  const { errors, warnings } = partitionFindings(findings);
  return {
    schema_version: EVIDENCE_AUDIT_SCHEMA,
    generated_at: new Date().toISOString(),
    data_root: dataRoot,
    index: index.counts,
    skipped_refs: skipped,
    errors,
    warnings,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      ok: errors.length === 0,
    },
  };
}

/**
 * Full evidence audit (R1–R4).
 */
export function runEvidenceAudit({
  dataRoot,
  reports = 5,
  diaries = 5,
  events = 200,
  narrative = true,
} = {}) {
  if (!dataRoot) throw new Error('runEvidenceAudit requires dataRoot');
  const index = buildEvidenceIndex({ dataRoot });
  const findings = [];
  const counters = { skipped: 0 };

  applyR1({
    dataRoot,
    index,
    findings,
    counters,
    events: Number(events) || 200,
    includeEventLogs: true,
  });
  applyR2({ dataRoot, index, findings });
  applyR3({ dataRoot, index, findings });
  if (narrative !== false) {
    applyR4({
      dataRoot,
      index,
      findings,
      reports: Number(reports) || 5,
      diaries: Number(diaries) || 5,
    });
  }

  return buildAuditResult({
    dataRoot,
    index,
    findings,
    skipped: counters.skipped,
  });
}

function truncateFindings(list, cap = QUICK_FINDINGS_CAP) {
  return asArray(list).slice(0, cap);
}

/**
 * Lightweight audit for verify reports: R1 beliefs+standing_memory + R2 only.
 * Findings truncated to 10 each.
 */
export function runEvidenceAuditQuick({ dataRoot } = {}) {
  if (!dataRoot) throw new Error('runEvidenceAuditQuick requires dataRoot');
  const index = buildEvidenceIndex({ dataRoot });
  const findings = [];
  const counters = { skipped: 0 };

  applyR1({
    dataRoot,
    index,
    findings,
    counters,
    events: 0,
    includeEventLogs: false,
  });
  applyR2({ dataRoot, index, findings });

  const audit = buildAuditResult({
    dataRoot,
    index,
    findings,
    skipped: counters.skipped,
  });
  return {
    ...audit,
    errors: truncateFindings(audit.errors),
    warnings: truncateFindings(audit.warnings),
    summary: {
      errors: audit.summary.errors,
      warnings: audit.summary.warnings,
      ok: audit.summary.ok,
      truncated: audit.errors.length > QUICK_FINDINGS_CAP || audit.warnings.length > QUICK_FINDINGS_CAP,
    },
  };
}

export function renderEvidenceAuditText(audit) {
  const lines = [
    '# Evidence Audit',
    `schema: ${audit.schema_version}`,
    `data_root: ${audit.data_root}`,
    `skipped_refs: ${audit.skipped_refs ?? 0}`,
    '',
    '## Index',
  ];
  for (const [name, count] of Object.entries(audit.index ?? {})) {
    lines.push(`${name}: ${count}`);
  }
  lines.push('');
  lines.push(`## Errors (${audit.summary?.errors ?? 0})`);
  for (const item of asArray(audit.errors)) {
    lines.push(`- [${item.rule}] ${item.location}${item.ref ? ` -> ${item.ref}` : ''}: ${item.message}`);
  }
  if (!asArray(audit.errors).length) lines.push('(none)');
  lines.push('');
  lines.push(`## Warnings (${audit.summary?.warnings ?? 0})`);
  for (const item of asArray(audit.warnings)) {
    lines.push(`- [${item.rule}] ${item.location}${item.ref ? ` -> ${item.ref}` : ''}: ${item.message}`);
  }
  if (!asArray(audit.warnings).length) lines.push('(none)');
  lines.push('');
  lines.push(audit.summary?.ok ? 'evidence audit ok' : 'evidence audit needs attention');
  return `${lines.join('\n')}\n`;
}

/**
 * One-line observation content + compact audit_summary for ingest.
 */
export function summarizeEvidenceAuditForIngest(audit) {
  const top = asArray(audit.errors)[0] ?? asArray(audit.warnings)[0] ?? null;
  const topText = top
    ? `top: ${top.rule} ${top.location}${top.ref ? ` -> ${top.ref}` : ''}`
    : 'top: none';
  return {
    content: `evidence audit: ${audit.summary?.errors ?? 0} errors, ${audit.summary?.warnings ?? 0} warnings; ${topText}`,
    audit_summary: {
      errors: audit.summary?.errors ?? 0,
      warnings: audit.summary?.warnings ?? 0,
      ok: Boolean(audit.summary?.ok),
      index: audit.index ?? {},
    },
  };
}
