/**
 * Per-goal rule reactor (S6).
 * Peek due window → claim only when threshold/wall-clock is met.
 */
import { runtimeForSubject } from '../../infra/runtime-paths.mjs';
import { buildCycleContext } from '../cycle-steps.mjs';
import {
  settleEvidenceWindow,
  settlementWindowsFromEvents,
} from '../settlement-service.mjs';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  isReactorBusy,
  listEligibleEvidence,
  nackBatchFailed,
  reconcileExpiredClaims,
} from './claim-ledger.mjs';
import { consumeWakeIntent } from './wake-store.mjs';
import { getActivationLedgerEntry } from './activation-ledger-store.mjs';
import { patchBatchCheckpoint } from './batch-checkpoint-store.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';
import {
  cursorForGoal,
  eventsAfterCursor,
  goalBucketForEnvelope,
  readRuleCursors,
  writeRuleCursors,
} from './rule-cursors.mjs';
import {
  assertRuleJournalBudget,
  assertRuleWallBudget,
  clearRuleFailure,
  noteRuleFailure,
  planRuleBatch,
  quarantineRuleEvidence,
  resolveRuleLimits,
  ruleBatchFingerprint,
  RULE_BLOCK_REASONS,
} from './rule-resilience.mjs';

const DEFAULT_MIN_EVENTS = 8;
const DEFAULT_MAX_IDLE_MS = 48 * 60 * 60 * 1000;

function originIdentity(events = []) {
  const values = (field) => [...new Set(events
    .map((event) => event?.payload?.[field] ?? event?.[field] ?? null)
    .filter(Boolean))];
  const single = (field) => {
    const found = values(field);
    return found.length === 1 ? found[0] : null;
  };
  return {
    producer_batch_id: single('producer_batch_id'),
    reaction_id: single('reaction_id'),
    decision_id: single('decision_id'),
    execution_id: single('execution_id'),
    belief_id: single('belief_id'),
  };
}

export const RULE_EVIDENCE_KINDS = Object.freeze([
  'action_receipts',
  'verify_reports',
  'belief_events',
  'goal_events',
]);

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function shouldRunRuleReaction(events = [], {
  nowMs = Date.now(),
  minEvents = DEFAULT_MIN_EVENTS,
  maxIdleMs = DEFAULT_MAX_IDLE_MS,
} = {}) {
  if (!events.length) return { due: false, reason: 'no_events' };
  if (events.some((event) => (
    event?.kind === 'verify_reports'
    && (
      event?.payload?.comparison?.status === 'contradicted'
      || event?.payload?.settlement_signal?.reason === 'expected_output_contradicted'
    )
  ))) {
    return { due: true, reason: 'expected_output_contradicted' };
  }
  if (events.length >= minEvents) return { due: true, reason: 'evidence_count' };
  const oldest = events
    .map((item) => parseIsoMs(item.occurred_at))
    .filter((ms) => ms != null)
    .sort((a, b) => a - b)[0];
  if (oldest != null && nowMs - oldest >= maxIdleMs) {
    return { due: true, reason: 'wall_clock' };
  }
  return { due: false, reason: 'below_threshold' };
}

export function peekRuleDueWindow(dataRoot, {
  nowMs = Date.now(),
  minEvents = DEFAULT_MIN_EVENTS,
  maxIdleMs = DEFAULT_MAX_IDLE_MS,
  kinds = RULE_EVIDENCE_KINDS,
  stream = null,
  limits = resolveRuleLimits(),
} = {}) {
  try {
    assertRuleJournalBudget(dataRoot, limits);
  } catch (error) {
    return {
      eligible: [],
      due: [],
      cursors: readRuleCursors(dataRoot),
      blocked: true,
      block_reason: RULE_BLOCK_REASONS.journal,
      error,
    };
  }
  const eligible = listEligibleEvidence(dataRoot, {
    reactor: 'rule',
    kinds,
    now: nowMs,
    stream,
    limit: limits.maxEvents,
    maxHydratedBytes: limits.maxPayloadBytes,
  });
  const cursors = readRuleCursors(dataRoot);
  const byGoal = new Map();
  for (const envelope of eligible) {
    const goalId = goalBucketForEnvelope(envelope);
    if (!byGoal.has(goalId)) byGoal.set(goalId, []);
    byGoal.get(goalId).push(envelope);
  }
  const due = [];
  for (const [goalId, events] of byGoal) {
    const after = eventsAfterCursor(events, cursorForGoal(cursors, goalId));
    const gate = shouldRunRuleReaction(after, { nowMs, minEvents, maxIdleMs });
    if (gate.due) due.push({ goalId, events: after, reason: gate.reason });
  }
  const plan = planRuleBatch(dataRoot, due.flatMap((item) => item.events), limits);
  return {
    eligible,
    due,
    cursors,
    plan,
    blocked: plan.blocked,
    block_reason: plan.block_reason,
  };
}

function commitRuleEventCursors(dataRoot, events, batchId) {
  const claimedByGoal = new Map();
  for (const event of events) claimedByGoal.set(goalBucketForEnvelope(event), event);
  const goalCursors = Object.fromEntries(
    [...claimedByGoal.entries()]
      .filter(([goalId]) => goalId !== 'global')
      .map(([goalId, event]) => [goalId, {
        evidenceKey: envelopeEvidenceKey(event),
        eventId: event.id,
      }]),
  );
  const globalEvent = claimedByGoal.get('global') ?? null;
  writeRuleCursors(dataRoot, {
    globalCursor: globalEvent ? envelopeEvidenceKey(globalEvent) : null,
    batchId,
    goalIds: Object.keys(goalCursors),
    goalCursors,
  });
}

function withRuleWallDeadline(work, startedAt, limits) {
  const remaining = Math.max(0, limits.maxWallMs - (Date.now() - startedAt));
  if (remaining <= 0) {
    assertRuleWallBudget(startedAt, limits);
  }
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new RangeError(`Rule wall-clock budget exceeded (${limits.maxWallMs}ms)`);
      error.code = 'rule_capacity_wall_clock_exceeded';
      error.retryable = false;
      reject(error);
    }, remaining);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function runRuleReaction({
  root,
  subject,
  input = {},
  canCommit = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const limits = resolveRuleLimits(input);
  const startedAt = Date.now();
  consumeWakeIntent(root, subject, { kind: 'rule' });
  reconcileExpiredClaims(dataRoot);
  const identityKey = input.identity_key || null;
  let targetedKeys = Array.isArray(input.evidence_keys) ? input.evidence_keys.filter(Boolean) : [];
  if (identityKey) {
    const entry = getActivationLedgerEntry(dataRoot, identityKey);
    const evidenceKey = entry?.identity?.evidence_key ?? entry?.evidence_key;
    if (!evidenceKey) {
      return {
        skipped: true,
        ok: true,
        reason: 'activation_identity_unresolved',
        activation_effect: 'release',
      };
    }
    targetedKeys = [evidenceKey];
  }
  if (isReactorBusy(dataRoot, 'rule')) {
    return {
      skipped: true,
      ok: true,
      reason: 'reactor_busy',
      activation_effect: identityKey ? 'release' : undefined,
    };
  }

  const peeked = peekRuleDueWindow(dataRoot, {
    minEvents: identityKey ? 1 : (input.min_events ?? DEFAULT_MIN_EVENTS),
    maxIdleMs: input.max_idle_ms ?? DEFAULT_MAX_IDLE_MS,
    kinds: input.kinds ?? RULE_EVIDENCE_KINDS,
    limits,
  });
  if (peeked.blocked) {
    return {
      ok: false,
      skipped: true,
      reason: peeked.block_reason,
      code: peeked.error?.code || peeked.block_reason,
      retryable: false,
      activation_effect: 'release',
    };
  }
  if (!identityKey && !peeked.due.length && !input.force) {
    return {
      skipped: true,
      ok: true,
      reason: peeked.eligible.length ? 'below_threshold' : 'no_pending_evidence',
      eligible_events: peeked.eligible.length,
      activation_effect: peeked.eligible.length ? 'defer' : 'defer',
      hold_reason: {
        class: 'policy',
        code: peeked.eligible.length ? 'below_threshold' : 'no_op',
      },
    };
  }

  let dueEvents = (identityKey || input.force)
    ? peeked.eligible
    : peeked.due.flatMap((item) => item.events);
  if (targetedKeys.length) {
    const requested = new Set(targetedKeys);
    dueEvents = dueEvents.filter((item) => requested.has(envelopeEvidenceKey(item)));
    if (!dueEvents.length && identityKey) {
      return {
        skipped: true,
        ok: true,
        reason: 'below_threshold',
        activation_effect: 'defer',
        hold_reason: { class: 'policy', code: 'below_threshold' },
      };
    }
  }
  const plan = planRuleBatch(dataRoot, dueEvents, limits);
  if (!plan.events.length) {
    return {
      skipped: true,
      ok: true,
      reason: 'no_pending_evidence',
      eligible_events: dueEvents.length,
      activation_effect: 'defer',
      hold_reason: { class: 'policy', code: 'no_op' },
    };
  }
  if (plan.blocked) {
    return {
      ok: false,
      skipped: true,
      reason: plan.block_reason,
      code: plan.block_reason,
      retryable: false,
      batch_fingerprint: plan.fingerprint,
    };
  }
  const dueGoalIds = [...new Set(plan.events.map((item) => goalBucketForEnvelope(item)))];
  const claimed = claimEvidenceBatch(dataRoot, {
    reactor: 'rule',
    subject,
    limit: plan.events.length,
    kinds: input.kinds ?? RULE_EVIDENCE_KINDS,
    timeoutMs: Math.min(input.timeout_ms ?? 5 * 60 * 1000, limits.maxWallMs),
    evidenceKeys: plan.evidence_keys,
    maxHydratedBytes: limits.maxPayloadBytes,
  });
  if (claimed.skipped) {
    return {
      skipped: true,
      ok: true,
      reason: claimed.skipped,
      activation_effect: identityKey ? 'defer' : undefined,
      hold_reason: identityKey ? { class: 'policy', code: 'no_op' } : undefined,
    };
  }

  const { batch_id: batchId, events } = claimed;
  const fingerprint = ruleBatchFingerprintForClaim(plan, events);
  const trigger = peeked.due[0]?.reason || (input.force ? 'forced' : 'evidence_count');
  patchBatchCheckpoint(dataRoot, batchId, {
    reactor: 'rule',
    subject,
    stage: 'claimed',
    event_ids: events.map((item) => item.id),
    evidence_keys: events.map((item) => envelopeEvidenceKey(item)),
    batch_fingerprint: fingerprint,
    payload_bytes: plan.payload_bytes,
    budgets: {
      max_events: limits.maxEvents,
      max_payload_bytes: limits.maxPayloadBytes,
      max_wall_ms: limits.maxWallMs,
      max_consecutive_failures: limits.maxConsecutiveFailures,
    },
  });

  if (plan.failure?.status === 'quarantined') {
    commitRuleEventCursors(dataRoot, events, batchId);
    ackBatchHandled(dataRoot, batchId, {
      handled_meta: {
        quarantined: true,
        quarantine_id: `rule-quarantine:${fingerprint}`,
        batch_fingerprint: fingerprint,
      },
    });
    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'quarantined',
      quarantine_id: `rule-quarantine:${fingerprint}`,
    });
    return {
      ok: true,
      skipped: false,
      quarantined: true,
      recovered: true,
      batch_id: batchId,
      batch_fingerprint: fingerprint,
      claimed_events: events.length,
    };
  }

  try {
    if (events.length > limits.maxEvents) {
      const error = new RangeError(`Rule event budget exceeded (${events.length} > ${limits.maxEvents})`);
      error.code = 'rule_capacity_event_count_exceeded';
      error.retryable = false;
      throw error;
    }
    if (plan.payload_bytes > limits.maxPayloadBytes) {
      const error = new RangeError(
        `Rule hydrated payload budget exceeded (${plan.payload_bytes} > ${limits.maxPayloadBytes})`,
      );
      error.code = 'rule_capacity_payload_exceeded';
      error.retryable = false;
      throw error;
    }
    assertRuleWallBudget(startedAt, limits);
    const ctx = await buildCycleContext(root, runtime);
    ctx.pipeline = 'reactor';
    const windows = settlementWindowsFromEvents(dataRoot, events);
    const settlements = [];
    for (const window of windows) {
      assertRuleWallBudget(startedAt, limits);
      const identity = originIdentity(window.events);
      const intelResult = {
        cycle_id: batchId,
        batch_id: batchId,
        goal_ids: dueGoalIds,
        ...identity,
      };
      settlements.push(await withRuleWallDeadline(settleEvidenceWindow(ctx, {
        intelResult,
        execResult: { ...identity, ...window.execResult },
        verification: window.verification,
        reportPath: window.reportPath,
        receipts: window.receipts,
        intelReportReady: true,
        canCommit: () => (
          (typeof canCommit !== 'function' || canCommit())
          && Date.now() - startedAt < limits.maxWallMs
        ),
        producer: 'rule',
        activationTargets: ['cognitive'],
        useLatestReport: true,
      }), startedAt, limits));
      assertRuleWallBudget(startedAt, limits);
    }
    if (typeof canCommit === 'function' && !canCommit()) {
      const error = new Error('reactor_task_lease_lost');
      error.code = 'lease_lost';
      throw error;
    }
    commitRuleEventCursors(dataRoot, events, batchId);
    ackBatchHandled(dataRoot, batchId);
    clearRuleFailure(dataRoot, fingerprint);
    patchBatchCheckpoint(dataRoot, batchId, { stage: 'committed' });
    return {
      skipped: false,
      ok: true,
      activation_effect: 'handle',
      batch_id: batchId,
      claimed_events: events.length,
      batch_fingerprint: fingerprint,
      payload_bytes: plan.payload_bytes,
      trigger,
      goal_ids: dueGoalIds,
      settlements,
      belief: settlements[0]?.belief ?? null,
      goals: settlements[0]?.goals ?? null,
      calibrate: settlements[0]?.calibrate ?? null,
    };
  } catch (err) {
    const failure = noteRuleFailure(dataRoot, {
      fingerprint,
      evidenceKeys: events.map((item) => envelopeEvidenceKey(item)),
      error: err,
      eventCount: events.length,
      limits,
    });
    if (failure.action === 'quarantine') {
      const quarantine = quarantineRuleEvidence(dataRoot, {
        fingerprint,
        event: events[0],
        error: err,
        batchId,
      });
      commitRuleEventCursors(dataRoot, events, batchId);
      ackBatchHandled(dataRoot, batchId, {
        handled_meta: {
          quarantined: true,
          quarantine_id: quarantine.quarantine_id,
          batch_fingerprint: fingerprint,
        },
      });
      patchBatchCheckpoint(dataRoot, batchId, {
        stage: 'quarantined',
        last_error: err?.message || String(err),
        quarantine_id: quarantine.quarantine_id,
      });
      return {
        ok: true,
        skipped: false,
        activation_effect: 'handle',
        quarantined: true,
        quarantine,
        batch_id: batchId,
        batch_fingerprint: fingerprint,
        claimed_events: 1,
      };
    }
    try {
      nackBatchFailed(dataRoot, batchId, { error: err?.message || String(err) });
    } catch (requeueError) {
      requeueError.code = requeueError.code || 'terminal_claim_requeue_failed';
      requeueError.stage = 'terminal_claim_requeue';
      throw requeueError;
    }
    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'failed',
      last_error: err?.message || String(err),
      batch_fingerprint: fingerprint,
      failure_action: failure.action,
    });
    if (failure.action === 'split') {
      err.code = 'rule_batch_split_required';
      err.retryable = false;
      err.next_max_events = failure.next_max_events;
    } else if (failure.action === 'block') {
      err.code = failure.block_reason || RULE_BLOCK_REASONS.circuit;
      err.retryable = false;
    } else {
      err.retryable = failure.retryable;
    }
    throw err;
  }
}

function ruleBatchFingerprintForClaim(plan, events) {
  const keys = events.map((event) => envelopeEvidenceKey(event));
  return keys.length === plan.evidence_keys.length
    && keys.every((key, index) => key === plan.evidence_keys[index])
    ? plan.fingerprint
    : ruleBatchFingerprint(keys);
}
