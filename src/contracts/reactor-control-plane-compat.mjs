import { isPlainObject, ok } from './validation.mjs';
import { validateEvidenceEnvelope } from './evidence-envelope.mjs';
import { validateEvidenceBatchClaim } from './evidence-batch-claim.mjs';
import { validateWakeIntent } from './wake-intent.mjs';
import { validateBatchCheckpoint } from './batch-checkpoint.mjs';
import { validateBeliefEvent, validateGoalEvent } from './belief-goal-events.mjs';
import {
  ACTIVATION_LANES,
} from './activation-ledger.mjs';
import {
  formatActivationIdentity,
  normalizeActivationIdentity,
} from './activation-identity.mjs';

export const LEGACY_UNKNOWN = 'legacy_unknown';

function presentString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readIdentityParts(record = {}) {
  const nested = isPlainObject(record.identity) ? record.identity : {};
  return {
    reactor: presentString(record.reactor) || presentString(nested.reactor),
    evidence_key: presentString(record.evidence_key) || presentString(nested.evidence_key),
    activation_policy_version: presentString(record.activation_policy_version)
      || presentString(nested.activation_policy_version),
  };
}

/**
 * Interpret missing 0.3.0 control-plane fields as legacy_unknown.
 * Never infer activation_reason from kind/type/producer, and never invent a
 * handled identity from journal offsets or partial claim keys.
 */
export function interpretLegacyControlPlaneMetadata(record = {}, _path = 'record') {
  if (!isPlainObject(record)) {
    return Object.freeze({
      readable: false,
      activation_reason: LEGACY_UNKNOWN,
      handled_identity: LEGACY_UNKNOWN,
      lane: LEGACY_UNKNOWN,
      activation_policy_version: LEGACY_UNKNOWN,
      fabricated: false,
      inferred: false,
    });
  }

  const parts = readIdentityParts(record);
  const identity = parts.reactor && parts.evidence_key && parts.activation_policy_version
    ? normalizeActivationIdentity(parts)
    : { ok: false, identity: null };

  const reason = presentString(record.activation_reason);
  const lane = ACTIVATION_LANES.includes(record.lane) ? record.lane : null;
  const policy = parts.activation_policy_version;

  return Object.freeze({
    readable: true,
    activation_reason: reason ?? LEGACY_UNKNOWN,
    handled_identity: identity.ok ? formatActivationIdentity(identity.identity) : LEGACY_UNKNOWN,
    lane: lane ?? LEGACY_UNKNOWN,
    activation_policy_version: policy ?? LEGACY_UNKNOWN,
    fabricated: false,
    inferred: false,
  });
}

function wrapCompatible(record, validation, path) {
  return Object.freeze({
    readable: validation.ok,
    validation,
    control_plane: interpretLegacyControlPlaneMetadata(record, path),
  });
}

export function readCompatibleEvidenceEnvelope(record, path = 'evidence_envelope') {
  return wrapCompatible(record, validateEvidenceEnvelope(record, path), path);
}

export function readCompatibleEvidenceBatchClaim(record, path = 'evidence_batch_claim') {
  return wrapCompatible(record, validateEvidenceBatchClaim(record, path), path);
}

export function readCompatibleWakeIntent(record, path = 'wake_intent') {
  return wrapCompatible(record, validateWakeIntent(record, path), path);
}

export function readCompatibleBatchCheckpoint(record, path = 'batch_checkpoint') {
  return wrapCompatible(record, validateBatchCheckpoint(record, path), path);
}

export function readCompatibleSettlement(record, path = 'settlement') {
  const type = String(record?.type || '');
  const validation = type.includes('goal') || record?.goal_id
    ? validateGoalEvent(record, path)
    : validateBeliefEvent(record, path);
  return wrapCompatible(record, validation, path);
}

export function readCompatibleCursor(record, path = 'cursor') {
  const validation = isPlainObject(record) ? ok() : {
    ok: false,
    errors: [`${path} must be an object`],
  };
  return wrapCompatible(record, validation, path);
}

export function mustNotFabricateActivationReason() {
  return LEGACY_UNKNOWN;
}

export function mustNotFabricateHandledIdentity() {
  return LEGACY_UNKNOWN;
}
