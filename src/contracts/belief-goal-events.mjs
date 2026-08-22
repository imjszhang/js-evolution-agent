import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { EVIDENCE_PRODUCERS } from './evidence-envelope.mjs';

function validateCausalIdentity(record, path) {
  const checks = mergeValidationResults([
    requireOptionalString(record.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
    requireOptionalString(record.reaction_id, `${path}.reaction_id`, { allowEmpty: true }),
    requireOptionalString(record.decision_id, `${path}.decision_id`, { allowEmpty: true }),
    requireOptionalString(record.execution_id, `${path}.execution_id`, { allowEmpty: true }),
    requireOptionalString(record.settlement_id, `${path}.settlement_id`, { allowEmpty: true }),
    requireOptionalString(record.settlement_effect, `${path}.settlement_effect`, { allowEmpty: true }),
  ]);
  if (!checks.ok) return checks;
  if (record.producer != null && !EVIDENCE_PRODUCERS.includes(record.producer)) {
    return fail(`${path}.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`);
  }
  return ok();
}

export function validateBeliefEvent(event, path = 'belief_event') {
  const base = requirePlainObject(event, path);
  if (!base.ok) return base;
  const required = mergeValidationResults([
    requireString(event.type, `${path}.type`),
    requireOptionalString(event.belief_id, `${path}.belief_id`, { allowEmpty: true }),
    requireOptionalString(event.goal_id, `${path}.goal_id`, { allowEmpty: true }),
    requireOptionalString(event.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    validateCausalIdentity(event, path),
  ]);
  return required.ok ? ok() : required;
}

export function validateGoalEvent(event, path = 'goal_event') {
  const base = requirePlainObject(event, path);
  if (!base.ok) return base;
  const required = mergeValidationResults([
    requireString(event.type, `${path}.type`),
    requireOptionalString(event.reason, `${path}.reason`, { allowEmpty: true }),
    requireOptionalString(event.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(event.belief_id, `${path}.belief_id`, { allowEmpty: true }),
    validateCausalIdentity(event, path),
  ]);
  if (event.proposed_goal != null && !isPlainObject(event.proposed_goal)) {
    return fail([`${path}.proposed_goal must be an object when present`]);
  }
  return required.ok ? ok() : required;
}
