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

export const DECISION_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'blocked',
  'expired',
  'retired',
  'cancelled',
  'acknowledged',
]);

const DECISION_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['in_progress', 'expired', 'retired', 'cancelled']),
  in_progress: Object.freeze(['pending', 'completed', 'failed', 'blocked', 'cancelled']),
  blocked: Object.freeze(['pending', 'expired', 'retired', 'cancelled']),
});

export function validateDecisionTransition(fromStatus, toStatus, path = 'decision_transition') {
  if (!DECISION_STATUSES.includes(fromStatus)) {
    return fail(`${path}.from is not a known status: ${fromStatus}`);
  }
  if (!DECISION_STATUSES.includes(toStatus)) {
    return fail(`${path}.to is not a known status: ${toStatus}`);
  }
  if (fromStatus === toStatus) return ok();
  const allowed = DECISION_TRANSITIONS[fromStatus] ?? [];
  return allowed.includes(toStatus)
    ? ok()
    : fail(`${path} is illegal: ${fromStatus} -> ${toStatus}`);
}

export function validateActionShape(action, path = 'action') {
  const base = requirePlainObject(action, path);
  if (!base.ok) return base;
  return mergeValidationResults([
    requireString(action.type, `${path}.type`),
    requireOptionalString(action.description, `${path}.description`, { allowEmpty: true }),
  ]);
}

export function validateDecision(decision, path = 'decision') {
  const base = requirePlainObject(decision, path);
  if (!base.ok) return base;
  const errors = [];
  const required = mergeValidationResults([
    requireString(decision.id, `${path}.id`),
    requireString(decision.status, `${path}.status`),
    validateActionShape(decision.action, `${path}.action`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (decision.status && !DECISION_STATUSES.includes(decision.status)) {
    errors.push(`${path}.status is not a known status: ${decision.status}`);
  }
  if (decision.metadata != null && !isPlainObject(decision.metadata)) {
    errors.push(`${path}.metadata must be an object when present`);
  } else if (decision.metadata != null) {
    const metadata = mergeValidationResults([
      requireOptionalString(decision.metadata.producer_batch_id, `${path}.metadata.producer_batch_id`, { allowEmpty: true }),
      requireOptionalString(decision.metadata.reaction_id, `${path}.metadata.reaction_id`, { allowEmpty: true }),
      requireOptionalString(decision.metadata.decision_id, `${path}.metadata.decision_id`, { allowEmpty: true }),
      requireOptionalString(decision.metadata.execution_id, `${path}.metadata.execution_id`, { allowEmpty: true }),
      requireOptionalString(decision.metadata.belief_id, `${path}.metadata.belief_id`, { allowEmpty: true }),
    ]);
    if (!metadata.ok) errors.push(...metadata.errors);
    if (decision.metadata.producer != null
      && !EVIDENCE_PRODUCERS.includes(decision.metadata.producer)) {
      errors.push(`${path}.metadata.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`);
    }
  }
  return errors.length ? fail(errors) : ok();
}
