import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireFiniteNumber,
  requireOneOf,
  requireOptionalNonNegativeInteger,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import {
  EVIDENCE_BATCH_REACTORS,
} from './evidence-batch-claim.mjs';
import {
  BATCH_CHECKPOINT_STAGES,
} from './batch-checkpoint.mjs';
import {
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  activationIdentitiesEqual,
  evaluateActivationPolicyChange,
  evaluateJournalGenerationChange,
  formatActivationIdentity,
  isActivationReactor,
  normalizeActivationIdentity,
  validateActivationIdentity,
} from './activation-identity.mjs';
import {
  rejectControlPlanePayloads,
} from './reactor-control-plane-payloads.mjs';

export const ACTIVATION_LANES = Object.freeze([
  'realtime',
  'replay',
]);

export const ACTIVATION_LEDGER_STATES = Object.freeze([
  'ready',
  'claimed',
  'deferred',
  'blocked',
  'handled',
]);

export const ACTIVATION_LEDGER_TRANSITION_KINDS = Object.freeze([
  'claim',
  'release',
  'reclaim_lease_expired',
  'defer',
  'undefer',
  'block',
  'unblock',
  'handle',
]);

/**
 * Legal (from → to) pairs and the transition kinds that may produce them.
 * handled is terminal for that activation identity.
 */
export const ACTIVATION_LEDGER_TRANSITIONS = Object.freeze({
  ready: Object.freeze({
    claimed: Object.freeze(['claim']),
    deferred: Object.freeze(['defer']),
    blocked: Object.freeze(['block']),
    handled: Object.freeze(['handle']),
  }),
  claimed: Object.freeze({
    ready: Object.freeze(['release', 'reclaim_lease_expired']),
    deferred: Object.freeze(['defer']),
    blocked: Object.freeze(['block']),
    handled: Object.freeze(['handle']),
  }),
  deferred: Object.freeze({
    ready: Object.freeze(['undefer']),
    blocked: Object.freeze(['block']),
    handled: Object.freeze(['handle']),
  }),
  blocked: Object.freeze({
    ready: Object.freeze(['unblock']),
    handled: Object.freeze(['handle']),
  }),
  handled: Object.freeze({}),
});

export const ACTIVATION_PRIORITY = Object.freeze({
  HIGH: 80,
  NORMAL: 50,
  LOW: 20,
});

export const ACTIVATION_REASONS = Object.freeze([
  'explicit_target',
  'operator_brief',
  'operator_fact',
  'expected_output_contradiction',
  'decision_relevant_receipt',
  'rule_receipt',
  'semantic_operator_channel',
  'committed_settlement',
  'legacy_fallback',
  'legacy_unknown',
  'replay_epoch',
  'policy_backfill',
]);

export const ACTIVATION_ORIGINS = Object.freeze([
  'explicit',
  'legacy_fallback',
  'replay_epoch',
  'legacy_unknown',
]);

export const ACTIVATION_HOLD_CLASSES = Object.freeze([
  'budget',
  'mechanical',
  'policy',
  'fairness',
  'unknown',
  'legacy_unknown',
]);

export const DEFERRED_HOLD_CLASSES = Object.freeze([
  'budget',
  'policy',
  'fairness',
  'unknown',
  'legacy_unknown',
]);

export const BLOCKED_HOLD_CLASSES = Object.freeze([
  'mechanical',
  'policy',
  'unknown',
  'legacy_unknown',
]);

export const ACTIVATION_REAPPEARANCE_KINDS = Object.freeze([
  'reclaim_lease_expired',
  'policy_backfill',
  'generation_rebuild_no_work',
  'same_identity_no_new_work',
]);

export const GROUPING_IDENTITY_FIELDS = Object.freeze([
  'producer_batch_id',
  'reaction_id',
  'decision_id',
  'execution_id',
  'belief_id',
  'settlement_id',
  'group_id',
  'topic',
]);

export function isKnownActivationReason(reason) {
  return ACTIVATION_REASONS.includes(reason);
}

export function validateActivationReason(reason, path = 'activation_reason') {
  const required = requireString(reason, path);
  if (!required.ok) return required;
  return ok();
}

export function listLegalActivationLedgerTransitions() {
  const rows = [];
  for (const from of ACTIVATION_LEDGER_STATES) {
    const targets = ACTIVATION_LEDGER_TRANSITIONS[from] || {};
    for (const [to, kinds] of Object.entries(targets)) {
      for (const kind of kinds) {
        rows.push(Object.freeze({ from, to, kind }));
      }
    }
  }
  return Object.freeze(rows);
}

export function isLegalActivationLedgerTransition(from, to, kind) {
  return (ACTIVATION_LEDGER_TRANSITIONS[from]?.[to] || []).includes(kind);
}

function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateActivationHoldReason(reason, path = 'hold_reason', { allowedClasses = ACTIVATION_HOLD_CLASSES } = {}) {
  const base = requirePlainObject(reason, path);
  if (!base.ok) return base;
  const required = mergeValidationResults([
    requireOneOf(reason.class, `${path}.class`, allowedClasses),
    requireString(reason.code, `${path}.code`),
    requireOptionalString(reason.detail, `${path}.detail`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;
  return rejectControlPlanePayloads(reason, path);
}

export function validateActivationClaimMetadata(claim, path = 'claim', { required = false } = {}) {
  if (claim == null) {
    return required ? fail(`${path} is required`) : ok();
  }
  const base = requirePlainObject(claim, path);
  if (!base.ok) return base;
  const requiredFields = mergeValidationResults([
    requireOptionalString(claim.claim_id, `${path}.claim_id`),
    requireOptionalString(claim.claimed_at, `${path}.claimed_at`),
    requireOptionalString(claim.lease_expires_at, `${path}.lease_expires_at`),
    requireOptionalString(claim.owner, `${path}.owner`, { allowEmpty: true }),
    requireOptionalNonNegativeInteger(claim.attempt, `${path}.attempt`),
    requireOptionalNonNegativeInteger(claim.reclaim_count, `${path}.reclaim_count`),
    requireOptionalString(claim.last_reclaim_kind, `${path}.last_reclaim_kind`),
  ]);
  if (!requiredFields.ok) return requiredFields;
  if (required) {
    const live = mergeValidationResults([
      requireString(claim.claimed_at, `${path}.claimed_at`),
      requireString(claim.lease_expires_at, `${path}.lease_expires_at`),
    ]);
    if (!live.ok) return live;
    if (parseTimeMs(claim.lease_expires_at) == null) {
      return fail(`${path}.lease_expires_at must be an ISO timestamp`);
    }
  }
  if (claim.last_reclaim_kind != null && claim.last_reclaim_kind !== 'reclaim_lease_expired') {
    return fail(`${path}.last_reclaim_kind must be reclaim_lease_expired when present`);
  }
  return rejectControlPlanePayloads(claim, path);
}

export function validateActivationProgressCheckpoint(progress, path = 'progress') {
  if (progress == null) return ok();
  const base = requirePlainObject(progress, path);
  if (!base.ok) return base;
  const fields = mergeValidationResults([
    requireOptionalString(progress.batch_id, `${path}.batch_id`),
    requireOptionalString(progress.stage, `${path}.stage`, { allowEmpty: true }),
    requireOptionalString(progress.updated_at, `${path}.updated_at`),
    requireOptionalString(progress.cursor, `${path}.cursor`, { allowEmpty: true }),
    requireOptionalNonNegativeInteger(progress.attempt, `${path}.attempt`),
  ]);
  if (!fields.ok) return fields;
  if (progress.stage && BATCH_CHECKPOINT_STAGES.includes(progress.stage) === false
    && String(progress.stage).trim() === '') {
    return fail(`${path}.stage must not be empty when present`);
  }
  return rejectControlPlanePayloads(progress, path);
}

export function validateGroupingIdentity(grouping, path = 'grouping') {
  if (grouping == null) return ok();
  const base = requirePlainObject(grouping, path);
  if (!base.ok) return base;
  const checks = GROUPING_IDENTITY_FIELDS.map((field) => (
    requireOptionalString(grouping[field], `${path}.${field}`, { allowEmpty: true })
  ));
  const result = mergeValidationResults(checks);
  if (!result.ok) return result;
  return rejectControlPlanePayloads(grouping, path);
}

export function groupingKey(grouping = {}) {
  return GROUPING_IDENTITY_FIELDS
    .map((field) => `${field}=${String(grouping?.[field] ?? '').trim()}`)
    .join(';');
}

export function validateActivationLedgerEntry(entry, path = 'activation_ledger_entry') {
  const base = requirePlainObject(entry, path);
  if (!base.ok) return base;
  const payload = rejectControlPlanePayloads(entry, path);
  if (!payload.ok) return payload;

  const required = mergeValidationResults([
    requireString(entry.schema_version, `${path}.schema_version`),
    requireString(entry.reactor, `${path}.reactor`),
    requireOneOf(entry.lane, `${path}.lane`, ACTIVATION_LANES),
    requireOneOf(entry.state, `${path}.state`, ACTIVATION_LEDGER_STATES),
    validateActivationReason(entry.activation_reason, `${path}.activation_reason`),
    requireFiniteNumber(entry.priority, `${path}.priority`),
    requireString(entry.created_at, `${path}.created_at`),
    requireString(entry.updated_at, `${path}.updated_at`),
    requireOneOf(entry.origin, `${path}.origin`, ACTIVATION_ORIGINS),
    requireOptionalString(entry.subject, `${path}.subject`, { allowEmpty: true }),
    requireOptionalString(entry.replay_epoch_id, `${path}.replay_epoch_id`),
    validateGroupingIdentity(entry.grouping, `${path}.grouping`),
    validateActivationProgressCheckpoint(entry.progress, `${path}.progress`),
  ]);
  if (!required.ok) return required;

  if (entry.schema_version !== REACTOR_CONTROL_PLANE_CONTRACT_VERSION) {
    return fail(`${path}.schema_version must be ${REACTOR_CONTROL_PLANE_CONTRACT_VERSION}`);
  }
  if (!isActivationReactor(entry.reactor)) {
    return fail(`${path}.reactor must be one of: ${EVIDENCE_BATCH_REACTORS.join(', ')}`);
  }

  const identity = normalizeActivationIdentity(entry.identity, `${path}.identity`);
  if (!identity.ok) return identity;
  if (identity.identity.reactor !== entry.reactor) {
    return fail(`${path}.identity.reactor must match ${path}.reactor`);
  }
  if (entry.identity_key != null && entry.identity_key !== formatActivationIdentity(identity.identity)) {
    return fail(`${path}.identity_key must equal the canonical activation identity`);
  }

  const claimed = entry.state === 'claimed';
  const claim = validateActivationClaimMetadata(entry.claim, `${path}.claim`, { required: claimed });
  if (!claim.ok) return claim;

  if (entry.state === 'deferred') {
    if (entry.hold_reason == null) return fail(`${path}.hold_reason is required when state is deferred`);
    const hold = validateActivationHoldReason(entry.hold_reason, `${path}.hold_reason`, {
      allowedClasses: DEFERRED_HOLD_CLASSES,
    });
    if (!hold.ok) return hold;
  } else if (entry.state === 'blocked') {
    if (entry.hold_reason == null) return fail(`${path}.hold_reason is required when state is blocked`);
    const hold = validateActivationHoldReason(entry.hold_reason, `${path}.hold_reason`, {
      allowedClasses: BLOCKED_HOLD_CLASSES,
    });
    if (!hold.ok) return hold;
  } else if (entry.hold_reason != null) {
    return fail(`${path}.hold_reason must be absent unless state is deferred or blocked`);
  }

  if (entry.origin === 'replay_epoch' && !String(entry.replay_epoch_id || '').trim()) {
    return fail(`${path}.replay_epoch_id is required when origin is replay_epoch`);
  }
  return ok();
}

export function normalizeActivationLedgerEntry(input = {}) {
  const identityResult = normalizeActivationIdentity(input.identity ?? {
    reactor: input.reactor,
    evidence_key: input.evidence_key,
    activation_policy_version: input.activation_policy_version,
  });
  const identity = identityResult.identity;
  return {
    ...input,
    schema_version: input.schema_version ?? REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    reactor: input.reactor ?? identity?.reactor,
    identity: identity ?? input.identity,
    identity_key: identity ? formatActivationIdentity(identity) : input.identity_key,
    lane: input.lane,
    state: input.state ?? 'ready',
    activation_reason: input.activation_reason,
    priority: input.priority ?? ACTIVATION_PRIORITY.NORMAL,
    grouping: input.grouping ?? {},
    created_at: input.created_at,
    updated_at: input.updated_at ?? input.created_at,
    claim: input.claim ?? null,
    progress: input.progress ?? null,
    hold_reason: input.hold_reason ?? null,
    origin: input.origin,
    subject: input.subject ?? null,
    replay_epoch_id: input.replay_epoch_id ?? null,
  };
}

export function validateActivationLedgerTransition(command, path = 'activation_ledger_transition') {
  const from = command?.from;
  const to = command?.to;
  const kind = command?.kind;
  if (!ACTIVATION_LEDGER_STATES.includes(from)) {
    return fail(`${path}.from is not a known state: ${from}`);
  }
  if (!ACTIVATION_LEDGER_STATES.includes(to)) {
    return fail(`${path}.to is not a known state: ${to}`);
  }
  if (!ACTIVATION_LEDGER_TRANSITION_KINDS.includes(kind)) {
    return fail(`${path}.kind is not a known transition: ${kind}`);
  }
  if (from === to) {
    return fail(`${path} is illegal: ${from} -> ${to} (${kind})`);
  }
  if (!isLegalActivationLedgerTransition(from, to, kind)) {
    return fail(`${path} is illegal: ${from} -> ${to} (${kind})`);
  }

  const entry = command.entry;
  if (kind === 'reclaim_lease_expired') {
    if (!isPlainObject(entry)) {
      return fail(`${path}.entry is required to reclaim after lease expiry`);
    }
    const leaseMs = parseTimeMs(entry.claim?.lease_expires_at);
    const nowMs = parseTimeMs(command.now);
    if (leaseMs == null || nowMs == null) {
      return fail(`${path} reclaim requires entry.claim.lease_expires_at and now`);
    }
    if (nowMs <= leaseMs) {
      return fail(`${path} reclaim requires an expired lease`);
    }
    if (command.next_identity != null && !activationIdentitiesEqual(entry.identity, command.next_identity)) {
      return fail(`${path} reclaim must keep the same activation identity`);
    }
  }

  if (kind === 'claim' && command.claim != null) {
    const liveClaim = validateActivationClaimMetadata(command.claim, `${path}.claim`, { required: true });
    if (!liveClaim.ok) return liveClaim;
  }
  return ok();
}

export function applyActivationLedgerTransition(entry, command = {}, { now = null } = {}) {
  const current = validateActivationLedgerEntry(entry);
  if (!current.ok) return current;

  const transition = validateActivationLedgerTransition({
    from: entry.state,
    to: command.to,
    kind: command.kind,
    entry,
    now: command.now ?? now,
    next_identity: command.next_identity,
    claim: command.claim,
  });
  if (!transition.ok) return transition;

  const next = {
    ...entry,
    state: command.to,
    updated_at: command.updated_at ?? (typeof (command.now ?? now) === 'string' ? (command.now ?? now) : entry.updated_at),
    claim: command.claim !== undefined ? command.claim : entry.claim,
    progress: command.progress !== undefined ? command.progress : entry.progress,
    hold_reason: ['deferred', 'blocked'].includes(command.to)
      ? (command.hold_reason !== undefined ? command.hold_reason : entry.hold_reason)
      : null,
  };
  if (command.kind === 'reclaim_lease_expired') {
    next.claim = {
      ...(isPlainObject(entry.claim) ? entry.claim : {}),
      ...(isPlainObject(command.claim) ? command.claim : {}),
      last_reclaim_kind: 'reclaim_lease_expired',
      reclaim_count: Number(entry.claim?.reclaim_count || 0) + 1,
    };
  }

  const validated = validateActivationLedgerEntry(next);
  if (!validated.ok) return validated;
  return { ok: true, errors: [], entry: next, kind: command.kind };
}

/**
 * Distinguishes lease reclaim (same identity, not new work) from policy
 * backfill (new identity, requires an explicit replay epoch) and from
 * journal generation rebuild (must not create work).
 */
export function classifyActivationReappearance({
  previous_identity = null,
  next_identity = null,
  transition_kind = null,
  lease_expired = false,
  journal_generation_changed = false,
  from_generation = null,
  to_generation = null,
  replay_epoch = null,
} = {}) {
  const sameIdentity = previous_identity != null && next_identity != null
    && activationIdentitiesEqual(previous_identity, next_identity);
  const previousVersion = previous_identity?.activation_policy_version
    ?? (typeof previous_identity === 'string'
      ? normalizeActivationIdentity(previous_identity).identity?.activation_policy_version
      : null);
  const nextVersion = next_identity?.activation_policy_version
    ?? (typeof next_identity === 'string'
      ? normalizeActivationIdentity(next_identity).identity?.activation_policy_version
      : null);
  const policyChanged = Boolean(previousVersion && nextVersion && previousVersion !== nextVersion);
  const generation = evaluateJournalGenerationChange({
    from_generation,
    to_generation: to_generation ?? (journal_generation_changed ? `${from_generation || 'from'}:next` : from_generation),
  });

  if (transition_kind === 'reclaim_lease_expired' || (sameIdentity && lease_expired && !policyChanged)) {
    return Object.freeze({
      kind: 'reclaim_lease_expired',
      same_identity: true,
      creates_work: false,
      requires_replay_epoch: false,
      distinguishable_from_replay: true,
    });
  }

  if (policyChanged) {
    const policy = evaluateActivationPolicyChange({
      from_activation_policy_version: previousVersion,
      to_activation_policy_version: nextVersion,
      replay_epoch,
    });
    return Object.freeze({
      kind: 'policy_backfill',
      same_identity: false,
      creates_work: policy.allowed,
      requires_replay_epoch: true,
      distinguishable_from_reclaim: true,
      policy,
    });
  }

  if (generation.changed || journal_generation_changed) {
    return Object.freeze({
      kind: 'generation_rebuild_no_work',
      same_identity: sameIdentity || previous_identity == null || next_identity == null,
      creates_work: false,
      requires_replay_epoch: false,
      distinguishable_from_reclaim: true,
      generation,
    });
  }

  return Object.freeze({
    kind: 'same_identity_no_new_work',
    same_identity: sameIdentity,
    creates_work: false,
    requires_replay_epoch: false,
  });
}

export function validateActivationIdentityUnchanged(previous, next, path = 'activation_identity') {
  const left = validateActivationIdentity(
    typeof previous === 'string' ? parseOrNull(previous) : previous,
    `${path}.previous`,
  );
  if (!left.ok && typeof previous !== 'string') return left;
  if (!activationIdentitiesEqual(previous, next)) {
    return fail(`${path} must not change across lease reclaim or journal generation`);
  }
  return ok();
}

function parseOrNull(value) {
  const parsed = normalizeActivationIdentity(value);
  return parsed.identity;
}
