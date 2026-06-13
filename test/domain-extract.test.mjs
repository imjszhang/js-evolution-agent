import { describe, expect, it } from 'vitest';
import {
  assessActiveGoals,
  autoCalibrateGoals,
} from '../src/domain/cognition/index.mjs';
import {
  runSingleCycle,
  runSingleStep,
} from '../src/evolution/runner.mjs';

describe('domain extraction facades', () => {
  it('exposes cognition and evolution runner entrypoints outside cli edge', () => {
    expect(typeof assessActiveGoals).toBe('function');
    expect(typeof autoCalibrateGoals).toBe('function');
    expect(typeof runSingleCycle).toBe('function');
    expect(typeof runSingleStep).toBe('function');
  });
});
