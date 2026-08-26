import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireBoolean,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { EVIDENCE_BATCH_REACTORS } from './evidence-batch-claim.mjs';
import { parseEvidenceKey } from './evidence-envelope.mjs';

/**
 * 0.3.0 Reactor control-plane contract version.
 * Distinct from package version (now 0.3.0) and from activation policy epochs.
 */
export const REACTOR_CONTROL_PLANE_CONTRACT_VERSION = '0.3.0';

/**
 * First published eligibility/routing policy epoch.
 * Downstream routers (#211) bump this string when activation rules change.
 * A bump never silently backfills historical evidence.
 */
export const INITIAL_ACTIVATION_POLICY_VERSION = 'activation-policy.v1';

export const ACTIVATION_IDENTITY_PREFIX = 'aiv1';

export const REPLAY_EPOCH_KINDS = Object.freeze([
  'policy_backfill',
]);

export const REPLAY_EPOCH_ID_PREFIX = 'replay-epoch-';

const POLICY_VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isActivationReactor(value) {
  return EVIDENCE_BATCH_REACTORS.includes(value);
}

export function isActivationPolicyVersion(value) {
  return typeof value === 'string' && value.trim() !== '' && POLICY_VERSION_PATTERN.test(value);
}

export function buildActivationIdentity(input = {}) {
  return Object.freeze({
    reactor: String(input.reactor || '').trim(),
    evidence_key: String(input.evidence_key || '').trim(),
    activation_policy_version: String(input.activation_policy_version || '').trim(),
  });
}

export function validateActivationIdentity(identity, path = 'activation_identity') {
  const base = requirePlainObject(identity, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(identity.reactor, `${path}.reactor`),
    requireString(identity.evidence_key, `${path}.evidence_key`),
    requireString(identity.activation_policy_version, `${path}.activation_policy_version`),
  ]);
  if (!required.ok) return required;

  if (!isActivationReactor(identity.reactor)) {
    return fail(`${path}.reactor must be one of: ${EVIDENCE_BATCH_REACTORS.join(', ')}`);
  }
  if (!String(identity.evidence_key).includes(':')) {
    return fail(`${path}.evidence_key must use kind:id`);
  }
  if (!isActivationPolicyVersion(identity.activation_policy_version)) {
    return fail(`${path}.activation_policy_version must match ${POLICY_VERSION_PATTERN}`);
  }
  return ok();
}

/**
 * Canonical, parseable identity key. Journal generation is intentionally absent
 * so handled work survives rebuild/rollback.
 */
export function formatActivationIdentity(identity) {
  const built = buildActivationIdentity(identity);
  return [
    ACTIVATION_IDENTITY_PREFIX,
    built.reactor,
    built.activation_policy_version,
    built.evidence_key,
  ].join('/');
}

export function parseActivationIdentity(key, path = 'activation_identity_key') {
  const raw = String(key || '');
  const prefix = `${ACTIVATION_IDENTITY_PREFIX}/`;
  if (!raw.startsWith(prefix)) {
    return { ok: false, errors: [`${path} must start with ${prefix}`], identity: null };
  }
  const rest = raw.slice(prefix.length);
  const first = rest.indexOf('/');
  const second = first >= 0 ? rest.indexOf('/', first + 1) : -1;
  if (first <= 0 || second <= first) {
    return { ok: false, errors: [`${path} must be aiv1/<reactor>/<policy>/<evidence_key>`], identity: null };
  }
  const identity = buildActivationIdentity({
    reactor: rest.slice(0, first),
    activation_policy_version: rest.slice(first + 1, second),
    evidence_key: rest.slice(second + 1),
  });
  const validation = validateActivationIdentity(identity, path);
  return validation.ok
    ? { ok: true, errors: [], identity }
    : { ...validation, identity: null };
}

export function normalizeActivationIdentity(value, path = 'activation_identity') {
  if (typeof value === 'string') {
    return parseActivationIdentity(value, path);
  }
  const identity = buildActivationIdentity(value || {});
  const validation = validateActivationIdentity(identity, path);
  return validation.ok
    ? { ok: true, errors: [], identity }
    : { ...validation, identity: null };
}

export function activationIdentitiesEqual(left, right) {
  const a = normalizeActivationIdentity(left);
  const b = normalizeActivationIdentity(right);
  if (!a.ok || !b.ok) return false;
  return formatActivationIdentity(a.identity) === formatActivationIdentity(b.identity);
}

export function activationIdentitySurvivesJournalGeneration(identity, _fromGeneration, _toGeneration) {
  const normalized = normalizeActivationIdentity(identity);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    errors: [],
    identity: normalized.identity,
    identity_key: formatActivationIdentity(normalized.identity),
    generation_is_not_identity: true,
  };
}

export function evaluateJournalGenerationChange({
  from_generation = null,
  to_generation = null,
} = {}) {
  const changed = String(from_generation ?? '') !== String(to_generation ?? '');
  return Object.freeze({
    changed,
    creates_work: false,
    preserves_identities: true,
    code: changed ? 'generation_change_is_not_activation' : 'same_generation',
  });
}

export function validateReplayEpochIntent(intent, path = 'replay_epoch') {
  const base = requirePlainObject(intent, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(intent.schema_version, `${path}.schema_version`),
    requireString(intent.id, `${path}.id`),
    requireOneOf(intent.kind, `${path}.kind`, REPLAY_EPOCH_KINDS),
    requireString(intent.from_activation_policy_version, `${path}.from_activation_policy_version`),
    requireString(intent.to_activation_policy_version, `${path}.to_activation_policy_version`),
    requireString(intent.created_at, `${path}.created_at`),
    requireString(intent.reason, `${path}.reason`),
    requireBoolean(intent.authorized, `${path}.authorized`),
  ]);
  if (!required.ok) return required;

  if (intent.schema_version !== REACTOR_CONTROL_PLANE_CONTRACT_VERSION) {
    return fail(`${path}.schema_version must be ${REACTOR_CONTROL_PLANE_CONTRACT_VERSION}`);
  }
  if (!String(intent.id).startsWith(REPLAY_EPOCH_ID_PREFIX)) {
    return fail(`${path}.id should use the ${REPLAY_EPOCH_ID_PREFIX} prefix`);
  }
  if (!isActivationPolicyVersion(intent.from_activation_policy_version)) {
    return fail(`${path}.from_activation_policy_version must match ${POLICY_VERSION_PATTERN}`);
  }
  if (!isActivationPolicyVersion(intent.to_activation_policy_version)) {
    return fail(`${path}.to_activation_policy_version must match ${POLICY_VERSION_PATTERN}`);
  }
  if (intent.from_activation_policy_version === intent.to_activation_policy_version) {
    return fail(`${path} must change activation_policy_version`);
  }
  if (intent.preview != null && typeof intent.preview !== 'boolean') {
    return fail(`${path}.preview must be a boolean when present`);
  }
  if (intent.scope != null) {
    const scope = requirePlainObject(intent.scope, `${path}.scope`);
    if (!scope.ok) return scope;
    for (const field of ['reactors', 'evidence_kinds', 'evidence_keys']) {
      if (intent.scope[field] == null) continue;
      if (!Array.isArray(intent.scope[field])
        || !intent.scope[field].every((item) => typeof item === 'string' && item.trim())) {
        return fail(`${path}.scope.${field} must be an array of non-empty strings`);
      }
    }
    if (Array.isArray(intent.scope.reactors)
      && intent.scope.reactors.some((reactor) => !isActivationReactor(reactor))) {
      return fail(`${path}.scope.reactors must be activation reactors`);
    }
  }
  return ok();
}

/**
 * Policy-version change never silently backfills history.
 * Callers must pass an authorized, non-preview policy_backfill epoch.
 */
export function evaluateActivationPolicyChange({
  from_activation_policy_version,
  to_activation_policy_version,
  replay_epoch = null,
} = {}) {
  const from = String(from_activation_policy_version || '').trim();
  const to = String(to_activation_policy_version || '').trim();
  if (!from || !to) {
    return Object.freeze({
      allowed: false,
      action: 'reject',
      code: 'policy_version_required',
    });
  }
  if (from === to) {
    return Object.freeze({
      allowed: true,
      action: 'reuse_identity',
      code: 'same_policy_version',
    });
  }
  if (replay_epoch == null) {
    return Object.freeze({
      allowed: false,
      action: 'require_replay_epoch',
      code: 'replay_epoch_required',
    });
  }
  const validation = validateReplayEpochIntent(replay_epoch);
  if (!validation.ok) {
    return Object.freeze({
      allowed: false,
      action: 'require_replay_epoch',
      code: 'replay_epoch_invalid',
      errors: validation.errors,
    });
  }
  if (replay_epoch.authorized !== true) {
    return Object.freeze({
      allowed: false,
      action: 'require_replay_epoch',
      code: 'replay_epoch_not_authorized',
    });
  }
  if (replay_epoch.preview === true) {
    return Object.freeze({
      allowed: false,
      action: 'preview_only',
      code: 'replay_epoch_preview',
    });
  }
  if (
    replay_epoch.from_activation_policy_version !== from
    || replay_epoch.to_activation_policy_version !== to
  ) {
    return Object.freeze({
      allowed: false,
      action: 'require_replay_epoch',
      code: 'replay_epoch_version_mismatch',
    });
  }
  return Object.freeze({
    allowed: true,
    action: 'activate_backfill',
    code: 'replay_epoch_authorized',
  });
}

export function replayEpochCoversIdentity(epoch, identity) {
  const decision = evaluateActivationPolicyChange({
    from_activation_policy_version: epoch?.from_activation_policy_version,
    to_activation_policy_version: identity?.activation_policy_version,
    replay_epoch: epoch,
  });
  if (!decision.allowed) return false;
  if (epoch.to_activation_policy_version !== identity.activation_policy_version) return false;
  const scope = isPlainObject(epoch.scope) ? epoch.scope : null;
  if (!scope) return true;
  if (Array.isArray(scope.reactors) && scope.reactors.length > 0
    && !scope.reactors.includes(identity.reactor)) {
    return false;
  }
  if (Array.isArray(scope.evidence_keys) && scope.evidence_keys.length > 0
    && !scope.evidence_keys.includes(identity.evidence_key)) {
    return false;
  }
  if (Array.isArray(scope.evidence_kinds) && scope.evidence_kinds.length > 0) {
    const { kind } = parseEvidenceKey(identity.evidence_key);
    if (!scope.evidence_kinds.includes(kind)) return false;
  }
  return true;
}

export const CONTROL_PLANE_NON_AUTHORITY_KINDS = Object.freeze([
  'evidence',
  'beliefs',
  'goals',
  'receipts',
  'settlements',
]);

export const REACTOR_CONTROL_PLANE_ROLE = Object.freeze({
  derived: true,
  rebuildable: true,
  authoritative_for: Object.freeze([]),
});

export function isReactorControlPlaneAuthoritative(_kind) {
  return false;
}
