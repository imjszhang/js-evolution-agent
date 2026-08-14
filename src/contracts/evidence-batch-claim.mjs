import {
  fail,
  mergeValidationResults,
  ok,
  requireArray,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const EVIDENCE_BATCH_CLAIM_STATUSES = Object.freeze([
  'claimed',
  'handled',
  'failed',
  'released',
]);

export const EVIDENCE_BATCH_REACTORS = Object.freeze([
  'cognitive',
  'rule',
  'memory',
]);

/**
 * Claim ledger record for evidence batches (Phase 2).
 * Required: batch_id, reactor, claimed_at, deadline_at, event_ids, status.
 */
export function validateEvidenceBatchClaim(claim, path = 'evidence_batch_claim') {
  const base = requirePlainObject(claim, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(claim.batch_id, `${path}.batch_id`),
    requireString(claim.reactor, `${path}.reactor`),
    requireString(claim.claimed_at, `${path}.claimed_at`),
    requireString(claim.deadline_at, `${path}.deadline_at`),
    requireArray(claim.event_ids, `${path}.event_ids`),
    requireOneOf(claim.status, `${path}.status`, EVIDENCE_BATCH_CLAIM_STATUSES),
    requireOptionalString(claim.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(claim.last_error, `${path}.last_error`, { allowEmpty: true }),
    requireOptionalString(claim.handled_at, `${path}.handled_at`, { allowEmpty: true }),
    requireOptionalString(claim.stream_cursor, `${path}.stream_cursor`, { allowEmpty: true }),
    requireOptionalString(claim.activation_batch_id, `${path}.activation_batch_id`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (!String(claim.batch_id).startsWith('batch-')) {
    return fail(`${path}.batch_id should use the batch- prefix`);
  }
  if (!EVIDENCE_BATCH_REACTORS.includes(claim.reactor)) {
    return fail(`${path}.reactor must be one of: ${EVIDENCE_BATCH_REACTORS.join(', ')}`);
  }
  if (!claim.event_ids.every((id) => typeof id === 'string' && id.trim())) {
    return fail(`${path}.event_ids must be an array of non-empty strings`);
  }
  if (claim.attempt != null && (!Number.isFinite(Number(claim.attempt)) || Number(claim.attempt) < 0)) {
    return fail(`${path}.attempt must be a non-negative number when present`);
  }
  if (claim.evidence_keys != null) {
    const keys = requireArray(claim.evidence_keys, `${path}.evidence_keys`);
    if (!keys.ok) return keys;
    if (!claim.evidence_keys.every((id) => typeof id === 'string' && id.includes(':'))) {
      return fail(`${path}.evidence_keys must be an array of kind:id strings`);
    }
  }
  return ok();
}
