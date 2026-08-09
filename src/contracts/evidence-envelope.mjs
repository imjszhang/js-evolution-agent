import {
  fail,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

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

  return ok();
}
