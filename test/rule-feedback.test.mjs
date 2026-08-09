import { describe, expect, it } from 'vitest';
import {
  buildGoalReceiptBuckets,
  buildMechanicalGuardMap,
  buildRuleFeedbackQuestionText,
  computeHealthyStreak,
  computeInformationGain,
  computeMutateEffective,
  computeRuleFeedbackStats,
  computeSignatureStreak,
  computeStarvedStreak,
  extractResultSignature,
  formatRuleFeedbackForPrompt,
  isGuardGoal,
  resolveRuleFeedbackConfig,
  selectRuleFeedbackEscalations,
} from '../src/intelligence/rule-feedback.mjs';

function makeReceipt({
  id = 'receipt-1',
  cycleId = 'cycle-1',
  servesGoal = 'guard-memory-audit-v28',
  summary = 'typed=35 free_text_clean=KEY_ABSENT audit_ok=true',
  recordedAt = null,
  success = true,
  origin = null,
  guardId = null,
} = {}) {
  return {
    id,
    cycle_id: cycleId,
    recorded_at: recordedAt,
    action_type: 'agent_run',
    action: {
      type: 'agent_run',
      serves_goal: servesGoal,
      ...(origin ? { origin } : {}),
      ...(guardId ? { guard_id: guardId } : {}),
    },
    result: { summary, status: success ? 'completed' : 'failed', success },
  };
}

const MEMORY_AUDIT_GUARD = {
  id: 'memory-audit',
  enabled: true,
  every_cycles: 2,
  action: {
    type: 'agent_run',
    serves_goal: 'guard-memory-audit-v28',
  },
};

describe('extractResultSignature', () => {
  it('extracts normalized key=value and key: value pairs', () => {
    const sig = extractResultSignature(makeReceipt({
      summary: 'typed_evidence_refs=35 free_text_clean=KEY_ABSENT audit_ok: true verify_pipeline=FAIL',
    }));
    expect(sig.keys).toContain('typed_evidence_refs');
    expect(sig.keys).toContain('free_text_clean');
    expect(sig.keys).toContain('audit_ok');
    expect(sig.kv.find((p) => p.key === 'free_text_clean')?.value).toBe('key_absent');
    expect(sig.signature).toMatch(/^[a-f0-9]{16}$/);
  });

  it('returns null signature when no kv pairs', () => {
    const sig = extractResultSignature(makeReceipt({ summary: 'no structured fields here' }));
    expect(sig.signature).toBeNull();
    expect(sig.kv).toEqual([]);
  });

  it('extracts narrative free_text_clean absent forms', () => {
    const sig = extractResultSignature(makeReceipt({
      summary: '确认 typed_evidence_refs=38、free_text_clean 字段 absent（memory_policy 未写该键）',
    }));
    expect(sig.kv.find((p) => p.key === 'free_text_clean')?.value).toBe('key_absent');
    expect(sig.sticky?.some((p) => p.key === 'free_text_clean')).toBe(true);
  });

  it('extracts bare free_text_clean KEY_ABSENT without equals', () => {
    const sig = extractResultSignature(makeReceipt({
      summary: 'free_text_clean KEY_ABSENT ruled NOT_ACCEPTABLE_AS_CLEAN; verify_pipeline mechanical FAIL',
    }));
    expect(sig.kv.find((p) => p.key === 'free_text_clean')?.value).toBe('key_absent');
    expect(sig.signature).toMatch(/^[a-f0-9]{16}$/);
  });

  it('uses sticky law keys for signature so verify noise does not change hash', () => {
    const a = extractResultSignature(makeReceipt({
      summary: 'free_text_clean=KEY_ABSENT audit_ok=true',
    }));
    const b = extractResultSignature(makeReceipt({
      summary: 'free_text_clean=KEY_ABSENT audit_ok=true verify_pipeline_mechanical=fail',
    }));
    expect(a.signature).toBe(b.signature);
  });
});

describe('streak and information gain', () => {
  it('computes trailing constant signature streak', () => {
    const buckets = [
      { signature: 'aaa', kv: [{ key: 'a', value: '1' }] },
      { signature: 'bbb', kv: [{ key: 'a', value: '2' }] },
      { signature: 'bbb', kv: [{ key: 'a', value: '2' }] },
      { signature: 'bbb', kv: [{ key: 'a', value: '2' }] },
    ];
    const { streak, signature } = computeSignatureStreak(buckets);
    expect(streak).toBe(3);
    expect(signature).toBe('bbb');
  });

  it('computes information gain across kv diffs', () => {
    const prev = { kv: [{ key: 'a', value: '1' }, { key: 'b', value: 'x' }] };
    const curr = { kv: [{ key: 'a', value: '2' }, { key: 'c', value: 'y' }] };
    expect(computeInformationGain(prev, curr)).toBe(3); // a changed, b removed, c added
    expect(computeInformationGain(curr, curr)).toBe(0);
  });
});

describe('rule feedback streak units', () => {
  it('defaults to cycle and parses evidence window independently', () => {
    expect(resolveRuleFeedbackConfig({}).streakUnit).toBe('cycle');
    expect(resolveRuleFeedbackConfig({
      JEA_RULE_FEEDBACK_STREAK_UNIT: 'evidence',
      JEA_RULE_FEEDBACK_WINDOW_EVIDENCE: '12',
    })).toMatchObject({
      streakUnit: 'evidence',
      window: 12,
      windowEvidence: 12,
    });
  });

  it('counts same-cycle serving receipts independently in evidence mode', () => {
    const receipts = [
      makeReceipt({ id: 'r1', cycleId: 'cycle-1', recordedAt: '2026-01-01T00:00:01Z' }),
      makeReceipt({ id: 'r2', cycleId: 'cycle-1', recordedAt: '2026-01-01T00:00:02Z' }),
      makeReceipt({ id: 'r3', cycleId: 'cycle-1', recordedAt: '2026-01-01T00:00:03Z' }),
    ];
    expect(buildGoalReceiptBuckets(receipts, { streakUnit: 'cycle', window: 8 })).toHaveLength(1);
    expect(buildGoalReceiptBuckets(receipts, { streakUnit: 'evidence', window: 8 })).toHaveLength(3);

    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const activeGoals = {
      id: 'root',
      children: [{ id: 'guard-memory-audit-v28', name: 'memory', intent: 'x' }],
    };
    const cycle = computeRuleFeedbackStats({
      store,
      activeGoals,
      deadStreak: 3,
      escalateStreak: 5,
      env: { JEA_RULE_FEEDBACK_STREAK_UNIT: 'cycle' },
    }).goals[0];
    const evidence = computeRuleFeedbackStats({
      store,
      activeGoals,
      deadStreak: 3,
      escalateStreak: 5,
      env: {
        JEA_RULE_FEEDBACK_STREAK_UNIT: 'evidence',
        JEA_RULE_FEEDBACK_WINDOW_EVIDENCE: '8',
      },
    }).goals[0];

    expect(cycle).toMatchObject({
      streak_unit: 'cycle',
      constant_signature_streak: 1,
      feedback_state: 'live',
    });
    expect(evidence).toMatchObject({
      streak_unit: 'evidence',
      constant_signature_streak: 3,
      feedback_state: 'dead',
      units_observed: 3,
    });
  });
});

describe('computeRuleFeedbackStats', () => {
  it('marks dead when constant signature streak hits threshold with zero gain', () => {
    const receipts = [
      makeReceipt({ id: 'r3', cycleId: 'cycle-3' }),
      makeReceipt({ id: 'r2', cycleId: 'cycle-2' }),
      makeReceipt({ id: 'r1', cycleId: 'cycle-1' }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [
        { type: 'assessment', rule_status: 'learn' },
        { type: 'assessment', rule_status: 'learn' },
        { type: 'assessment', rule_status: 'learn' },
      ],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', name: 'memory', role: 'guard', intent: 'x' }],
      },
      deadStreak: 3,
      escalateStreak: 5,
      windowCycles: 8,
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row).toBeTruthy();
    expect(row.feedback_state).toBe('dead');
    expect(row.constant_signature_streak).toBe(3);
    expect(row.information_gain).toBe(0);
    expect(row.is_guard).toBe(true);
    expect(row.consecutive_learn).toBe(3);
    expect(stats.summary.dead).toBeGreaterThanOrEqual(1);
  });

  it('marks live when signature changes between cycles', () => {
    const receipts = [
      makeReceipt({ id: 'r2', cycleId: 'cycle-2', summary: 'typed=36 free_text_clean=true' }),
      makeReceipt({ id: 'r1', cycleId: 'cycle-1', summary: 'typed=35 free_text_clean=KEY_ABSENT' }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.feedback_state).toBe('live');
    expect(row.information_gain).toBeGreaterThan(0);
  });

  it('does not mark constant success signatures as dead', () => {
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        servesGoal: 'guard-ok',
        summary: 'free_text_clean=true audit_ok=true',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        servesGoal: 'guard-ok',
        summary: 'free_text_clean=true audit_ok=true',
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        servesGoal: 'guard-ok',
        summary: 'free_text_clean=true audit_ok=true',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-ok', role: 'guard' }],
      },
      deadStreak: 3,
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-ok');
    expect(row.feedback_state).toBe('live');
    expect(row.constant_signature_streak).toBe(3);
  });

  it('marks root goal rows with is_root when receipts serve the root id', () => {
    const receipts = [
      makeReceipt({ id: 'r1', cycleId: 'cycle-1', servesGoal: 'win-root-v28' }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'win-root-v28',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
    });
    const rootRow = stats.goals.find((g) => g.goal_id === 'win-root-v28');
    const childRow = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(rootRow?.is_root).toBe(true);
    expect(childRow?.is_root).toBe(false);
  });

  it('downgrades dead to degraded during mutate cooldown and skips escalation', () => {
    const mutateAt = '2026-08-05T11:30:00.000Z';
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        recordedAt: '2026-08-05T11:00:00.000Z',
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        recordedAt: '2026-08-05T09:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [{
        type: 'patched',
        rule_status: 'mutate',
        cycle_id: 'cycle-mutate',
        recorded_at: mutateAt,
        patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      }],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
      escalateStreak: 5,
      env: { JEA_RULE_FEEDBACK_MUTATE_COOLDOWN: '2' },
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.feedback_state).toBe('degraded');
    expect(row.mutate_cooldown).toBe(true);
    expect(row.cycles_since_mutate).toBe(1);
    expect(row.escalate_eligible).toBe(false);

    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: stats,
      assessment: { rule_status: 'learn' },
      calibrateResult: { status: 'skipped', applied_patches: [] },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(0);
  });

  it('restores dead after mutate cooldown expires with enough post-mutate cycles', () => {
    const mutateAt = '2026-08-05T08:00:00.000Z';
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        recordedAt: '2026-08-05T09:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [{
        type: 'patched',
        rule_status: 'mutate',
        cycle_id: 'cycle-mutate',
        recorded_at: mutateAt,
        patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      }],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
      escalateStreak: 5,
      env: { JEA_RULE_FEEDBACK_MUTATE_COOLDOWN: '2' },
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.feedback_state).toBe('dead');
    expect(row.mutate_cooldown).toBe(false);
    expect(row.cycles_since_mutate).toBeGreaterThanOrEqual(2);
  });
});

describe('selectRuleFeedbackEscalations', () => {
  it('escalates dead goals past escalate streak when calibrate did not mutate-apply them', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          constant_signature_streak: 5,
          constant_keys: [{ key: 'free_text_clean', value: 'key_absent' }],
        }],
      },
      assessment: { rule_status: 'learn' },
      calibrateResult: { status: 'skipped', applied_patches: [] },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(1);
    expect(buildRuleFeedbackQuestionText(escalations[0])).toContain('guard-memory-audit-v28');
  });

  it('skips when mutate applied full_replace tree rewrite', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          constant_signature_streak: 5,
        }],
      },
      assessment: { rule_status: 'mutate' },
      calibrateResult: {
        status: 'applied',
        mode: 'full_replace',
        applied_patches: [],
      },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(0);
  });

  it('skips when mutate applied a patch for that goal', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          constant_signature_streak: 5,
        }],
      },
      assessment: { rule_status: 'mutate' },
      calibrateResult: {
        status: 'applied',
        applied_patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(0);
  });

  it('dedupes against pending rule_feedback_dead questions', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          constant_signature_streak: 5,
        }],
      },
      assessment: { rule_status: 'learn' },
      calibrateResult: { status: 'skipped', applied_patches: [] },
      pendingQuestions: [{
        trigger: 'rule_feedback_dead',
        metadata: { goal_id: 'guard-memory-audit-v28' },
      }],
    });
    expect(escalations).toHaveLength(0);
  });
});

describe('isGuardGoal', () => {
  it('detects role=guard and id prefixes', () => {
    expect(isGuardGoal({ id: 'x', role: 'guard' })).toBe(true);
    expect(isGuardGoal({ id: 'guard-memory-audit-v28' })).toBe(true);
    expect(isGuardGoal({ id: 'monitor-credential-compliance-v28' })).toBe(true);
    expect(isGuardGoal({ id: 'iterate-skill-with-calibrated-sim-v28' })).toBe(false);
    expect(isGuardGoal({ id: 'quiet-capability', role: 'outcome' })).toBe(false);
  });
});

describe('explicit role persistence for rule feedback', () => {
  it('persisted role=outcome (no outcome keywords) is not guard and can starve', () => {
    const receipts = [
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        servesGoal: 'other-outcome',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        servesGoal: 'other-outcome',
        recordedAt: '2026-08-05T11:00:00.000Z',
      }),
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        servesGoal: 'other-outcome',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [
          {
            id: 'quiet-capability',
            name: 'Quiet capability',
            intent: 'ship a measurable capability increment',
            role: 'outcome',
          },
          {
            id: 'other-outcome',
            name: 'Other',
            intent: 'improve rank',
            role: 'outcome',
          },
        ],
      },
      deadStreak: 3,
      escalateStreak: 5,
      windowCycles: 8,
    });
    const quiet = stats.goals.find((g) => g.goal_id === 'quiet-capability');
    expect(quiet).toBeTruthy();
    expect(quiet.is_guard).toBe(false);
    expect(quiet.mechanically_maintained).toBe(false);
    expect(quiet.starved).toBe(true);
    expect(quiet.starved_streak).toBeGreaterThanOrEqual(3);
  });
});

describe('computeStarvedStreak', () => {
  it('counts trailing global cycles with no receipt for the goal', () => {
    expect(computeStarvedStreak({
      globalCycleIdsNewestFirst: ['c4', 'c3', 'c2', 'c1'],
      goalCycleIds: new Set(['c1']),
      windowCycles: 8,
    })).toBe(3);
    expect(computeStarvedStreak({
      globalCycleIdsNewestFirst: ['c4', 'c3', 'c2', 'c1'],
      goalCycleIds: new Set(['c4']),
      windowCycles: 8,
    })).toBe(0);
  });
});

describe('computeMutateEffective', () => {
  it('returns null during cooldown and false when signature unchanged after cooldown', () => {
    const buckets = [
      { signature: 'aaa', receipt_time_ms: 1000 },
      { signature: 'aaa', receipt_time_ms: 3000 },
      { signature: 'aaa', receipt_time_ms: 4000 },
    ];
    expect(computeMutateEffective({
      lastMutatePatch: { recorded_at_ms: 2000 },
      cyclesSinceMutate: 1,
      mutateCooldown: 2,
      signedBuckets: buckets,
      currentSignature: 'aaa',
    })).toBeNull();
    expect(computeMutateEffective({
      lastMutatePatch: { recorded_at_ms: 2000 },
      cyclesSinceMutate: 2,
      mutateCooldown: 2,
      signedBuckets: buckets,
      currentSignature: 'aaa',
    })).toBe(false);
    expect(computeMutateEffective({
      lastMutatePatch: { recorded_at_ms: 2000 },
      cyclesSinceMutate: 2,
      mutateCooldown: 2,
      signedBuckets: [
        { signature: 'aaa', receipt_time_ms: 1000 },
        { signature: 'bbb', receipt_time_ms: 3000 },
      ],
      currentSignature: 'bbb',
    })).toBe(true);
  });
});

describe('starved_streak and mutate_effective in stats', () => {
  it('marks outcome children starved when no receipts across recent cycles', () => {
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        servesGoal: 'guard-memory-audit-v28',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        servesGoal: 'guard-memory-audit-v28',
        recordedAt: '2026-08-05T11:00:00.000Z',
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        servesGoal: 'guard-memory-audit-v28',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [
          { id: 'guard-memory-audit-v28', role: 'guard' },
          { id: 'iterate-skill-with-calibrated-sim-v28', role: 'outcome' },
          { id: 'enforce-deep-analysis-and-switch', role: 'outcome' },
        ],
      },
      deadStreak: 3,
      escalateStreak: 5,
      windowCycles: 8,
    });
    const iterate = stats.goals.find((g) => g.goal_id === 'iterate-skill-with-calibrated-sim-v28');
    const enforce = stats.goals.find((g) => g.goal_id === 'enforce-deep-analysis-and-switch');
    const guard = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(iterate.starved_streak).toBe(3);
    expect(iterate.starved).toBe(true);
    expect(enforce.starved_streak).toBe(3);
    expect(enforce.starved).toBe(true);
    expect(guard.starved_streak).toBe(0);
    expect(guard.starved).toBe(false);
    expect(stats.summary.starved).toBe(2);
  });

  it('ignores historical orphan serves_goal labels for starved escalation', () => {
    const receipts = [
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        servesGoal: 'legacy-orphan-goal-name',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        servesGoal: 'guard-memory-audit-v28',
        recordedAt: '2026-08-05T11:00:00.000Z',
      }),
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        servesGoal: 'guard-memory-audit-v28',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
      escalateStreak: 5,
    });
    const orphan = stats.goals.find((g) => g.goal_id === 'legacy-orphan-goal-name');
    expect(orphan.starved).toBe(false);
    expect(orphan.escalate_eligible).toBe(false);
  });

  it('sets mutate_effective=false after cooldown when signature unchanged', () => {
    const mutateAt = '2026-08-05T08:00:00.000Z';
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        recordedAt: '2026-08-05T07:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [{
        type: 'patched',
        rule_status: 'mutate',
        cycle_id: 'cycle-mutate',
        recorded_at: mutateAt,
        patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      }],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      deadStreak: 3,
      escalateStreak: 5,
      env: { JEA_RULE_FEEDBACK_MUTATE_COOLDOWN: '2' },
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.feedback_state).toBe('dead');
    expect(row.mutate_cooldown).toBe(false);
    expect(row.mutate_effective).toBe(false);
  });

  it('does not let ineffective mutate suppress escalation', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          mutate_effective: false,
          constant_signature_streak: 5,
          constant_keys: [{ key: 'free_text_clean', value: 'key_absent' }],
        }],
      },
      assessment: { rule_status: 'mutate' },
      calibrateResult: {
        status: 'applied',
        applied_patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(1);
    expect(buildRuleFeedbackQuestionText(escalations[0])).toContain('mutate_effective=false');
  });

  it('still skips escalation when mutate_effective is unknown/null and patch applied', () => {
    const escalations = selectRuleFeedbackEscalations({
      ruleFeedbackStats: {
        goals: [{
          goal_id: 'guard-memory-audit-v28',
          escalate_eligible: true,
          mutate_effective: null,
          constant_signature_streak: 5,
        }],
      },
      assessment: { rule_status: 'mutate' },
      calibrateResult: {
        status: 'applied',
        applied_patches: [{ op: 'update_child', child_id: 'guard-memory-audit-v28' }],
      },
      pendingQuestions: [],
    });
    expect(escalations).toHaveLength(0);
  });

  it('formatRuleFeedbackForPrompt lists dead/degraded/starved/mechanized', () => {
    const text = formatRuleFeedbackForPrompt({
      goals: [
        {
          goal_id: 'iterate-skill-with-calibrated-sim-v28',
          feedback_state: 'live',
          starved: true,
          starved_streak: 4,
          constant_signature_streak: 0,
          constant_keys: [],
        },
        {
          goal_id: 'guard-memory-audit-v28',
          feedback_state: 'degraded',
          starved: false,
          starved_streak: 0,
          constant_signature_streak: 6,
          constant_keys: [{ key: 'free_text_clean', value: 'key_absent' }],
          mutate_cooldown: true,
        },
        {
          goal_id: 'monitor-credential-compliance-v28',
          feedback_state: 'live',
          starved: false,
          starved_streak: 0,
          constant_signature_streak: 1,
          constant_keys: [],
          mechanically_maintained: true,
          maintaining_guard_id: 'credential-sync',
          healthy_streak: 3,
        },
        {
          goal_id: 'quiet-live-goal',
          feedback_state: 'live',
          starved: false,
          starved_streak: 0,
          constant_signature_streak: 1,
          constant_keys: [],
        },
      ],
    }, 'zh');
    expect(text).toContain('## Rule Feedback Health');
    expect(text).toContain('iterate-skill-with-calibrated-sim-v28');
    expect(text).toContain('starved_streak=4');
    expect(text).toContain('guard-memory-audit-v28');
    expect(text).toContain('monitor-credential-compliance-v28');
    expect(text).toContain('mechanically_maintained(credential-sync)');
    expect(text).toContain('勿再入队相同探针');
    expect(text).not.toContain('quiet-live-goal');
  });
});

describe('mechanically_maintained and healthy_streak', () => {
  it('buildMechanicalGuardMap indexes enabled serves_goal', () => {
    const map = buildMechanicalGuardMap([
      MEMORY_AUDIT_GUARD,
      { id: 'disabled', enabled: false, action: { serves_goal: 'x' } },
      { id: 'no-goal', enabled: true, action: { type: 'x' } },
    ]);
    expect(map.has('guard-memory-audit-v28')).toBe(true);
    expect(map.get('guard-memory-audit-v28').guard_id).toBe('memory-audit');
    expect(map.has('x')).toBe(false);
  });

  it('computeHealthyStreak counts trailing successes newest-first', () => {
    expect(computeHealthyStreak([
      { success: true },
      { success: true },
      { success: false },
    ])).toBe(2);
    expect(computeHealthyStreak([{ success: false }])).toBe(0);
  });

  it('marks mechanically maintained + success as live despite failure-looking signature', () => {
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        summary: 'typed=37 free_text_clean=KEY_ABSENT audit_ok=true',
        recordedAt: '2026-08-05T12:00:00.000Z',
        success: true,
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        summary: 'typed=37 free_text_clean=KEY_ABSENT audit_ok=true',
        recordedAt: '2026-08-05T11:00:00.000Z',
        success: true,
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        summary: 'typed=37 free_text_clean=KEY_ABSENT audit_ok=true',
        recordedAt: '2026-08-05T10:00:00.000Z',
        success: true,
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      mechanicalGuards: [MEMORY_AUDIT_GUARD],
      deadStreak: 3,
      escalateStreak: 5,
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.mechanically_maintained).toBe(true);
    expect(row.maintaining_guard_id).toBe('memory-audit');
    expect(row.healthy_streak).toBe(3);
    expect(row.feedback_state).toBe('live');
    expect(row.escalate_eligible).toBe(false);
    expect(stats.mechanical_guards).toHaveLength(1);
    expect(stats.mechanical_guards[0].eligible_for_retirement).toBe(true);
    expect(stats.summary.eligible_for_retirement).toBe(1);
  });

  it('keeps failure death path for mechanically maintained goals', () => {
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        summary: 'audit_ok=false free_text_clean=KEY_ABSENT',
        recordedAt: '2026-08-05T12:00:00.000Z',
        success: false,
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        summary: 'audit_ok=false free_text_clean=KEY_ABSENT',
        recordedAt: '2026-08-05T11:00:00.000Z',
        success: false,
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        summary: 'audit_ok=false free_text_clean=KEY_ABSENT',
        recordedAt: '2026-08-05T10:00:00.000Z',
        success: false,
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'guard-memory-audit-v28', role: 'guard' }],
      },
      mechanicalGuards: [MEMORY_AUDIT_GUARD],
      deadStreak: 3,
      escalateStreak: 5,
    });
    const row = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(row.mechanically_maintained).toBe(true);
    expect(row.failure_streak).toBe(3);
    expect(row.feedback_state).toBe('dead');
    expect(stats.mechanical_guards[0].eligible_for_retirement).toBe(false);
  });

  it('exempts starved only when mechanically_maintained, not merely role=guard', () => {
    const receipts = [
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        servesGoal: 'outcome-a',
        recordedAt: '2026-08-05T10:00:00.000Z',
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        servesGoal: 'outcome-a',
        recordedAt: '2026-08-05T11:00:00.000Z',
      }),
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        servesGoal: 'outcome-a',
        recordedAt: '2026-08-05T12:00:00.000Z',
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [
          { id: 'guard-unmaintained', role: 'guard' },
          { id: 'guard-memory-audit-v28', role: 'guard' },
          { id: 'outcome-a', role: 'outcome' },
        ],
      },
      mechanicalGuards: [MEMORY_AUDIT_GUARD],
      deadStreak: 3,
      escalateStreak: 5,
      windowCycles: 8,
    });
    const unmaintained = stats.goals.find((g) => g.goal_id === 'guard-unmaintained');
    const maintained = stats.goals.find((g) => g.goal_id === 'guard-memory-audit-v28');
    expect(unmaintained.mechanically_maintained).toBe(false);
    expect(unmaintained.starved_streak).toBe(3);
    expect(unmaintained.starved).toBe(true);
    expect(maintained.mechanically_maintained).toBe(true);
    expect(maintained.starved_streak).toBe(0);
    expect(maintained.starved).toBe(false);
  });

  it('marks rebirth eligibility when retired goal has failure streak', () => {
    const receipts = [
      makeReceipt({
        id: 'r3',
        cycleId: 'cycle-3',
        summary: 'audit_ok=false',
        recordedAt: '2026-08-05T12:00:00.000Z',
        success: false,
      }),
      makeReceipt({
        id: 'r2',
        cycleId: 'cycle-2',
        summary: 'audit_ok=false',
        recordedAt: '2026-08-05T11:00:00.000Z',
        success: false,
      }),
      makeReceipt({
        id: 'r1',
        cycleId: 'cycle-1',
        summary: 'audit_ok=false',
        recordedAt: '2026-08-05T10:00:00.000Z',
        success: false,
      }),
    ];
    const store = {
      readActionReceipts: () => receipts,
      readGoalEvents: () => [],
    };
    const stats = computeRuleFeedbackStats({
      store,
      activeGoals: {
        id: 'root',
        children: [{ id: 'outcome-only', role: 'outcome' }],
      },
      mechanicalGuards: [MEMORY_AUDIT_GUARD],
      deadStreak: 3,
      escalateStreak: 5,
    });
    expect(stats.mechanical_guards[0].goal_in_active_tree).toBe(false);
    expect(stats.mechanical_guards[0].eligible_for_rebirth).toBe(true);
    expect(stats.summary.eligible_for_rebirth).toBe(1);
  });
});
