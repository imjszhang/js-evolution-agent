/**
 * Per-goal rule reactor (S6).
 * Peek due window → claim only when threshold/wall-clock is met.
 */
import { runtimeForSubject } from '../../infra/runtime-paths.mjs';
import { buildCycleContext, runBeliefUpdateStep, runGoalsAssessStep, runGoalsCalibrateStep } from '../cycle-steps.mjs';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  isReactorBusy,
  listEligibleEvidence,
  nackBatchFailed,
  reconcileExpiredClaims,
} from './claim-ledger.mjs';
import { consumeWakeIntent } from './wake-store.mjs';
import { patchBatchCheckpoint } from './batch-checkpoint-store.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';
import {
  cursorForGoal,
  eventsAfterCursor,
  goalBucketForEnvelope,
  readRuleCursors,
  writeRuleCursors,
} from './rule-cursors.mjs';

const DEFAULT_MIN_EVENTS = 8;
const DEFAULT_MAX_IDLE_MS = 48 * 60 * 60 * 1000;

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
} = {}) {
  const eligible = listEligibleEvidence(dataRoot, { reactor: 'rule', kinds, now: nowMs });
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
  return { eligible, due, cursors };
}

export async function runRuleReaction({
  root,
  subject,
  input = {},
  canCommit = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  consumeWakeIntent(root, subject, { kind: 'rule' });
  reconcileExpiredClaims(dataRoot);
  if (isReactorBusy(dataRoot, 'rule')) {
    return { skipped: true, reason: 'reactor_busy' };
  }

  const peeked = peekRuleDueWindow(dataRoot, {
    minEvents: input.min_events ?? DEFAULT_MIN_EVENTS,
    maxIdleMs: input.max_idle_ms ?? DEFAULT_MAX_IDLE_MS,
    kinds: input.kinds ?? RULE_EVIDENCE_KINDS,
  });
  if (!peeked.due.length && !input.force) {
    return {
      skipped: true,
      reason: peeked.eligible.length ? 'below_threshold' : 'no_pending_evidence',
      eligible_events: peeked.eligible.length,
    };
  }

  const dueEvents = input.force
    ? peeked.eligible
    : peeked.due.flatMap((item) => item.events);
  const dueGoalIds = input.force
    ? [...new Set(peeked.eligible.map((item) => goalBucketForEnvelope(item)))]
    : peeked.due.map((item) => item.goalId);
  const claimed = claimEvidenceBatch(dataRoot, {
    reactor: 'rule',
    subject,
    limit: input.limit ?? Math.max(dueEvents.length, 1),
    kinds: input.kinds ?? RULE_EVIDENCE_KINDS,
    timeoutMs: input.timeout_ms ?? 5 * 60 * 1000,
    evidenceKeys: dueEvents.map((item) => envelopeEvidenceKey(item)),
  });
  if (claimed.skipped) {
    return { skipped: true, reason: claimed.skipped };
  }

  const { batch_id: batchId, events } = claimed;
  const trigger = peeked.due[0]?.reason || (input.force ? 'forced' : 'evidence_count');
  patchBatchCheckpoint(dataRoot, batchId, {
    reactor: 'rule',
    subject,
    stage: 'claimed',
    event_ids: events.map((item) => item.id),
    evidence_keys: events.map((item) => envelopeEvidenceKey(item)),
  });

  try {
    const ctx = await buildCycleContext(root, runtime);
    ctx.pipeline = 'reactor';
    const intelResult = { cycle_id: batchId, batch_id: batchId, goal_ids: dueGoalIds };
    const execResult = { cycle_id: batchId };
    const belief = await runBeliefUpdateStep(ctx, {
      intelResult,
      execResult,
      canCommit,
      producer: 'rule',
      activationTargets: ['cognitive'],
    });
    const goals = await runGoalsAssessStep(ctx, {
      intelResult,
      intelReportReady: true,
      canCommit,
      producer: 'rule',
      activationTargets: ['cognitive'],
      useLatestReport: true,
    });
    let calibrate = null;
    if (goals?.goalsAssessResult) {
      calibrate = await runGoalsCalibrateStep(ctx, {
        intelResult,
        goalsAssessResult: goals.goalsAssessResult,
        store: ctx.store,
        canCommit,
        producer: 'rule',
        activationTargets: ['cognitive'],
      });
    }
    if (typeof canCommit === 'function' && !canCommit()) {
      const error = new Error('reactor_task_lease_lost');
      error.code = 'lease_lost';
      throw error;
    }
    const claimedByGoal = new Map();
    for (const event of events) {
      claimedByGoal.set(goalBucketForEnvelope(event), event);
    }
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
    ackBatchHandled(dataRoot, batchId);
    patchBatchCheckpoint(dataRoot, batchId, { stage: 'committed' });
    return {
      skipped: false,
      batch_id: batchId,
      claimed_events: events.length,
      trigger,
      goal_ids: dueGoalIds,
      belief,
      goals,
      calibrate,
    };
  } catch (err) {
    nackBatchFailed(dataRoot, batchId, { error: err?.message || String(err) });
    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'failed',
      last_error: err?.message || String(err),
    });
    throw err;
  }
}
