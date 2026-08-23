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
import { EVIDENCE_BATCH_REACTORS } from './evidence-batch-claim.mjs';

export const BATCH_CHECKPOINT_STAGES = Object.freeze([
  'prepare',
  'writing',
  'claimed',
  'investigate',
  'report',
  'decide',
  'committed',
  'quarantined',
  'failed',
  'deferred',
]);

/**
 * Atomic evidence-batch checkpoint (S4). Recovery truth during dual-write
 * with cycle-state/<id>/reactor.json.
 */
export function validateBatchCheckpoint(record, path = 'batch_checkpoint') {
  const base = requirePlainObject(record, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(record.batch_id, `${path}.batch_id`),
    requireString(record.reactor, `${path}.reactor`),
    requireString(record.written_at, `${path}.written_at`),
    requireOneOf(record.stage, `${path}.stage`, BATCH_CHECKPOINT_STAGES),
    requireArray(record.event_ids, `${path}.event_ids`),
    requireOptionalString(record.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(record.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(record.last_error, `${path}.last_error`, { allowEmpty: true }),
    requireOptionalString(record.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (!String(record.batch_id).startsWith('batch-')) {
    return fail(`${path}.batch_id should use the batch- prefix`);
  }
  if (!EVIDENCE_BATCH_REACTORS.includes(record.reactor)) {
    return fail(`${path}.reactor must be one of: ${EVIDENCE_BATCH_REACTORS.join(', ')}`);
  }
  if (!record.event_ids.every((id) => typeof id === 'string' && id.trim())) {
    return fail(`${path}.event_ids must be an array of non-empty strings`);
  }
  if (record.attempt != null && (!Number.isFinite(Number(record.attempt)) || Number(record.attempt) < 0)) {
    return fail(`${path}.attempt must be a non-negative number when present`);
  }
  if (record.queued_decision_ids != null) {
    const ids = requireArray(record.queued_decision_ids, `${path}.queued_decision_ids`);
    if (!ids.ok) return ids;
    if (!record.queued_decision_ids.every((id) => typeof id === 'string' && id.trim())) {
      return fail(`${path}.queued_decision_ids must be an array of non-empty strings`);
    }
  }
  if (record.covered_batch_ids != null) {
    const ids = requireArray(record.covered_batch_ids, `${path}.covered_batch_ids`);
    if (!ids.ok) return ids;
    if (!record.covered_batch_ids.every((id) => typeof id === 'string' && id.startsWith('batch-'))) {
      return fail(`${path}.covered_batch_ids must contain batch- ids`);
    }
  }
  if (record.evidence_keys != null) {
    const keys = requireArray(record.evidence_keys, `${path}.evidence_keys`);
    if (!keys.ok) return keys;
    if (!record.evidence_keys.every((id) => typeof id === 'string' && id.includes(':'))) {
      return fail(`${path}.evidence_keys must be an array of kind:id strings`);
    }
  }
  if (record.activation_targets != null) {
    const targets = requireArray(record.activation_targets, `${path}.activation_targets`);
    if (!targets.ok) return targets;
    if (!record.activation_targets.every((target) => typeof target === 'string' && target.trim())) {
      return fail(`${path}.activation_targets must contain non-empty strings`);
    }
  }
  if (record.honesty != null) {
    const honesty = requirePlainObject(record.honesty, `${path}.honesty`);
    if (!honesty.ok) return honesty;
    const honestyFields = mergeValidationResults([
      requireOptionalString(record.honesty.status, `${path}.honesty.status`, { allowEmpty: true }),
    ]);
    if (!honestyFields.ok) return honestyFields;
  }
  return ok();
}
