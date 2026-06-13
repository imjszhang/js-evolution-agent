import {
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export function validateChannelEnvelope(envelope, path = 'channel_envelope') {
  const base = requirePlainObject(envelope, path);
  if (!base.ok) return base;
  const checks = [
    requireString(envelope.id, `${path}.id`),
    requireOptionalString(envelope.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(envelope.text, `${path}.text`, { allowEmpty: true }),
    requireOptionalString(envelope.target, `${path}.target`, { allowEmpty: true }),
  ];
  if (envelope.meta != null) checks.push(requirePlainObject(envelope.meta, `${path}.meta`));
  return mergeValidationResults(checks);
}
