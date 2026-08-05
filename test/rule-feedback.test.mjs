import { describe, expect, it } from 'vitest';
import {
  buildRuleFeedbackQuestionText,
  computeInformationGain,
  computeRuleFeedbackStats,
  computeSignatureStreak,
  extractResultSignature,
  isGuardGoal,
  selectRuleFeedbackEscalations,
} from '../src/intelligence/rule-feedback.mjs';

function makeReceipt({
  id = 'receipt-1',
  cycleId = 'cycle-1',
  servesGoal = 'guard-memory-audit-v28',
  summary = 'typed=35 free_text_clean=KEY_ABSENT audit_ok=true',
} = {}) {
  return {
    id,
    cycle_id: cycleId,
    action_type: 'agent_run',
    action: { type: 'agent_run', serves_goal: servesGoal },
    result: { summary, status: 'completed', success: true },
  };
}

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
  });
});
