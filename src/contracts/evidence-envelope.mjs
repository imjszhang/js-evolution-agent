import {
  fail,
  mergeValidationResults,
  ok,
  requireArray,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const EVIDENCE_PRODUCERS = Object.freeze([
  'exec',
  'verify',
  'channel',
  'operator',
  'cognitive',
  'rule',
  'memory',
  'external',
]);

export function evidenceKey(kind, id) {
  return `${String(kind || '').trim()}:${String(id || '').trim()}`;
}

export function parseEvidenceKey(key) {
  const raw = String(key || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return { kind: '', id: raw };
  return { kind: raw.slice(0, idx), id: raw.slice(idx + 1) };
}

/**
 * Source kinds projected into the virtual evidence stream (Phase 1).
 * Kind names align with evidence-audit store names where possible.
 */
export const EVIDENCE_SOURCE_KINDS = Object.freeze([
  'action_receipts',
  'evolution_events',
  'probe_results',
  'goal_events',
  'belief_events',
  'intel_observations',
  'reports',
  'verify_reports',
  'operator_briefs',
  'operator_facts',
  'operator_questions',
  'channel_events',
]);

/**
 * Virtual evidence-stream envelope (read-side projection).
 * Required: id, kind, type, occurred_at, provenance.
 * Extra fields allowed; payload carries the source record.
 */
export function validateEvidenceEnvelope(envelope, path = 'evidence_envelope') {
  const base = requirePlainObject(envelope, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(envelope.id, `${path}.id`),
    requireString(envelope.kind, `${path}.kind`),
    requireString(envelope.type, `${path}.type`),
    requireString(envelope.occurred_at, `${path}.occurred_at`),
    requirePlainObject(envelope.provenance, `${path}.provenance`),
    requireOptionalString(envelope.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(envelope.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(envelope.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (!EVIDENCE_SOURCE_KINDS.includes(envelope.kind)) {
    return fail(`${path}.kind must be one of: ${EVIDENCE_SOURCE_KINDS.join(', ')}`);
  }

  const provenance = envelope.provenance;
  const provenanceCheck = mergeValidationResults([
    requireString(provenance.store, `${path}.provenance.store`),
    requireOptionalString(provenance.file, `${path}.provenance.file`, { allowEmpty: true }),
    requireOptionalString(provenance.id, `${path}.provenance.id`, { allowEmpty: true }),
  ]);
  if (!provenanceCheck.ok) return provenanceCheck;

  if (envelope.producer != null && !EVIDENCE_PRODUCERS.includes(envelope.producer)) {
    return fail(`${path}.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`);
  }
  if (envelope.activation_targets != null) {
    const targets = requireArray(envelope.activation_targets, `${path}.activation_targets`);
    if (!targets.ok) return targets;
    if (!envelope.activation_targets.every((item) => typeof item === 'string' && item.trim())) {
      return fail(`${path}.activation_targets must be an array of non-empty strings`);
    }
  }
  if (envelope.evidence_key != null) {
    const key = requireString(envelope.evidence_key, `${path}.evidence_key`);
    if (!key.ok) return key;
    if (!String(envelope.evidence_key).includes(':')) {
      return fail(`${path}.evidence_key must use kind:id`);
    }
  }
  return ok();
}
