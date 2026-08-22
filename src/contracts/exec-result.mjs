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
import { EVIDENCE_PRODUCERS } from './evidence-envelope.mjs';

export const EXEC_RESULT_STATUSES = Object.freeze([
  'pending_verify',
  'verifying',
  'verified',
  'verify_failed',
]);

/**
 * Persisted exec outcome claimed independently by verify.
 * Required: execution_id, written_at, verify_status, executed.
 */
export function validateExecResult(record, path = 'exec_result') {
  const base = requirePlainObject(record, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(record.execution_id, `${path}.execution_id`),
    requireString(record.written_at, `${path}.written_at`),
    requireOneOf(record.verify_status, `${path}.verify_status`, EXEC_RESULT_STATUSES),
    requireArray(record.executed, `${path}.executed`),
    requireOptionalString(record.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(record.report_path, `${path}.report_path`, { allowEmpty: true }),
    requireOptionalString(record.last_error, `${path}.last_error`, { allowEmpty: true }),
    requireOptionalString(record.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
    requireOptionalString(record.reaction_id, `${path}.reaction_id`, { allowEmpty: true }),
    requireOptionalString(record.decision_id, `${path}.decision_id`, { allowEmpty: true }),
    requireOptionalString(record.belief_id, `${path}.belief_id`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;
  if (record.decision_ids != null) {
    const decisionIds = requireArray(record.decision_ids, `${path}.decision_ids`);
    if (!decisionIds.ok) return decisionIds;
    if (!record.decision_ids.every((item) => typeof item === 'string' && item.trim())) {
      return fail(`${path}.decision_ids must be an array of non-empty strings`);
    }
  }
  if (record.producer != null && !EVIDENCE_PRODUCERS.includes(record.producer)) {
    return fail(`${path}.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`);
  }
  return ok();
}
