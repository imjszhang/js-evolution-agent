/**
 * Read-only rule-feedback cycle vs evidence compare + historical rolling replay.
 */
import {
  computeRuleFeedbackStats,
  selectRollingCutpoints,
  truncateByAsOf,
} from '../../intelligence/rule-feedback.mjs';
import {
  readPendingOperatorQuestions,
  readResolvedOperatorQuestions,
} from '../../intelligence/operator-questions.mjs';

function summarizeGoal(stat) {
  if (!stat) return null;
  return {
    state: stat.feedback_state,
    sig_streak: stat.constant_signature_streak,
    starved_streak: stat.starved_streak,
    starved_hours: stat.starved_hours,
    starved_strategy: stat.starved_strategy,
    mutate_effective: stat.mutate_effective,
    escalate_eligible: stat.escalate_eligible,
    observed: stat.units_observed,
  };
}

function diffGoals(cycle, evidence) {
  const cycleByGoal = new Map(cycle.goals.map((goal) => [goal.goal_id, goal]));
  const evidenceByGoal = new Map(evidence.goals.map((goal) => [goal.goal_id, goal]));
  const goalIds = [...new Set([...cycleByGoal.keys(), ...evidenceByGoal.keys()])];
  return goalIds.map((id) => {
    const a = cycleByGoal.get(id) ?? null;
    const b = evidenceByGoal.get(id) ?? null;
    return {
      goal_id: id,
      cycle: summarizeGoal(a),
      evidence: summarizeGoal(b),
      differs: Boolean(
        a?.feedback_state !== b?.feedback_state
        || a?.constant_signature_streak !== b?.constant_signature_streak
        || a?.starved_streak !== b?.starved_streak
        || a?.mutate_effective !== b?.mutate_effective
        || a?.escalate_eligible !== b?.escalate_eligible
      ),
    };
  });
}

function parseAsOfMs(raw) {
  if (raw == null || raw === true || raw === '') return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    // Treat 10-digit as seconds, 13-digit as ms.
    return text.length <= 10 ? n * 1000 : n;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --at timestamp: ${text}`);
  }
  return ms;
}

function makeAsOfStore(store, {
  asOfMs = null,
  receiptLimit = 120,
  goalEventLimit = 200,
  receipts = null,
  goalEvents = null,
} = {}) {
  const baseReceipts = Array.isArray(receipts)
    ? receipts
    : (store.readActionReceipts?.({ limit: receiptLimit }) ?? []);
  const baseEvents = Array.isArray(goalEvents)
    ? goalEvents
    : (store.readGoalEvents?.({ limit: goalEventLimit }) ?? []);
  const filteredReceipts = truncateByAsOf(baseReceipts, asOfMs);
  const filteredEvents = truncateByAsOf(baseEvents, asOfMs, (e) => {
    const raw = e?.recorded_at || e?.created_at || null;
    const ms = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ms) ? ms : 0;
  });
  return {
    readActionReceipts: ({ limit = receiptLimit } = {}) => filteredReceipts.slice(-limit),
    readGoalEvents: ({ limit = goalEventLimit } = {}) => filteredEvents.slice(-limit),
    receipt_count: filteredReceipts.length,
    goal_event_count: filteredEvents.length,
  };
}

function compareAtCutpoint({
  store,
  activeGoals,
  carryoverDoc,
  mechanicalGuards,
  asOfMs = null,
  receiptLimit = 120,
  starvedStrategy = null,
  baseEnv = process.env,
  allReceipts = null,
  allGoalEvents = null,
}) {
  const asOfStore = makeAsOfStore(store, {
    asOfMs,
    receiptLimit,
    receipts: allReceipts,
    goalEvents: allGoalEvents,
  });
  const envBase = { ...baseEnv };
  if (starvedStrategy) {
    envBase.JEA_RULE_FEEDBACK_STARVED_STRATEGY = starvedStrategy;
  }
  envBase.JEA_RULE_FEEDBACK_RECEIPT_LIMIT = String(receiptLimit);
  const common = {
    store: asOfStore,
    activeGoals,
    carryoverDoc,
    mechanicalGuards,
    asOfMs,
  };
  const cycle = computeRuleFeedbackStats({
    ...common,
    env: { ...envBase, JEA_RULE_FEEDBACK_STREAK_UNIT: 'cycle' },
  });
  const evidence = computeRuleFeedbackStats({
    ...common,
    env: { ...envBase, JEA_RULE_FEEDBACK_STREAK_UNIT: 'evidence' },
  });
  const goals = diffGoals(cycle, evidence);
  return {
    as_of: asOfMs ? new Date(asOfMs).toISOString() : null,
    as_of_ms: asOfMs,
    receipt_count: asOfStore.receipt_count,
    goal_event_count: asOfStore.goal_event_count,
    configs: { cycle: cycle.config, evidence: evidence.config },
    summary: {
      goals: goals.length,
      differing: goals.filter((goal) => goal.differs).length,
      cycle: cycle.summary,
      evidence: evidence.summary,
    },
    goals,
  };
}

function collectTransitions(cutpoints = []) {
  const transitions = [];
  for (let i = 1; i < cutpoints.length; i += 1) {
    const prev = cutpoints[i - 1];
    const curr = cutpoints[i];
    const prevMap = new Map(prev.goals.map((g) => [g.goal_id, g]));
    for (const goal of curr.goals) {
      const before = prevMap.get(goal.goal_id);
      if (!before) continue;
      for (const unit of ['cycle', 'evidence']) {
        const a = before[unit];
        const b = goal[unit];
        if (!a || !b) continue;
        if (
          a.state !== b.state
          || a.escalate_eligible !== b.escalate_eligible
          || a.starved_streak !== b.starved_streak
        ) {
          transitions.push({
            goal_id: goal.goal_id,
            unit,
            from_as_of: prev.as_of,
            to_as_of: curr.as_of,
            from: a,
            to: b,
          });
        }
      }
    }
  }
  return transitions;
}

function collectFalsePositiveContext(runtimeRoot, store, { limit = 500 } = {}) {
  const events = (store.readEvolutionEvents?.({ limit }) ?? [])
    .filter((e) => e?.type === 'rule_feedback_escalated');
  const pending = readPendingOperatorQuestions(runtimeRoot, { limit: 10_000 }).questions || [];
  const resolved = readResolvedOperatorQuestions(runtimeRoot, { limit: 10_000 }).questions || [];
  const questions = [...pending, ...resolved]
    .filter((q) => q?.trigger === 'rule_feedback_dead')
    .map((q) => ({
      id: q.id,
      status: q.status ?? (resolved.includes(q) ? 'resolved' : 'pending'),
      created_at: q.created_at ?? null,
      resolved_at: q.resolved_at ?? null,
      goal_id: q.metadata?.goal_id ?? null,
      feedback_state: q.metadata?.feedback_state ?? null,
      constant_signature_streak: q.metadata?.constant_signature_streak ?? null,
      reason: q.reason ?? q.text ?? null,
    }));
  return {
    escalated_events: events.map((e) => ({
      id: e.id,
      cycle_id: e.cycle_id ?? null,
      goal_id: e.goal_id ?? null,
      recorded_at: e.recorded_at ?? null,
      feedback_state: e.feedback_state ?? null,
      constant_signature_streak: e.constant_signature_streak ?? null,
      question_id: e.question_id ?? null,
    })),
    questions,
    note: 'Join by goal_id + time; starved vs dead share trigger rule_feedback_dead.',
  };
}

/**
 * @param {object} deps
 * @param {object} deps.runtime
 * @param {object} deps.activeGoals
 * @param {object} deps.store
 * @param {object|null} deps.carryoverDoc
 * @param {object[]} deps.mechanicalGuards
 * @param {object} flags
 */
export function runRuleFeedbackCompare({
  runtime,
  activeGoals,
  store,
  carryoverDoc = null,
  mechanicalGuards = [],
  flags = {},
  env = process.env,
} = {}) {
  const receiptLimit = Math.max(
    40,
    Number(flags['receipt-limit'] || flags.receiptLimit || env.JEA_RULE_FEEDBACK_RECEIPT_LIMIT || 500) || 500,
  );
  const asOfMs = parseAsOfMs(flags.at);
  const rollingN = flags.rolling === true ? 5 : Number(flags.rolling);
  const hasRolling = Number.isFinite(rollingN) && rollingN > 0;
  if (asOfMs != null && hasRolling) {
    throw new Error('Use either --at or --rolling, not both');
  }
  const rawStrategy = String(flags['starved-strategy'] || flags.starvedStrategy || 'global_count')
    .trim()
    .toLowerCase();
  const strategies = rawStrategy === 'both'
    ? ['global_count', 'wall_clock']
    : rawStrategy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const includeFp = Boolean(flags['include-fp'] || flags.includeFp);

  // Prefetch once for deterministic rolling cutpoints.
  const allReceipts = store.readActionReceipts?.({ limit: receiptLimit }) ?? [];
  const allGoalEvents = store.readGoalEvents?.({ limit: Math.max(200, Math.min(500, receiptLimit)) }) ?? [];

  const cutpointMsList = hasRolling
    ? selectRollingCutpoints(
      asOfMs != null ? truncateByAsOf(allReceipts, asOfMs) : allReceipts,
      rollingN,
    )
    : [asOfMs];

  const strategyRuns = (strategies.length ? strategies : ['global_count']).map((strategy) => {
    const cutpoints = cutpointMsList.map((cutMs) => compareAtCutpoint({
      store,
      activeGoals,
      carryoverDoc,
      mechanicalGuards,
      asOfMs: cutMs,
      receiptLimit,
      starvedStrategy: strategy,
      baseEnv: env,
      allReceipts,
      allGoalEvents,
    }));
    return {
      starved_strategy: strategy,
      cutpoints,
      transitions: collectTransitions(cutpoints),
      latest: cutpoints[cutpoints.length - 1] ?? null,
    };
  });

  const primary = strategyRuns[0];
  const result = {
    subject: runtime.subject,
    generated_at: new Date().toISOString(),
    read_only: true,
    mode: hasRolling ? 'rolling' : (asOfMs != null ? 'as_of' : 'current'),
    receipt_limit: receiptLimit,
    strategies: strategyRuns.map((s) => s.starved_strategy),
    // Backward-compatible top-level fields = first strategy, latest cutpoint.
    configs: primary?.latest?.configs ?? null,
    summary: primary?.latest?.summary ?? null,
    goals: primary?.latest?.goals ?? [],
    cutpoints: primary?.cutpoints ?? [],
    transitions: primary?.transitions ?? [],
    strategy_runs: strategyRuns,
  };

  if (includeFp) {
    result.historical_fp_context = collectFalsePositiveContext(
      runtime.runtimeRoot,
      store,
      { limit: Math.max(receiptLimit, 500) },
    );
  }

  // Candidate thresholds from latest cutpoint (provisional; see calibration doc).
  if (primary?.latest) {
    const evidenceGoals = primary.latest.goals || [];
    const starvedEvidence = evidenceGoals
      .map((g) => g.evidence?.starved_streak)
      .filter((n) => Number.isFinite(n) && n > 0 && n < Number.POSITIVE_INFINITY)
      .sort((a, b) => a - b);
    const cycleEscalate = evidenceGoals.filter((g) => g.cycle?.escalate_eligible).length;
    const evidenceEscalate = evidenceGoals.filter((g) => g.evidence?.escalate_eligible).length;
    const wallRun = strategyRuns.find((s) => s.starved_strategy === 'wall_clock');
    const wallLatest = wallRun?.latest;
    const wallEvidenceEscalate = (wallLatest?.goals || [])
      .filter((g) => g.evidence?.escalate_eligible).length;
    result.candidate_thresholds = {
      note: 'Provisional from latest cutpoint. Prefer wall_clock starved for evidence gray; keep sig dead=3.',
      cycle_escalate_eligible: cycleEscalate,
      evidence_escalate_eligible_global_count: evidenceEscalate,
      evidence_escalate_eligible_wall_clock: wallLatest ? wallEvidenceEscalate : null,
      evidence_starved_streak_p50: starvedEvidence.length
        ? starvedEvidence[Math.floor(starvedEvidence.length / 2)]
        : null,
      suggested: {
        JEA_RULE_FEEDBACK_STREAK_UNIT: 'evidence',
        JEA_RULE_FEEDBACK_DEAD_STREAK: 3,
        JEA_RULE_FEEDBACK_ESCALATE_STREAK: 5,
        JEA_RULE_FEEDBACK_STARVED_STREAK_EVIDENCE: 12,
        JEA_RULE_FEEDBACK_STARVED_STRATEGY: 'wall_clock',
        JEA_RULE_FEEDBACK_STARVED_WINDOW_HOURS: 48,
        JEA_RULE_FEEDBACK_WINDOW_EVIDENCE: 24,
        JEA_GOAL_AUTO_APPLY: '0',
      },
      rationale: {
        global_count_mismatch: `latest evidence escalate=${evidenceEscalate} vs cycle=${cycleEscalate}`,
        wall_clock_alignment: wallLatest
          ? `wall_clock evidence escalate=${wallEvidenceEscalate} (closer to cycle when subject is active)`
          : 'run with --starved-strategy both to compare',
      },
    };
  }

  return result;
}
