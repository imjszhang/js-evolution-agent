import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACTIVATION_LANES,
  ACTIVATION_LEDGER_STATES,
  ACTIVATION_LEDGER_TRANSITION_KINDS,
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  LEGACY_UNKNOWN,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  REACTOR_CONTROL_PLANE_ROLE,
  REACTOR_OVERLAP_NOTE,
  REACTOR_SCHEDULER_STATES,
  activationIdentitiesEqual,
  activationIdentitySurvivesJournalGeneration,
  applyActivationLedgerTransition,
  buildActivationIdentity,
  classifyActivationReappearance,
  classifyCountRole,
  deriveReactorSchedulerState,
  evaluateActivationPolicyChange,
  evaluateJournalGenerationChange,
  exclusiveStopStates,
  formatActivationIdentity,
  interpretLegacyControlPlaneMetadata,
  isLegalActivationLedgerTransition,
  isReactorControlPlaneAuthoritative,
  laneOpenCount,
  listLegalActivationLedgerTransitions,
  mustNotFabricateActivationReason,
  mustNotFabricateHandledIdentity,
  normalizeActivationLedgerEntry,
  parseActivationIdentity,
  readCompatibleBatchCheckpoint,
  readCompatibleCursor,
  readCompatibleEvidenceBatchClaim,
  readCompatibleEvidenceEnvelope,
  readCompatibleSettlement,
  readCompatibleWakeIntent,
  reconcileLaneCounts,
  reactorWorkCountsAreAdditive,
  schedulerStopPredicates,
  validateActivationIdentity,
  validateActivationLedgerEntry,
  validateActivationLedgerTransition,
  validateCountInvariants,
  validateEvidenceEnvelope,
  validateReactorProgressProjection,
  validateReplayEpochIntent,
  validateVerifyReport,
} from '../src/contracts/index.mjs';

const AT = '2026-08-25T00:00:00.000Z';
const LATER = '2026-08-25T00:02:00.000Z';
const NOW_MS = Date.parse(LATER);

function identity(overrides = {}) {
  return buildActivationIdentity({
    reactor: 'cognitive',
    evidence_key: 'operator_briefs:brief-1',
    activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    ...overrides,
  });
}

function replayEpoch(overrides = {}) {
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    id: 'replay-epoch-policy-v2',
    kind: 'policy_backfill',
    from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    to_activation_policy_version: 'activation-policy.v2',
    created_at: AT,
    reason: 'eligibility rule change',
    authorized: true,
    preview: false,
    ...overrides,
  };
}

function ledgerEntry(overrides = {}) {
  const { identity_overrides, ...rest } = overrides;
  const built = identity(identity_overrides);
  return normalizeActivationLedgerEntry({
    reactor: built.reactor,
    identity: built,
    lane: 'realtime',
    state: 'ready',
    activation_reason: 'operator_brief',
    priority: ACTIVATION_PRIORITY.HIGH,
    created_at: AT,
    updated_at: AT,
    origin: 'explicit',
    grouping: { producer_batch_id: 'batch-origin' },
    ...rest,
  });
}

function liveClaim(overrides = {}) {
  return {
    claim_id: 'claim-1',
    claimed_at: AT,
    lease_expires_at: '2026-08-25T00:01:00.000Z',
    owner: 'worker-1',
    attempt: 1,
    ...overrides,
  };
}

function projection(overrides = {}) {
  const lane = {
    ready: 1,
    claimed: 1,
    deferred: 1,
    blocked: 1,
    handled_total: 9,
    open_total: 4,
  };
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    subject: 'demo',
    projection_generation: 3,
    projected_at: AT,
    freshness: { as_of: AT, status: 'fresh' },
    worker_liveness: { alive: true, heartbeat_at: AT },
    activity: {
      current_task: { id: 'task-1', type: 'cognitive_reaction', lane: 'realtime' },
      current_claim: { claim_id: 'claim-1', reactor: 'cognitive', lane: 'realtime' },
      current_stage: 'report',
      last_progress_at: AT,
    },
    limits: {
      replay_batch_limit: 8,
      replay_wall_clock_ms: 30_000,
      token_reserve: 4_000,
      spend_allowance: 1,
    },
    reactors: {
      cognitive: { realtime: { ...lane }, replay: { ...lane, ready: 2, open_total: 5 } },
      rule: { realtime: { ...lane, ready: 0, open_total: 3 }, replay: { ...lane, ready: 0, open_total: 3 } },
    },
    reactor_overlap: { additive: false, note: REACTOR_OVERLAP_NOTE },
    evidence_authority: { envelope_count: 1200, is_work_count: false },
    ...overrides,
  };
}

describe('activation identity', () => {
  it('is deterministic across recomputation and ignores journal generation', () => {
    const first = identity();
    const again = identity();
    expect(validateActivationIdentity(first).ok).toBe(true);
    expect(formatActivationIdentity(first)).toBe(formatActivationIdentity(again));
    expect(formatActivationIdentity(first)).toBe(
      `aiv1/cognitive/${INITIAL_ACTIVATION_POLICY_VERSION}/operator_briefs:brief-1`,
    );
    expect(parseActivationIdentity(formatActivationIdentity(first)).identity).toEqual(first);
    expect(activationIdentitiesEqual(first, formatActivationIdentity(again))).toBe(true);

    const survived = activationIdentitySurvivesJournalGeneration(first, 1, 99);
    expect(survived.ok).toBe(true);
    expect(survived.identity_key).toBe(formatActivationIdentity(first));
    expect(survived.generation_is_not_identity).toBe(true);
    expect(evaluateJournalGenerationChange({ from_generation: 1, to_generation: 99 })).toEqual({
      changed: true,
      creates_work: false,
      preserves_identities: true,
      code: 'generation_change_is_not_activation',
    });
  });

  it('rejects incomplete identity parts', () => {
    expect(validateActivationIdentity({
      reactor: 'cognitive',
      evidence_key: 'operator_briefs:brief-1',
    }).ok).toBe(false);
    expect(validateActivationIdentity({
      reactor: 'exec',
      evidence_key: 'operator_briefs:brief-1',
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    }).ok).toBe(false);
    expect(parseActivationIdentity('not-an-identity').ok).toBe(false);
  });

  it('requires an explicit replay epoch before a policy-version change can backfill', () => {
    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: 'activation-policy.v2',
    })).toMatchObject({ allowed: false, action: 'require_replay_epoch', code: 'replay_epoch_required' });

    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: 'activation-policy.v2',
      replay_epoch: replayEpoch({ authorized: false }),
    }).code).toBe('replay_epoch_not_authorized');

    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: 'activation-policy.v2',
      replay_epoch: replayEpoch({ preview: true }),
    }).code).toBe('replay_epoch_preview');

    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: 'activation-policy.v2',
      replay_epoch: replayEpoch({ to_activation_policy_version: 'activation-policy.v9' }),
    }).code).toBe('replay_epoch_version_mismatch');

    expect(validateReplayEpochIntent(replayEpoch()).ok).toBe(true);
    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: 'activation-policy.v2',
      replay_epoch: replayEpoch(),
    })).toMatchObject({ allowed: true, action: 'activate_backfill' });

    expect(evaluateActivationPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    })).toMatchObject({ allowed: true, action: 'reuse_identity' });
  });
});

describe('activation ledger transitions', () => {
  it('accepts a complete inbox record and rejects secret payloads', () => {
    expect(validateActivationLedgerEntry(ledgerEntry()).ok).toBe(true);
    expect(validateActivationLedgerEntry(ledgerEntry({
      payload: { text: 'operator secret' },
    })).ok).toBe(false);
    expect(validateActivationLedgerEntry(ledgerEntry({
      state: 'deferred',
    })).ok).toBe(false);
    expect(validateActivationLedgerEntry(ledgerEntry({
      state: 'blocked',
      hold_reason: { class: 'budget', code: 'tokens' },
    })).ok).toBe(false);
  });

  it('specifies and tests every legal and illegal state transition', () => {
    const legal = new Set(
      listLegalActivationLedgerTransitions().map((row) => `${row.from}->${row.to}:${row.kind}`),
    );
    expect(legal.size).toBe(14);

    for (const from of ACTIVATION_LEDGER_STATES) {
      for (const to of ACTIVATION_LEDGER_STATES) {
        for (const kind of ACTIVATION_LEDGER_TRANSITION_KINDS) {
          const result = validateActivationLedgerTransition({ from, to, kind });
          const allowed = isLegalActivationLedgerTransition(from, to, kind);
          if (allowed) {
            expect(legal.has(`${from}->${to}:${kind}`)).toBe(true);
            if (kind !== 'reclaim_lease_expired') {
              expect(result.ok).toBe(true);
            }
          } else {
            expect(result.ok).toBe(false);
          }
        }
      }
    }
  });

  it('applies legal transitions and refuses deferred/blocked short-circuits to claimed', () => {
    const claimed = applyActivationLedgerTransition(ledgerEntry(), {
      to: 'claimed',
      kind: 'claim',
      updated_at: LATER,
      claim: liveClaim(),
    });
    expect(claimed.ok).toBe(true);
    expect(claimed.entry.state).toBe('claimed');

    const deferred = applyActivationLedgerTransition(ledgerEntry(), {
      to: 'deferred',
      kind: 'defer',
      hold_reason: { class: 'budget', code: 'token_reserve' },
      updated_at: LATER,
    });
    expect(deferred.ok).toBe(true);
    expect(applyActivationLedgerTransition(deferred.entry, {
      to: 'claimed',
      kind: 'claim',
      claim: liveClaim(),
    }).ok).toBe(false);

    const blocked = applyActivationLedgerTransition(ledgerEntry(), {
      to: 'blocked',
      kind: 'block',
      hold_reason: { class: 'mechanical', code: 'repo_link_unavailable' },
      updated_at: LATER,
    });
    expect(blocked.ok).toBe(true);
    expect(applyActivationLedgerTransition(blocked.entry, {
      to: 'claimed',
      kind: 'claim',
      claim: liveClaim(),
    }).ok).toBe(false);

    const handled = applyActivationLedgerTransition(claimed.entry, {
      to: 'handled',
      kind: 'handle',
      updated_at: LATER,
    });
    expect(handled.ok).toBe(true);
    expect(applyActivationLedgerTransition(handled.entry, {
      to: 'ready',
      kind: 'release',
    }).ok).toBe(false);
  });

  it('distinguishes lease reclaim from policy/generation replay', () => {
    const claimed = ledgerEntry({
      state: 'claimed',
      claim: liveClaim(),
    });
    const reclaim = applyActivationLedgerTransition(claimed, {
      to: 'ready',
      kind: 'reclaim_lease_expired',
      now: LATER,
      updated_at: LATER,
    });
    expect(reclaim.ok).toBe(true);
    expect(reclaim.kind).toBe('reclaim_lease_expired');
    expect(reclaim.entry.claim.last_reclaim_kind).toBe('reclaim_lease_expired');
    expect(reclaim.entry.claim.reclaim_count).toBe(1);
    expect(activationIdentitiesEqual(claimed.identity, reclaim.entry.identity)).toBe(true);

    expect(applyActivationLedgerTransition(claimed, {
      to: 'ready',
      kind: 'reclaim_lease_expired',
      now: '2026-08-25T00:00:30.000Z',
    }).ok).toBe(false);

    expect(validateActivationLedgerTransition({
      from: 'claimed',
      to: 'ready',
      kind: 'policy_backfill',
    }).ok).toBe(false);

    const same = identity();
    const nextPolicy = identity({ activation_policy_version: 'activation-policy.v2' });
    expect(classifyActivationReappearance({
      previous_identity: same,
      next_identity: same,
      transition_kind: 'reclaim_lease_expired',
      lease_expired: true,
    })).toMatchObject({
      kind: 'reclaim_lease_expired',
      same_identity: true,
      creates_work: false,
      distinguishable_from_replay: true,
    });
    expect(classifyActivationReappearance({
      previous_identity: same,
      next_identity: nextPolicy,
      journal_generation_changed: false,
    })).toMatchObject({
      kind: 'policy_backfill',
      same_identity: false,
      creates_work: false,
      requires_replay_epoch: true,
    });
    expect(classifyActivationReappearance({
      previous_identity: same,
      next_identity: nextPolicy,
      replay_epoch: replayEpoch(),
    }).creates_work).toBe(true);
    expect(classifyActivationReappearance({
      previous_identity: same,
      next_identity: same,
      journal_generation_changed: true,
      from_generation: 4,
      to_generation: 5,
    })).toMatchObject({
      kind: 'generation_rebuild_no_work',
      creates_work: false,
    });
  });
});

describe('scheduler states', () => {
  it('never treats heartbeat as running or catching_up', () => {
    const heartbeatOnly = deriveReactorSchedulerState({
      worker_alive: true,
      heartbeat_at: LATER,
      now_ms: NOW_MS,
    });
    expect(heartbeatOnly.ok).toBe(true);
    expect(heartbeatOnly.state).toBe('listening');
    expect(REACTOR_SCHEDULER_STATES).toContain(heartbeatOnly.state);

    const heartbeatQueued = deriveReactorSchedulerState({
      worker_alive: true,
      heartbeat_at: LATER,
      now_ms: NOW_MS,
      ready_replay: 40,
    });
    expect(heartbeatQueued.state).toBe('queued');
    expect(heartbeatQueued.state).not.toBe('catching_up');
    expect(heartbeatQueued.state).not.toBe('running');
  });

  it('requires active replay work plus recent checkpoint progress for catching_up', () => {
    const catchingUp = deriveReactorSchedulerState({
      worker_alive: false,
      has_active_replay_claim: true,
      last_progress_at: '2026-08-25T00:01:30.000Z',
      now_ms: NOW_MS,
    });
    expect(catchingUp.state).toBe('catching_up');
    expect(catchingUp.predicates.catching_up_eligible).toBe(true);

    expect(deriveReactorSchedulerState({
      worker_alive: true,
      has_active_replay_task: true,
      last_progress_at: '2026-08-24T00:00:00.000Z',
      now_ms: NOW_MS,
    }).state).toBe('stalled');

    expect(deriveReactorSchedulerState({
      worker_alive: true,
      ready_replay: 12,
      last_progress_at: LATER,
      now_ms: NOW_MS,
    }).state).toBe('queued');
  });

  it('keeps paused_budget, blocked, and stalled mechanically exclusive', () => {
    const budget = schedulerStopPredicates({
      budget_exhausted: true,
      mechanical_blocker: { code: 'repo_link_unavailable' },
      has_active_replay_claim: true,
    });
    expect(budget).toMatchObject({ paused_budget: true, blocked: false, stalled: false });
    expect(exclusiveStopStates(budget).ok).toBe(true);

    const blocked = schedulerStopPredicates({
      mechanical_blocker: { code: 'repo_link_unavailable' },
      has_active_realtime_claim: true,
    });
    expect(blocked).toMatchObject({ paused_budget: false, blocked: true, stalled: false });

    const stalled = schedulerStopPredicates({
      has_active_realtime_task: true,
      last_progress_at: '2026-08-24T00:00:00.000Z',
      now_ms: NOW_MS,
    });
    expect(stalled).toMatchObject({ paused_budget: false, blocked: false, stalled: true });

    expect(deriveReactorSchedulerState({
      budget_exhausted: true,
      ready_realtime: 3,
      worker_alive: true,
    }).state).toBe('paused_budget');
    expect(deriveReactorSchedulerState({
      mechanical_blocker: { code: 'lane_lock' },
      ready_replay: 9,
    }).state).toBe('blocked');
    expect(deriveReactorSchedulerState({
      waiting_approval: true,
      budget_exhausted: true,
    }).state).toBe('waiting_approval');
    expect(deriveReactorSchedulerState({
      has_active_realtime_claim: true,
      last_progress_at: '2026-08-25T00:01:45.000Z',
      now_ms: NOW_MS,
    }).state).toBe('running');
  });
});

describe('progress and count invariants', () => {
  it('reconciles per-lane work counts without treating evidence authority as work', () => {
    const snap = projection();
    expect(validateReactorProgressProjection(snap).ok).toBe(true);
    expect(validateCountInvariants(snap).ok).toBe(true);
    expect(laneOpenCount(snap.reactors.cognitive.realtime)).toBe(4);
    expect(reconcileLaneCounts(snap.reactors.cognitive.replay).open_total).toBe(5);
    expect(reactorWorkCountsAreAdditive()).toBe(false);
    expect(classifyCountRole('envelope_count')).toBe('authority');
    expect(classifyCountRole('ready')).toBe('work');

    expect(validateReactorProgressProjection(projection({
      work_total: 12,
    })).ok).toBe(false);
    expect(validateReactorProgressProjection(projection({
      reactor_overlap: { additive: true },
    })).ok).toBe(false);
    expect(validateReactorProgressProjection(projection({
      evidence_authority: { envelope_count: 10, is_work_count: true },
    })).ok).toBe(false);
    expect(validateCountInvariants(projection({
      reactors: {
        cognitive: {
          realtime: { ready: 1, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 9 },
          replay: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 0 },
        },
      },
    })).ok).toBe(false);
  });

  it('forbids evidence bodies and secret payloads on bounded projections', () => {
    expect(validateReactorProgressProjection(projection({
      payload: { bodies: ['secret'] },
    })).ok).toBe(false);
    expect(validateReactorProgressProjection(projection({
      activity: {
        current_task: { id: 'task-1' },
        evidence_body: { text: 'nope' },
      },
    })).ok).toBe(false);
    expect(ACTIVATION_LANES).toEqual(['realtime', 'replay']);
  });
});

describe('0.2.x compatibility', () => {
  it('reads legacy records as legacy_unknown without inferring activation metadata', () => {
    const envelope = readCompatibleEvidenceEnvelope({
      id: 'receipt-legacy',
      kind: 'action_receipts',
      type: 'record_observation',
      occurred_at: AT,
      provenance: { store: 'action_receipts' },
    });
    expect(envelope.readable).toBe(true);
    expect(envelope.control_plane).toMatchObject({
      activation_reason: LEGACY_UNKNOWN,
      handled_identity: LEGACY_UNKNOWN,
      lane: LEGACY_UNKNOWN,
      activation_policy_version: LEGACY_UNKNOWN,
      fabricated: false,
      inferred: false,
    });
    expect(interpretLegacyControlPlaneMetadata({
      kind: 'operator_briefs',
      reactor: 'cognitive',
      evidence_key: 'operator_briefs:brief-1',
    }).handled_identity).toBe(LEGACY_UNKNOWN);
    expect(mustNotFabricateActivationReason()).toBe(LEGACY_UNKNOWN);
    expect(mustNotFabricateHandledIdentity()).toBe(LEGACY_UNKNOWN);

    expect(readCompatibleEvidenceBatchClaim({
      batch_id: 'batch-legacy',
      reactor: 'cognitive',
      claimed_at: AT,
      deadline_at: LATER,
      event_ids: ['evt-1'],
      status: 'claimed',
    }).control_plane.activation_reason).toBe(LEGACY_UNKNOWN);

    expect(readCompatibleWakeIntent({
      id: 'wake-legacy',
      kind: 'cognitive',
      subject: 'alpha',
      created_at: AT,
      updated_at: AT,
      status: 'pending',
      reason: 'operator_brief',
      merge_key: 'alpha:cognitive',
    }).readable).toBe(true);

    expect(readCompatibleBatchCheckpoint({
      batch_id: 'batch-legacy-cp',
      reactor: 'cognitive',
      written_at: AT,
      stage: 'claimed',
      event_ids: ['evt-1'],
    }).control_plane.handled_identity).toBe(LEGACY_UNKNOWN);

    expect(readCompatibleSettlement({ type: 'validated', belief_id: 'b1' }).readable).toBe(true);
    expect(readCompatibleCursor({
      schema_version: 'evidence-index-cursors.v1',
      reactors: { cognitive: { offset: 0 } },
    }).control_plane.lane).toBe(LEGACY_UNKNOWN);
  });

  it('does not invent 0.3.0 metadata from evidence kind and leaves 0.2.x authority contracts intact', () => {
    expect(validateEvidenceEnvelope({
      id: 'brief-1',
      kind: 'operator_briefs',
      type: 'operator_brief',
      occurred_at: AT,
      provenance: { store: 'operator_briefs' },
      activation_reason: 'operator_brief',
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    }).ok).toBe(true);
    expect(validateVerifyReport({
      cycle_id: 'cycle-legacy',
      summary: { matched: true },
    }).ok).toBe(true);
    expect(isReactorControlPlaneAuthoritative('evidence')).toBe(false);
    expect(isReactorControlPlaneAuthoritative('beliefs')).toBe(false);
    expect(isReactorControlPlaneAuthoritative('goals')).toBe(false);
    expect(isReactorControlPlaneAuthoritative('receipts')).toBe(false);
    expect(isReactorControlPlaneAuthoritative('settlements')).toBe(false);
    expect(REACTOR_CONTROL_PLANE_ROLE).toMatchObject({
      derived: true,
      rebuildable: true,
      authoritative_for: [],
    });

    const frozen = readFileSync(new URL('../policies/release/closure-target-0.2.0.json', import.meta.url), 'utf8');
    expect(frozen).toContain('"legacy_unknown_if"');
    expect(frozen).not.toContain('activation_ledger');
  });
});
