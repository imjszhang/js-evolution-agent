import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireBoolean,
  requireNonNegativeInteger,
  requireOneOf,
  requireOptionalNonNegativeInteger,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { EVIDENCE_BATCH_REACTORS } from './evidence-batch-claim.mjs';
import { ACTIVATION_LANES } from './activation-ledger.mjs';
import {
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
} from './activation-identity.mjs';
import { rejectControlPlanePayloads } from './reactor-control-plane-payloads.mjs';

export const REACTOR_PROGRESS_FRESHNESS_STATUSES = Object.freeze([
  'fresh',
  'stale',
  'reconciling',
  'degraded',
  'unknown',
]);

export const REACTOR_COUNT_ROLES = Object.freeze({
  WORK: 'work',
  AUTHORITY: 'authority',
  LIVENESS: 'liveness',
});

export const REACTOR_OVERLAP_NOTE = 'reactor_counts_may_overlap_authoritative_evidence';

const FORBIDDEN_COMBINED_TOTAL_KEYS = Object.freeze([
  'work_total',
  'total_work',
  'combined_open',
  'combined_ready',
  'additive_total',
  'evidence_work_count',
]);

export function laneOpenCount(slice = {}) {
  return [slice.ready, slice.claimed, slice.deferred, slice.blocked]
    .map((value) => (Number.isInteger(value) ? value : 0))
    .reduce((sum, value) => sum + value, 0);
}

export function reconcileLaneCounts(slice = {}, path = 'lane') {
  const fields = mergeValidationResults([
    requireNonNegativeInteger(slice.ready, `${path}.ready`),
    requireNonNegativeInteger(slice.claimed, `${path}.claimed`),
    requireNonNegativeInteger(slice.deferred, `${path}.deferred`),
    requireNonNegativeInteger(slice.blocked, `${path}.blocked`),
    requireNonNegativeInteger(slice.handled_total, `${path}.handled_total`),
    requireOptionalNonNegativeInteger(slice.open_total, `${path}.open_total`),
  ]);
  if (!fields.ok) return { ...fields, open_total: null };

  const openTotal = laneOpenCount(slice);
  if (slice.open_total != null && slice.open_total !== openTotal) {
    return {
      ok: false,
      errors: [`${path}.open_total must equal ready + claimed + deferred + blocked`],
      open_total: openTotal,
    };
  }
  return {
    ok: true,
    errors: [],
    open_total: openTotal,
    handled_total: slice.handled_total,
    authority_is_not_work: true,
  };
}

export function classifyCountRole(name) {
  const key = String(name || '');
  if (key === 'envelope_count' || key === 'evidence_authority_count' || key.startsWith('authority_')) {
    return REACTOR_COUNT_ROLES.AUTHORITY;
  }
  if (key === 'worker_alive' || key === 'heartbeat' || key.endsWith('_liveness')) {
    return REACTOR_COUNT_ROLES.LIVENESS;
  }
  return REACTOR_COUNT_ROLES.WORK;
}

export function validateLaneCountSlice(slice, path = 'lane') {
  const base = requirePlainObject(slice, path);
  if (!base.ok) return base;
  const payload = rejectControlPlanePayloads(slice, path);
  if (!payload.ok) return payload;
  const reconciled = reconcileLaneCounts(slice, path);
  if (!reconciled.ok) return reconciled;
  if (slice.handled_checkpoint != null && typeof slice.handled_checkpoint !== 'string'
    && !isPlainObject(slice.handled_checkpoint)) {
    return fail(`${path}.handled_checkpoint must be a string or object when present`);
  }
  if (isPlainObject(slice.handled_checkpoint)) {
    const checkpoint = mergeValidationResults([
      requireOptionalString(slice.handled_checkpoint.id, `${path}.handled_checkpoint.id`),
      requireOptionalString(slice.handled_checkpoint.at, `${path}.handled_checkpoint.at`),
    ]);
    if (!checkpoint.ok) return checkpoint;
  }
  if (slice.evidence_authority_count != null) {
    return fail(`${path} must not treat evidence authority count as a work count`);
  }
  return ok();
}

export function validateReactorLaneCounts(counts, path = 'reactor_counts') {
  const base = requirePlainObject(counts, path);
  if (!base.ok) return base;
  return mergeValidationResults(
    ACTIVATION_LANES.map((lane) => validateLaneCountSlice(counts[lane], `${path}.${lane}`)),
  );
}

export function validateReactorProgressProjection(projection, path = 'reactor_progress_projection') {
  const base = requirePlainObject(projection, path);
  if (!base.ok) return base;
  const payload = rejectControlPlanePayloads(projection, path);
  if (!payload.ok) return payload;

  for (const key of FORBIDDEN_COMBINED_TOTAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(projection, key)) {
      return fail(`${path}.${key} is forbidden; reactor counts are not additive`);
    }
  }

  const required = mergeValidationResults([
    requireString(projection.schema_version, `${path}.schema_version`),
    requireOptionalString(projection.subject, `${path}.subject`, { allowEmpty: true }),
    requireString(projection.projected_at, `${path}.projected_at`),
    requirePlainObject(projection.freshness, `${path}.freshness`),
    requirePlainObject(projection.worker_liveness, `${path}.worker_liveness`),
    requirePlainObject(projection.reactors, `${path}.reactors`),
    requirePlainObject(projection.reactor_overlap, `${path}.reactor_overlap`),
  ]);
  if (!required.ok) return required;

  if (projection.schema_version !== REACTOR_CONTROL_PLANE_CONTRACT_VERSION) {
    return fail(`${path}.schema_version must be ${REACTOR_CONTROL_PLANE_CONTRACT_VERSION}`);
  }
  if (projection.projection_generation == null
    || (typeof projection.projection_generation !== 'string' && !Number.isInteger(projection.projection_generation))) {
    return fail(`${path}.projection_generation must be a string or integer`);
  }
  if (typeof projection.projection_generation === 'number' && projection.projection_generation < 0) {
    return fail(`${path}.projection_generation must not be negative`);
  }

  const freshness = mergeValidationResults([
    requireString(projection.freshness.as_of, `${path}.freshness.as_of`),
    requireOneOf(projection.freshness.status, `${path}.freshness.status`, REACTOR_PROGRESS_FRESHNESS_STATUSES),
    requireOptionalNonNegativeInteger(projection.freshness.stale_after_ms, `${path}.freshness.stale_after_ms`),
  ]);
  if (!freshness.ok) return freshness;

  const liveness = mergeValidationResults([
    requireBoolean(projection.worker_liveness.alive, `${path}.worker_liveness.alive`),
    requireOptionalString(projection.worker_liveness.heartbeat_at, `${path}.worker_liveness.heartbeat_at`),
  ]);
  if (!liveness.ok) return liveness;

  if (projection.activity != null) {
    const activity = requirePlainObject(projection.activity, `${path}.activity`);
    if (!activity.ok) return activity;
    const activityFields = mergeValidationResults([
      requireOptionalString(projection.activity.current_stage, `${path}.activity.current_stage`, { allowEmpty: true }),
      requireOptionalString(projection.activity.last_progress_at, `${path}.activity.last_progress_at`),
    ]);
    if (!activityFields.ok) return activityFields;
    if (projection.activity.current_task != null) {
      const task = requirePlainObject(projection.activity.current_task, `${path}.activity.current_task`);
      if (!task.ok) return task;
      const taskFields = mergeValidationResults([
        requireString(projection.activity.current_task.id, `${path}.activity.current_task.id`),
        requireOptionalString(projection.activity.current_task.type, `${path}.activity.current_task.type`),
        projection.activity.current_task.lane == null
          ? ok()
          : requireOneOf(projection.activity.current_task.lane, `${path}.activity.current_task.lane`, ACTIVATION_LANES),
      ]);
      if (!taskFields.ok) return taskFields;
    }
    if (projection.activity.current_claim != null) {
      const claim = requirePlainObject(projection.activity.current_claim, `${path}.activity.current_claim`);
      if (!claim.ok) return claim;
    }
    const activityPayload = rejectControlPlanePayloads(projection.activity, `${path}.activity`);
    if (!activityPayload.ok) return activityPayload;
  }

  if (projection.limits != null) {
    const limits = requirePlainObject(projection.limits, `${path}.limits`);
    if (!limits.ok) return limits;
    const limitFields = mergeValidationResults([
      requireOptionalNonNegativeInteger(projection.limits.replay_batch_limit, `${path}.limits.replay_batch_limit`),
      requireOptionalNonNegativeInteger(projection.limits.replay_wall_clock_ms, `${path}.limits.replay_wall_clock_ms`),
      requireOptionalNonNegativeInteger(projection.limits.token_reserve, `${path}.limits.token_reserve`),
      requireOptionalNonNegativeInteger(projection.limits.spend_allowance, `${path}.limits.spend_allowance`),
    ]);
    if (!limitFields.ok) return limitFields;
  }

  if (projection.stop_reason != null) {
    const stop = requirePlainObject(projection.stop_reason, `${path}.stop_reason`);
    if (!stop.ok) return stop;
    const stopFields = mergeValidationResults([
      requireString(projection.stop_reason.class, `${path}.stop_reason.class`),
      requireString(projection.stop_reason.code, `${path}.stop_reason.code`),
      requireOptionalString(projection.stop_reason.detail, `${path}.stop_reason.detail`, { allowEmpty: true }),
    ]);
    if (!stopFields.ok) return stopFields;
  }

  const reactorChecks = [];
  for (const [reactor, counts] of Object.entries(projection.reactors)) {
    if (!EVIDENCE_BATCH_REACTORS.includes(reactor)) {
      return fail(`${path}.reactors.${reactor} is not a known activation reactor`);
    }
    reactorChecks.push(validateReactorLaneCounts(counts, `${path}.reactors.${reactor}`));
  }
  const reactors = mergeValidationResults(reactorChecks);
  if (!reactors.ok) return reactors;

  if (projection.reactor_overlap.additive !== false) {
    return fail(`${path}.reactor_overlap.additive must be false`);
  }
  if (projection.reactor_overlap.note != null
    && projection.reactor_overlap.note !== REACTOR_OVERLAP_NOTE) {
    return fail(`${path}.reactor_overlap.note must be ${REACTOR_OVERLAP_NOTE}`);
  }

  if (projection.evidence_authority != null) {
    const authority = requirePlainObject(projection.evidence_authority, `${path}.evidence_authority`);
    if (!authority.ok) return authority;
    const authorityFields = mergeValidationResults([
      requireOptionalNonNegativeInteger(
        projection.evidence_authority.envelope_count,
        `${path}.evidence_authority.envelope_count`,
      ),
    ]);
    if (!authorityFields.ok) return authorityFields;
    if (projection.evidence_authority.is_work_count !== false) {
      return fail(`${path}.evidence_authority.is_work_count must be false`);
    }
  }
  return ok();
}

export function validateCountInvariants(projection, path = 'reactor_progress_projection') {
  const validated = validateReactorProgressProjection(projection, path);
  if (!validated.ok) return validated;
  const errors = [];
  for (const [reactor, counts] of Object.entries(projection.reactors || {})) {
    for (const lane of ACTIVATION_LANES) {
      const reconciled = reconcileLaneCounts(counts[lane], `${path}.reactors.${reactor}.${lane}`);
      if (!reconciled.ok) errors.push(...reconciled.errors);
    }
  }
  return errors.length ? fail(errors) : ok();
}

export function reactorWorkCountsAreAdditive() {
  return false;
}
