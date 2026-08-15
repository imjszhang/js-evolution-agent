import { describe, expect, it } from 'vitest';
import {
  isCycleTtlDisabled,
  isEvidenceWakeEnabled,
  isExecRateOnly,
  isInProcessCycleEnabled,
  isReactorHealthPrimary,
  isSubprocessCycleForced,
} from '../src/evolution/reactor/feature-gates.mjs';

describe('S8 feature-gate defaults', () => {
  it('enables evidence-wake, TTL disable, and rate-only unless explicitly off', () => {
    const unset = {
      JEA_EVIDENCE_WAKE: '',
      JEA_QUEUE_DISABLE_CYCLE_TTL: '',
      JEA_EXEC_RATE_ONLY: '',
      JEA_REACTOR_HEALTH_PRIMARY: '',
      JEA_IN_PROCESS_CYCLE: '',
      JEA_SUBPROCESS_CYCLE: '',
    };
    expect(isEvidenceWakeEnabled(unset)).toBe(true);
    expect(isCycleTtlDisabled(unset)).toBe(true);
    expect(isExecRateOnly(unset)).toBe(true);
    expect(isReactorHealthPrimary(unset)).toBe(true);
    expect(isInProcessCycleEnabled(unset)).toBe(true);
  });

  it('merges partial env overlays onto process.env', () => {
    const previous = process.env.JEA_EVIDENCE_WAKE;
    process.env.JEA_EVIDENCE_WAKE = '0';
    try {
      expect(isEvidenceWakeEnabled({ JEA_TICK_OPEN_CYCLE: '1' })).toBe(false);
      expect(isEvidenceWakeEnabled({ JEA_EVIDENCE_WAKE: '1', JEA_TICK_OPEN_CYCLE: '1' })).toBe(true);
    } finally {
      if (previous == null) delete process.env.JEA_EVIDENCE_WAKE;
      else process.env.JEA_EVIDENCE_WAKE = previous;
    }
  });

  it('honors explicit rollback flags', () => {
    const off = {
      JEA_EVIDENCE_WAKE: '0',
      JEA_QUEUE_DISABLE_CYCLE_TTL: 'false',
      JEA_EXEC_RATE_ONLY: 'off',
      JEA_REACTOR_HEALTH_PRIMARY: '0',
      JEA_IN_PROCESS_CYCLE: '0',
    };
    expect(isEvidenceWakeEnabled(off)).toBe(false);
    expect(isCycleTtlDisabled(off)).toBe(false);
    expect(isExecRateOnly(off)).toBe(false);
    expect(isReactorHealthPrimary(off)).toBe(false);
    expect(isInProcessCycleEnabled(off)).toBe(false);
  });

  it('forces subprocess train when JEA_SUBPROCESS_CYCLE=1', () => {
    expect(isSubprocessCycleForced({ JEA_SUBPROCESS_CYCLE: '1' })).toBe(true);
    expect(isInProcessCycleEnabled({ JEA_SUBPROCESS_CYCLE: '1' })).toBe(false);
    expect(isInProcessCycleEnabled({ JEA_IN_PROCESS_CYCLE: '1', JEA_SUBPROCESS_CYCLE: '1' })).toBe(false);
  });
});
