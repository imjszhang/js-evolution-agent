import {
  fail,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

/**
 * Open schema for evolution-events.jsonl rows.
 * Required: id, type, recorded_at. Optional string fields are type-checked when present.
 * Extra fields are allowed (backward-compatible); provenance tightening is deferred.
 */
export function validateEvolutionEvent(event, path = 'evolution_event') {
  const base = requirePlainObject(event, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(event.id, `${path}.id`),
    requireString(event.type, `${path}.type`),
    requireString(event.recorded_at, `${path}.recorded_at`),
    requireOptionalString(event.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(event.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(event.status, `${path}.status`, { allowEmpty: true }),
    requireOptionalString(event.stage, `${path}.stage`, { allowEmpty: true }),
    requireOptionalString(event.pipeline, `${path}.pipeline`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (event.id && !String(event.id).startsWith('evt-')) {
    return fail(`${path}.id should use the evt- prefix`);
  }
  return ok();
}
