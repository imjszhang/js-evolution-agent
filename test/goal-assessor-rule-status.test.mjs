import { describe, expect, it } from 'vitest';
import { parseGoalAssessment } from '../src/intelligence/goal-assessor.mjs';

describe('goal assessor rule status', () => {
  it('preserves legacy status while parsing rule_status', () => {
    const parsed = parseGoalAssessment(JSON.stringify({
      status: 'keep',
      rule_status: 'mutate',
      confidence: 'medium',
      reason: 'old law failed but storage remains compatible',
      evidence_refs: [{ type: 'intel_report', id: 'cycle-x', ref: 'intel_report:cycle-x' }],
      goal_patches: [],
      proposed_goal: null,
      risk: 'low',
    }));

    expect(parsed.status).toBe('keep');
    expect(parsed.rule_status).toBe('mutate');
    expect(parsed.confidence).toBe('medium');
  });

  it('maps direct new status outputs into legacy assessment status', () => {
    const parsed = parseGoalAssessment(JSON.stringify({
      status: 'learn',
      confidence: 'high',
      reason: 'feedback is thin',
      evidence_refs: [{ type: 'intel_report', id: 'cycle-y', ref: 'intel_report:cycle-y' }],
      goal_patches: [],
      proposed_goal: null,
      risk: 'low',
    }));

    expect(parsed.status).toBe('refine');
    expect(parsed.rule_status).toBe('learn');
  });
});
