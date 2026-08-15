import { describe, expect, it } from 'vitest';
import {
  isStepArtifactReconcileEnabled,
  isTickOpenCycleEnabled,
} from '../src/daemon/cycle-dispatch.mjs';

describe('reactor compensation leftovers', () => {
  it('keeps tick open and artifact reconcile off unless env opts in', () => {
    expect(isTickOpenCycleEnabled({ env: {} })).toBe(false);
    expect(isStepArtifactReconcileEnabled({ env: {} })).toBe(false);
    expect(isTickOpenCycleEnabled({ pipeline: 'agent_loop', env: {} })).toBe(false);
    expect(isStepArtifactReconcileEnabled({ pipeline: 'phases', env: {} })).toBe(false);
  });

  it('allows explicit env opt-in', () => {
    expect(isTickOpenCycleEnabled({ env: { JEA_TICK_OPEN_CYCLE: '1' } })).toBe(true);
    expect(isStepArtifactReconcileEnabled({
      env: { JEA_STEP_ARTIFACT_RECONCILE: 'true' },
    })).toBe(true);
  });
});
