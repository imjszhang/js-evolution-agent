import { describe, expect, it } from 'vitest';
import {
  isStepArtifactReconcileEnabled,
  isTickOpenCycleEnabled,
} from '../src/daemon/reactor-compensation-gates.mjs';

describe('reactor compensation gates', () => {
  it('disables tick open and artifact reconcile for reactor by default', () => {
    expect(isTickOpenCycleEnabled({ pipeline: 'reactor', env: {} })).toBe(false);
    expect(isStepArtifactReconcileEnabled({ pipeline: 'reactor', env: {} })).toBe(false);
    expect(isTickOpenCycleEnabled({ pipeline: null, env: {} })).toBe(false);
    expect(isStepArtifactReconcileEnabled({ pipeline: null, env: {} })).toBe(false);
  });

  it('keeps train compensation for agent_loop and phases', () => {
    expect(isTickOpenCycleEnabled({ pipeline: 'agent_loop', env: {} })).toBe(true);
    expect(isStepArtifactReconcileEnabled({ pipeline: 'agent_loop', env: {} })).toBe(true);
    expect(isTickOpenCycleEnabled({ pipeline: 'phases', env: {} })).toBe(true);
    expect(isStepArtifactReconcileEnabled({ pipeline: 'phases', env: {} })).toBe(true);
  });

  it('allows env opt-in on reactor', () => {
    expect(isTickOpenCycleEnabled({ pipeline: 'reactor', env: { JEA_TICK_OPEN_CYCLE: '1' } })).toBe(true);
    expect(isStepArtifactReconcileEnabled({
      pipeline: 'reactor',
      env: { JEA_STEP_ARTIFACT_RECONCILE: 'true' },
    })).toBe(true);
  });
});
