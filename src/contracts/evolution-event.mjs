import {
  fail,
  mergeValidationResults,
  ok,
  requireArray,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { EVIDENCE_PRODUCERS } from './evidence-envelope.mjs';

/**
 * Open schema for evolution-events.jsonl rows.
 * Required: id, type, recorded_at. Optional string fields are type-checked when present.
 * Extra fields are allowed (backward-compatible). New writes may include
 * producer / activation_targets / producer_batch_id; historical rows stay valid.
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
    requireOptionalString(event.producer_batch_id, `${path}.producer_batch_id`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (event.id && !String(event.id).startsWith('evt-')) {
    return fail(`${path}.id should use the evt- prefix`);
  }
  if (event.producer != null && !EVIDENCE_PRODUCERS.includes(event.producer)) {
    return fail(`${path}.producer must be one of: ${EVIDENCE_PRODUCERS.join(', ')}`);
  }
  if (event.activation_targets != null) {
    const targets = requireArray(event.activation_targets, `${path}.activation_targets`);
    if (!targets.ok) return targets;
    if (!event.activation_targets.every((item) => typeof item === 'string' && item.trim())) {
      return fail(`${path}.activation_targets must be an array of non-empty strings`);
    }
  }
  return ok();
}
