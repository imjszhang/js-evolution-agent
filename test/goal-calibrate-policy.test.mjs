import { describe, expect, it } from 'vitest';
import {
  getGoalCalibrateMode,
  isGoalAutoApplyEnabled,
  meetsFullReplaceConfidence,
  resolveGoalCalibratePolicy,
  summarizeGoalCalibratePolicy,
} from '../src/intelligence/goal-calibrate-policy.mjs';

describe('goal-calibrate-policy', () => {
  it('defaults to liberal mode', () => {
    expect(getGoalCalibrateMode({})).toBe('liberal');
    const p = resolveGoalCalibratePolicy({});
    expect(p.mode).toBe('liberal');
    expect(p.partialPatchApply).toBe(true);
    expect(p.fallbackProposedGoal).toBe(true);
    expect(p.enforceOutcomeInvariants).toBe(false);
  });

  it('strict mode restores conservative gates', () => {
    const p = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });
    expect(p.mode).toBe('strict');
    expect(p.enforceOutcomeInvariants).toBe(true);
    expect(p.maxOutcomeChildren).toBe(2);
    expect(p.minOutcomeChildren).toBe(1);
    expect(p.partialPatchApply).toBe(false);
    expect(p.fallbackProposedGoal).toBe(false);
    expect(p.fullReplaceMinConfidence).toBe('high');
  });

  it('JEA_GOAL_MAX_OUTCOME_CHILDREN overrides cap in liberal mode', () => {
    const p = resolveGoalCalibratePolicy({
      JEA_GOAL_CALIBRATE_MODE: 'liberal',
      JEA_GOAL_MAX_OUTCOME_CHILDREN: '3',
    });
    expect(p.maxOutcomeChildren).toBe(3);
    expect(p.enforceOutcomeInvariants).toBe(true);
  });

  it('JEA_GOAL_AUTO_APPLY=0 disables apply', () => {
    expect(isGoalAutoApplyEnabled({ JEA_GOAL_AUTO_APPLY: '0' })).toBe(false);
    expect(isGoalAutoApplyEnabled({})).toBe(true);
  });

  it('meetsFullReplaceConfidence by policy', () => {
    const liberal = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'liberal' });
    const strict = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });
    expect(meetsFullReplaceConfidence('medium', liberal)).toBe(true);
    expect(meetsFullReplaceConfidence('low', liberal)).toBe(false);
    expect(meetsFullReplaceConfidence('medium', strict)).toBe(false);
    expect(meetsFullReplaceConfidence('high', strict)).toBe(true);
  });

  it('summarizeGoalCalibratePolicy is non-empty', () => {
    expect(summarizeGoalCalibratePolicy()).toMatch(/liberal/);
  });
});
