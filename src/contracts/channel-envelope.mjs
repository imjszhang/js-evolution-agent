import {
  fail,
  requireArray,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export function validateChannelInboundEnvelope(envelope, path = 'channel_inbound_envelope') {
  const base = requirePlainObject(envelope, path);
  if (!base.ok) return base;
  const checks = [
    requireString(envelope.channel, `${path}.channel`),
    requireString(envelope.adapter, `${path}.adapter`),
    requireString(envelope.direction, `${path}.direction`),
    requireString(envelope.message_id, `${path}.message_id`),
    requireString(envelope.chat_id, `${path}.chat_id`),
    requireString(envelope.content, `${path}.content`, { allowEmpty: true }),
    requireString(envelope.content_type, `${path}.content_type`),
    requireArray(envelope.resources, `${path}.resources`),
    requireArray(envelope.mentions, `${path}.mentions`),
    requireString(envelope.received_at, `${path}.received_at`),
    requirePlainObject(envelope.metadata, `${path}.metadata`),
  ];
  if (envelope.direction !== 'inbound') {
    checks.push(fail(`${path}.direction must be inbound`));
  }
  if (envelope.schema_version !== 1) {
    checks.push(fail(`${path}.schema_version must be 1`));
  }
  return mergeValidationResults(checks);
}

export function validateChannelOutboundEnvelope(envelope, path = 'channel_outbound_envelope') {
  const base = requirePlainObject(envelope, path);
  if (!base.ok) return base;
  const checks = [
    requireString(envelope.channel, `${path}.channel`),
    requireString(envelope.adapter, `${path}.adapter`),
    requireString(envelope.target, `${path}.target`),
    requireString(envelope.text, `${path}.text`, { allowEmpty: true }),
    requireOptionalString(envelope.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(envelope.reason, `${path}.reason`, { allowEmpty: true }),
    requireString(envelope.priority, `${path}.priority`),
    requireString(envelope.created_at, `${path}.created_at`),
    requirePlainObject(envelope.metadata, `${path}.metadata`),
  ];
  if (!envelope.text && !envelope.card && !envelope.document) {
    checks.push(fail(`${path} requires text, card, or document`));
  }
  if (envelope.schema_version !== 1) {
    checks.push(fail(`${path}.schema_version must be 1`));
  }
  return mergeValidationResults(checks);
}

function validateLegacyChannelEnvelope(envelope, path) {
  const checks = [
    requireString(envelope.id, `${path}.id`),
    requireOptionalString(envelope.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(envelope.text, `${path}.text`, { allowEmpty: true }),
    requireOptionalString(envelope.target, `${path}.target`, { allowEmpty: true }),
  ];
  if (envelope.meta != null) checks.push(requirePlainObject(envelope.meta, `${path}.meta`));
  return mergeValidationResults(checks);
}

export function validateChannelEnvelope(envelope, path = 'channel_envelope') {
  const base = requirePlainObject(envelope, path);
  if (!base.ok) return base;
  if (envelope.direction === 'inbound' || envelope.message_id != null || envelope.chat_id != null) {
    return validateChannelInboundEnvelope(envelope, path);
  }
  if (envelope.target != null && (envelope.channel != null || envelope.adapter != null)) {
    return validateChannelOutboundEnvelope(envelope, path);
  }
  return validateLegacyChannelEnvelope(envelope, path);
}
