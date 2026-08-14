import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redaction.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 20;
const DIGESTION_OUTCOMES = new Set(['supported', 'untested', 'contradicted']);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function timestampOf(record) {
  const raw = record?.recorded_at
    ?? record?.generated_at
    ?? record?.updated_at
    ?? record?.created_at
    ?? record?.timestamp;
  return Date.parse(raw || '') || 0;
}

function newestFirst(records) {
  return asArray(records)
    .slice()
    .sort((a, b) => timestampOf(b) - timestampOf(a));
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function factFilename(fact) {
  const id = sanitizeFilenamePart(fact.id || `fact-${randomUUID()}`);
  return `${timestampForFilename()}-${id}.json`;
}

export function isOperatorFact(record) {
  return record?.kind === 'operator_fact' || record?.source === 'operator_fact';
}

export function isHighConfidenceOperatorFact(record) {
  return !record?.confidence || record.confidence === 'high';
}

/** @param {unknown} value */
export function normalizeSupersedes(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Collect ids superseded by operator facts in the observation set.
 * Only operator_fact records' `supersedes` fields are honored.
 */
export function buildSupersededIds(observations) {
  const superseded = new Set();
  for (const record of asArray(observations)) {
    if (!isOperatorFact(record)) continue;
    for (const id of normalizeSupersedes(record.supersedes)) {
      superseded.add(id);
    }
  }
  return superseded;
}

export function isSupersededOperatorFact(record, supersededIds) {
  const id = record?.id;
  return id != null && supersededIds.has(id);
}

/**
 * Active operator facts: high-confidence, not superseded, newest first.
 * Kept for migration / legacy observation-store read-side compatibility.
 * @param {object[]} observations
 * @param {{ limit?: number }} [opts]
 */
export function selectActiveOperatorFacts(observations, { limit } = {}) {
  const supersededIds = buildSupersededIds(observations);
  let active = newestFirst(observations).filter(
    (record) => isOperatorFact(record)
      && isHighConfidenceOperatorFact(record)
      && !isSupersededOperatorFact(record, supersededIds),
  );
  if (limit != null && limit > 0) {
    active = active.slice(0, limit);
  }
  return active;
}

/**
 * For context summaries: active operator facts first, then other observations.
 * Superseded operator facts are omitted from the prioritized list.
 */
export function prioritizeActiveOperatorFacts(records, limit = 20) {
  const all = asArray(records);
  const supersededIds = buildSupersededIds(all);
  const sorted = newestFirst(all);
  const activeFacts = sorted.filter(
    (record) => isOperatorFact(record)
      && isHighConfidenceOperatorFact(record)
      && !isSupersededOperatorFact(record, supersededIds),
  );
  const others = sorted.filter((record) => !isOperatorFact(record));
  return [...activeFacts, ...others].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pending / digested file store (one-shot seed lifecycle)
// ---------------------------------------------------------------------------

export function operatorFactsRoot(runtimeRoot) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  return join(runtimeRoot, 'data', 'evolution', 'operator_facts');
}

export function pendingOperatorFactsDir(runtimeRoot) {
  return join(operatorFactsRoot(runtimeRoot), 'pending');
}

export function digestedOperatorFactsDir(runtimeRoot) {
  return join(operatorFactsRoot(runtimeRoot), 'digested');
}

export function normalizeOperatorFact(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Operator fact must be a JSON object');
  }
  const content = String(input.content ?? input.summary ?? input.claim ?? '').trim();
  if (!content) {
    throw new Error('Operator fact requires content');
  }
  const createdAt = input.created_at ?? input.recorded_at ?? nowIso();
  return redactSecrets({
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    id: input.id ?? `operator-fact-${randomUUID()}`,
    kind: 'operator_fact',
    source: input.source ?? 'operator',
    subject: input.subject ?? null,
    content,
    summary: input.summary ?? content,
    confidence: input.confidence === 'medium' || input.confidence === 'low'
      ? input.confidence
      : 'high',
    created_at: createdAt,
    recorded_at: input.recorded_at ?? createdAt,
    created_by: input.created_by ?? 'operator',
    supersedes: normalizeSupersedes(input.supersedes),
    metadata: input.metadata ?? {},
    channel_source: input.channel_source ?? null,
    producer: input.producer ?? 'operator',
    activation_targets: Array.isArray(input.activation_targets)
      ? input.activation_targets
      : ['cognitive'],
    // Digestion bookkeeping (filled when moved to digested/)
    injected_by_cycle: input.injected_by_cycle ?? input.injected_by_batch ?? null,
    injected_by_batch: input.injected_by_batch ?? input.injected_by_cycle ?? null,
    activation_batch_id: input.activation_batch_id ?? null,
    injected_at: input.injected_at ?? null,
    digested_by_cycle: input.digested_by_cycle ?? input.digested_by_batch ?? null,
    digested_by_batch: input.digested_by_batch ?? input.digested_by_cycle ?? null,
    digested_at: input.digested_at ?? null,
    digestion_outcome: input.digestion_outcome ?? null,
    digestion_reason: input.digestion_reason ?? null,
    resulting_belief_id: input.resulting_belief_id ?? null,
    resulting_question_id: input.resulting_question_id ?? null,
    migrated_from_observation: input.migrated_from_observation === true,
  });
}

export function writePendingOperatorFact(runtimeRoot, factInput) {
  const fact = normalizeOperatorFact(factInput);
  // Only high-confidence facts enter the seed lifecycle as authoritative seeds.
  if (!isHighConfidenceOperatorFact(fact)) {
    throw new Error('Operator fact seed requires confidence=high (or omitted)');
  }
  const dir = pendingOperatorFactsDir(runtimeRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, factFilename(fact));
  writeFileSync(file, JSON.stringify(fact, null, 2), 'utf-8');
  return { file, fact };
}

function readFactFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const fact = normalizeOperatorFact(raw);
    return { file, fact, error: null };
  } catch (e) {
    return { file, fact: null, error: e?.message || String(e) };
  }
}

export function readPendingOperatorFacts(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = pendingOperatorFactsDir(runtimeRoot);
  if (!existsSync(dir)) return { facts: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
  const valid = [];
  const invalid = [];
  for (const file of files) {
    const record = readFactFile(file);
    if (record.fact) valid.push(record);
    else invalid.push({ file, error: record.error });
  }
  return {
    facts: valid.slice(0, Math.max(0, limit)).map((record) => ({
      ...record.fact,
      _file: record.file,
    })),
    invalid,
    dir,
    total_valid: valid.length,
  };
}

export function readDigestedOperatorFacts(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = digestedOperatorFactsDir(runtimeRoot);
  if (!existsSync(dir)) return { facts: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((name) => join(dir, name));
  const facts = [];
  const invalid = [];
  for (const file of files) {
    const record = readFactFile(file);
    if (record.fact) facts.push({ ...record.fact, _file: file });
    else invalid.push({ file, error: record.error });
  }
  return { facts, invalid, dir };
}

/** Collect fact ids already present in pending/ or digested/ (for migration idempotency). */
export function collectKnownOperatorFactIds(runtimeRoot) {
  const ids = new Set();
  for (const reader of [readPendingOperatorFacts, readDigestedOperatorFacts]) {
    const result = reader(runtimeRoot, { limit: 10_000 });
    for (const fact of result.facts) {
      if (fact.id) ids.add(fact.id);
    }
  }
  return ids;
}

/**
 * Mark facts as injected by the current cycle (bookkeeping only; stay in pending/).
 */
export function markOperatorFactsInjected(runtimeRoot, facts = [], { cycleId, batchId = null } = {}) {
  if (!facts.length) return { updated: [], failed: [] };
  const updated = [];
  const failed = [];
  const injectedAt = nowIso();
  for (const fact of facts) {
    const source = fact._file;
    if (!source || !existsSync(source)) {
      failed.push({ id: fact.id, file: source, reason: 'source_missing' });
      continue;
    }
    try {
      const payload = redactSecrets({
        ...fact,
        _file: undefined,
        injected_by_cycle: cycleId ?? fact.injected_by_cycle ?? null,
        injected_by_batch: batchId ?? fact.injected_by_batch ?? null,
        activation_batch_id: batchId ?? fact.activation_batch_id ?? null,
        injected_at: injectedAt,
      });
      writeFileSync(source, JSON.stringify(payload, null, 2), 'utf-8');
      updated.push({ id: fact.id, file: source, cycle_id: cycleId ?? null });
    } catch (e) {
      failed.push({ id: fact.id, file: source, reason: e?.message || String(e) });
    }
  }
  return { updated, failed };
}

/**
 * Move pending facts into digested/ with digestion outcome metadata.
 */
export function markOperatorFactsDigested(runtimeRoot, facts = [], {
  cycleId,
  batchId = null,
  outcome = 'untested',
  reason = null,
  resultingBeliefId = null,
  resultingQuestionId = null,
} = {}) {
  if (!facts.length) return { moved: [], failed: [] };
  if (!DIGESTION_OUTCOMES.has(outcome)) {
    throw new Error(`Invalid digestion outcome: ${outcome}`);
  }
  const digestedDir = digestedOperatorFactsDir(runtimeRoot);
  mkdirSync(digestedDir, { recursive: true });
  const moved = [];
  const failed = [];
  const digestedAt = nowIso();
  for (const fact of facts) {
    const source = fact._file;
    if (!source || !existsSync(source)) {
      failed.push({ id: fact.id, file: source, reason: 'source_missing' });
      continue;
    }
    const perOutcome = fact.digestion_outcome && DIGESTION_OUTCOMES.has(fact.digestion_outcome)
      ? fact.digestion_outcome
      : outcome;
    const payload = redactSecrets({
      ...fact,
      _file: undefined,
      digested_by_cycle: cycleId ?? null,
      digested_by_batch: batchId ?? cycleId ?? null,
      digested_at: digestedAt,
      digestion_outcome: perOutcome,
      digestion_reason: fact.digestion_reason ?? reason,
      resulting_belief_id: fact.resulting_belief_id ?? resultingBeliefId,
      resulting_question_id: fact.resulting_question_id ?? resultingQuestionId,
    });
    const target = join(digestedDir, `${timestampForFilename()}-${sanitizeFilenamePart(fact.id)}.json`);
    try {
      writeFileSync(source, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(source, target);
      moved.push({
        id: fact.id,
        from: source,
        to: target,
        outcome: perOutcome,
      });
    } catch (e) {
      failed.push({ id: fact.id, file: source, reason: e?.message || String(e) });
    }
  }
  return { moved, failed };
}

export function summarizeOperatorFactsForContext(facts = []) {
  return (facts || []).map((fact) => ({
    id: fact.id,
    content: fact.content,
    confidence: fact.confidence,
    subject: fact.subject,
    created_at: fact.created_at,
    injected_by_cycle: fact.injected_by_cycle ?? null,
    supersedes: fact.supersedes ?? [],
  }));
}

export function formatOperatorFactsForPrompt(facts = []) {
  if (!Array.isArray(facts) || !facts.length) return '(none)';
  return facts.map((fact, index) => {
    const lines = [
      `### Operator Fact ${index + 1}: ${fact.id}`,
      `content: ${fact.content}`,
      `confidence: ${fact.confidence ?? 'high'}`,
      `created_at: ${fact.created_at}`,
    ];
    if (fact.subject) lines.push(`subject: ${fact.subject}`);
    if (fact.injected_by_cycle) lines.push(`injected_by_cycle: ${fact.injected_by_cycle}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function operatorFactDisplayName(fact) {
  return `${fact.id} ${fact.content || basename(fact._file || '')}`.trim();
}

/**
 * Migrate legacy high-confidence operator facts from intel_observations into pending/.
 * Idempotent: skips ids already present in pending/ or digested/.
 * Production report gather no longer calls this (M5 write-off, 2026-08-15).
 */
export function migrateLegacyOperatorFacts(runtimeRoot, observations = [], {
  store = null,
  limit = 50,
} = {}) {
  const knownIds = collectKnownOperatorFactIds(runtimeRoot);
  const candidates = selectActiveOperatorFacts(observations, { limit });
  const migrated = [];
  const skipped = [];
  for (const record of candidates) {
    if (!record?.id) {
      skipped.push({ id: null, reason: 'missing_id' });
      continue;
    }
    if (knownIds.has(record.id)) {
      skipped.push({ id: record.id, reason: 'already_known' });
      continue;
    }
    try {
      const { file, fact } = writePendingOperatorFact(runtimeRoot, {
        ...record,
        migrated_from_observation: true,
      });
      knownIds.add(fact.id);
      migrated.push({ id: fact.id, file, content: fact.content });
      if (store?.recordEvolutionEvent) {
        store.recordEvolutionEvent({
          type: 'operator_fact_migrated',
          status: 'ok',
          fact_id: fact.id,
          content: String(fact.content || '').slice(0, 240),
        });
      }
    } catch (e) {
      skipped.push({ id: record.id, reason: e?.message || String(e) });
    }
  }
  return { migrated, skipped };
}

/**
 * Facts that were injected in a specific cycle (or any injected facts if cycleId omitted).
 * Used by Phase 3.5 to digest only this cycle's seeds.
 */
export function selectInjectedOperatorFacts(facts = [], { cycleId = null, batchId = null } = {}) {
  return (facts || []).filter((fact) => {
    const injected = fact?.injected_by_batch || fact?.injected_by_cycle || fact?.activation_batch_id;
    if (!injected) return false;
    if (batchId == null && cycleId == null) return true;
    if (batchId && (fact.injected_by_batch === batchId || fact.activation_batch_id === batchId)) return true;
    if (cycleId && fact.injected_by_cycle === cycleId) return true;
    return false;
  });
}

export { DIGESTION_OUTCOMES };
