import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export function validateBeliefEvent(event, path = 'belief_event') {
  const base = requirePlainObject(event, path);
  if (!base.ok) return base;
  const required = mergeValidationResults([
    requireString(event.type, `${path}.type`),
    requireOptionalString(event.belief_id, `${path}.belief_id`, { allowEmpty: true }),
    requireOptionalString(event.goal_id, `${path}.goal_id`, { allowEmpty: true }),
    requireOptionalString(event.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
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
  ]);
  if (event.proposed_goal != null && !isPlainObject(event.proposed_goal)) {
    return fail([`${path}.proposed_goal must be an object when present`]);
  }
  return required.ok ? ok() : required;
}
