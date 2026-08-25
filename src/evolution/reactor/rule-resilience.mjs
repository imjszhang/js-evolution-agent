import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { nowIso, parsePositiveInt } from '../../infra/runtime-paths.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';
import { evidenceIndexJournalPath } from './evidence-index.mjs';
import { reactorDir } from './paths.mjs';

export const DEFAULT_RULE_MAX_EVENTS = 32;
export const DEFAULT_RULE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RULE_MAX_WALL_MS = 4 * 60 * 1000;
export const DEFAULT_RULE_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_RULE_MAX_JOURNAL_BYTES = 4 * 1024 * 1024 * 1024;

export const RULE_BLOCK_REASONS = Object.freeze({
  circuit: 'rule_poison_batch_circuit_open',
  catchUp: 'rule_catch_up_budget',
  journal: 'rule_journal_capacity_exceeded',
  llmBudget: 'rule_llm_budget_exhausted',
});

function emptyState() {
  return {
    schema_version: 1,
    failures: {},
    quarantined: {},
    updated_at: null,
  };
}

export function ruleResiliencePath(dataRoot) {
  return join(reactorDir(dataRoot), 'rule-resilience.json');
}

export function ruleQuarantinePath(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'rule-quarantine.jsonl');
}

export function resolveRuleLimits(input = {}, env = process.env) {
  const value = (inputKey, envKey, defaultValue, min = 1) => parsePositiveInt(
    input[inputKey] ?? env[envKey],
    { name: envKey, defaultValue, min },
  );
  return {
    maxEvents: value('max_events', 'JEA_RULE_MAX_EVENTS', DEFAULT_RULE_MAX_EVENTS),
    maxPayloadBytes: value(
      'max_payload_bytes',
      'JEA_RULE_MAX_PAYLOAD_BYTES',
      DEFAULT_RULE_MAX_PAYLOAD_BYTES,
    ),
    maxWallMs: value('max_wall_ms', 'JEA_RULE_MAX_WALL_MS', DEFAULT_RULE_MAX_WALL_MS),
    maxConsecutiveFailures: value(
      'max_consecutive_failures',
      'JEA_RULE_MAX_CONSECUTIVE_FAILURES',
      DEFAULT_RULE_MAX_CONSECUTIVE_FAILURES,
    ),
    maxJournalBytes: value(
      'max_journal_bytes',
      'JEA_RULE_MAX_JOURNAL_BYTES',
      DEFAULT_RULE_MAX_JOURNAL_BYTES,
    ),
  };
}

export function readRuleResilience(dataRoot) {
  const raw = readJson(ruleResiliencePath(dataRoot), emptyState());
  return {
    ...emptyState(),
    ...(raw && typeof raw === 'object' ? raw : {}),
    failures: raw?.failures && typeof raw.failures === 'object' ? raw.failures : {},
    quarantined: raw?.quarantined && typeof raw.quarantined === 'object' ? raw.quarantined : {},
  };
}

export function ruleBatchFingerprint(eventsOrKeys = []) {
  const keys = eventsOrKeys
    .map((item) => typeof item === 'string' ? item : envelopeEvidenceKey(item))
    .filter(Boolean);
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

function indexedPayloadBytes(event) {
  const length = Number(event?.indexed_entry?.locator?.length);
  if (Number.isFinite(length) && length >= 0) return length;
  try {
    return Buffer.byteLength(JSON.stringify(event));
  } catch (error) {
    const capacity = new RangeError(`rule_payload_measure_failed: ${error?.message || error}`);
    capacity.code = 'rule_payload_measure_failed';
    capacity.retryable = false;
    throw capacity;
  }
}

export function planRuleBatch(dataRoot, events = [], limits = resolveRuleLimits()) {
  const state = readRuleResilience(dataRoot);
  let cap = Math.max(1, limits.maxEvents);
  const firstKey = events[0] ? envelopeEvidenceKey(events[0]) : null;
  for (const failure of Object.values(state.failures)) {
    if (
      failure?.status === 'splitting'
      && failure?.evidence_keys?.[0] === firstKey
      && Number.isInteger(failure.next_max_events)
    ) {
      cap = Math.min(cap, Math.max(1, failure.next_max_events));
    }
  }
  const selected = [];
  let payloadBytes = 0;
  for (const event of events.slice(0, cap)) {
    const bytes = indexedPayloadBytes(event);
    if (selected.length && payloadBytes + bytes > limits.maxPayloadBytes) break;
    selected.push(event);
    payloadBytes += bytes;
    if (payloadBytes >= limits.maxPayloadBytes) break;
  }
  const fingerprint = ruleBatchFingerprint(selected);
  const failure = state.failures[fingerprint] ?? null;
  return {
    events: selected,
    evidence_keys: selected.map((event) => envelopeEvidenceKey(event)),
    fingerprint,
    payload_bytes: payloadBytes,
    blocked: failure?.status === 'circuit_open',
    block_reason: failure?.status === 'circuit_open'
      ? failure.block_reason || RULE_BLOCK_REASONS.circuit
      : null,
    failure,
    limits,
  };
}

export function classifyReactorError(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  const budgetExhausted = /(?:llm_)?(?:token|spend)[_ ]budget[_ ]exhausted/i.test(
    `${code} ${message}`,
  );
  const deterministic = error instanceof RangeError
    || error?.retryable === false
    || /invalid string length|string too long|ERR_STRING_TOO_LONG/i.test(message)
    || /payload.*(?:limit|large|exceed)|journal.*(?:limit|large|exceed)/i.test(message)
    || code.startsWith('rule_capacity_')
    || code === 'rule_payload_measure_failed';
  if (budgetExhausted) {
    return {
      retryable: false,
      category: 'operator_budget',
      code: code || 'rule_llm_budget_exhausted',
      reason: message || code,
    };
  }
  return {
    retryable: !deterministic,
    category: deterministic ? 'deterministic_capacity' : 'transient',
    code: code || (deterministic ? 'rule_deterministic_capacity' : 'reactor_transient_failure'),
    reason: message || code || 'reactor failure',
  };
}

export function assertRuleJournalBudget(dataRoot, limits) {
  const path = evidenceIndexJournalPath(dataRoot);
  const bytes = existsSync(path) ? statSync(path).size : 0;
  if (bytes > limits.maxJournalBytes) {
    const error = new RangeError(
      `Rule evidence journal exceeds configured capacity (${bytes} > ${limits.maxJournalBytes})`,
    );
    error.code = 'rule_capacity_journal_exceeded';
    error.retryable = false;
    error.journal_bytes = bytes;
    throw error;
  }
  return bytes;
}

export function assertRuleWallBudget(startedAt, limits) {
  if (Date.now() - startedAt < limits.maxWallMs) return;
  const error = new RangeError(`Rule wall-clock budget exceeded (${limits.maxWallMs}ms)`);
  error.code = 'rule_capacity_wall_clock_exceeded';
  error.retryable = false;
  throw error;
}

export function noteRuleFailure(dataRoot, {
  fingerprint,
  evidenceKeys,
  error,
  eventCount,
  limits,
} = {}) {
  const classification = classifyReactorError(error);
  let result = null;
  updateJson(ruleResiliencePath(dataRoot), (raw) => {
    const state = {
      ...emptyState(),
      ...(raw || {}),
      failures: { ...(raw?.failures || {}) },
      quarantined: { ...(raw?.quarantined || {}) },
    };
    const previous = state.failures[fingerprint] ?? {};
    const failures = (Number(previous.consecutive_failures) || 0) + 1;
    let status = 'retrying';
    let action = 'retry';
    let nextMaxEvents = null;
    let blockReason = null;
    if (classification.category === 'operator_budget') {
      status = 'circuit_open';
      action = 'block';
      blockReason = RULE_BLOCK_REASONS.llmBudget;
    } else if (classification.category === 'deterministic_capacity' && eventCount > 1) {
      status = 'splitting';
      action = 'split';
      nextMaxEvents = Math.max(1, Math.floor(eventCount / 2));
    } else if (classification.category === 'deterministic_capacity') {
      status = 'quarantine_required';
      action = 'quarantine';
    } else if (failures >= limits.maxConsecutiveFailures) {
      status = 'circuit_open';
      action = 'block';
    }
    result = {
      fingerprint,
      evidence_keys: evidenceKeys,
      event_count: eventCount,
      consecutive_failures: failures,
      classification: classification.category,
      error_code: classification.code,
      error_reason: classification.reason,
      status,
      action,
      block_reason: blockReason,
      next_max_events: nextMaxEvents,
      last_failed_at: nowIso(),
    };
    state.failures[fingerprint] = result;
    state.updated_at = nowIso();
    return state;
  }, { fallback: emptyState() });
  return { ...result, retryable: classification.retryable && result.action === 'retry' };
}

export function clearRuleFailure(dataRoot, fingerprint) {
  if (!fingerprint) return;
  updateJson(ruleResiliencePath(dataRoot), (raw) => {
    const state = { ...emptyState(), ...(raw || {}), failures: { ...(raw?.failures || {}) } };
    delete state.failures[fingerprint];
    state.updated_at = nowIso();
    return state;
  }, { fallback: emptyState() });
}

export function clearOperatorBudgetBlocks(dataRoot) {
  let cleared = 0;
  const fingerprints = [];
  updateJson(ruleResiliencePath(dataRoot), (raw) => {
    const state = {
      ...emptyState(),
      ...(raw || {}),
      failures: { ...(raw?.failures || {}) },
      quarantined: raw?.quarantined && typeof raw.quarantined === 'object' ? raw.quarantined : {},
    };
    for (const [fingerprint, failure] of Object.entries(state.failures)) {
      if (
        failure?.classification === 'operator_budget'
        || failure?.block_reason === RULE_BLOCK_REASONS.llmBudget
      ) {
        delete state.failures[fingerprint];
        fingerprints.push(fingerprint);
        cleared += 1;
      }
    }
    if (cleared) state.updated_at = nowIso();
    return state;
  }, { fallback: emptyState() });
  return { cleared, fingerprints };
}

export function quarantineRuleEvidence(dataRoot, {
  fingerprint,
  event,
  error,
  batchId,
} = {}) {
  const key = envelopeEvidenceKey(event);
  const record = {
    schema_version: 1,
    quarantine_id: `rule-quarantine:${fingerprint}`,
    fingerprint,
    evidence_key: key,
    event_id: event?.id ?? null,
    kind: event?.kind ?? null,
    batch_id: batchId ?? null,
    reason_code: classifyReactorError(error).code,
    reason: String(error?.message || error || 'deterministic Rule failure'),
    quarantined_at: nowIso(),
  };
  const path = ruleQuarantinePath(dataRoot);
  const marker = `${path}.${fingerprint}`;
  if (!existsSync(marker)) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    writeFileSync(marker, `${record.quarantine_id}\n`, { flag: 'w' });
  }
  updateJson(ruleResiliencePath(dataRoot), (raw) => {
    const state = {
      ...emptyState(),
      ...(raw || {}),
      failures: { ...(raw?.failures || {}) },
      quarantined: { ...(raw?.quarantined || {}) },
    };
    state.quarantined[fingerprint] = state.quarantined[fingerprint] ?? record;
    state.failures[fingerprint] = {
      ...(state.failures[fingerprint] || {}),
      status: 'quarantined',
      action: 'quarantined',
      evidence_keys: [key],
      last_failed_at: nowIso(),
    };
    state.updated_at = nowIso();
    return state;
  }, { fallback: emptyState() });
  return record;
}

export function readRuleResilienceProjection(dataRoot) {
  const state = readRuleResilience(dataRoot);
  const failures = Object.values(state.failures);
  const blocked = failures.filter((item) => item?.status === 'circuit_open');
  const splitting = failures.filter((item) => item?.status === 'splitting');
  const latestBlocked = blocked
    .sort((a, b) => String(b?.last_failed_at ?? '').localeCompare(String(a?.last_failed_at ?? '')))[0]
    ?? null;
  return {
    blocked: blocked.length > 0,
    block_reason: latestBlocked?.block_reason
      || (blocked.length ? RULE_BLOCK_REASONS.circuit : null),
    blocked_batches: blocked.length,
    splitting_batches: splitting.length,
    quarantined_evidence: Object.keys(state.quarantined).length,
    latest_failure: failures
      .sort((a, b) => String(b?.last_failed_at ?? '').localeCompare(String(a?.last_failed_at ?? '')))[0]
      ?? null,
    updated_at: state.updated_at,
  };
}
