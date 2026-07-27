import { describe, expect, it } from 'vitest';
import {
  nextSteps,
  reconcileCycle,
  shouldStartCycleFromTick,
  stepIdempotencyKey,
  eventFromStepCompletion,
  isStepTerminal,
} from '../src/cli/utils/cycle-reducer.mjs';
import { createEmptyCycleState } from '../src/cli/utils/cycle-state.mjs';

function stateWithSteps(cycleId, stepStatuses, meta = {}) {
  const base = createEmptyCycleState({ cycleId, subject: 'alpha', meta });
  for (const [step, status] of Object.entries(stepStatuses)) {
    base.steps[step] = { status, updated_at: '2026-05-30T00:00:00+08:00', error: null };
  }
  return base;
}

describe('cycle-reducer', () => {
  it('enqueues intel on cycle_due', () => {
    const state = createEmptyCycleState({ cycleId: 'cycle-1', subject: 'alpha' });
    const { steps } = nextSteps({ type: 'cycle_due', cycle_id: 'cycle-1' }, state);
    expect(steps.map((s) => s.type)).toEqual(['intel']);
  });

  it('enqueues intel_report and exec after intel_ready with decisions', () => {
    const state = createEmptyCycleState({ cycleId: 'cycle-1', subject: 'alpha' });
    const { steps, markSkipped } = nextSteps({
      type: 'intel_ready',
      cycle_id: 'cycle-1',
      decisions_queued: 2,
    }, state);
    expect(steps.map((s) => s.type)).toEqual(['intel_report', 'exec']);
    expect(markSkipped).toEqual([]);
  });

  it('always enqueues exec after intel_ready even with zero decisions', () => {
    const state = createEmptyCycleState({ cycleId: 'cycle-1', subject: 'alpha' });
    const { steps, markSkipped } = nextSteps({
      type: 'intel_ready',
      cycle_id: 'cycle-1',
      decisions_queued: 0,
    }, state);
    expect(steps.map((s) => s.type)).toEqual(['intel_report', 'exec']);
    expect(markSkipped).toEqual([]);
  });

  it('enqueues verify after exec_done', () => {
    const state = stateWithSteps('cycle-1', { intel: 'done', intel_report: 'done', exec: 'done' });
    const { steps } = nextSteps({ type: 'exec_done', cycle_id: 'cycle-1' }, state);
    expect(steps.map((s) => s.type)).toEqual(['verify']);
  });

  it('skips belief and goals after exec_failed but allows diary when deps met', () => {
    const state = stateWithSteps('cycle-1', {
      intel: 'done',
      intel_report: 'done',
      exec: 'failed',
    });
    const { markSkipped } = nextSteps({ type: 'exec_failed', cycle_id: 'cycle-1' }, state);
    expect(markSkipped).toContain('belief_update');
    expect(markSkipped).toContain('goals_assess');
  });

  it('skips goals assess when report not ready on verify_done', () => {
    const state = stateWithSteps('cycle-1', {
      intel: 'done',
      intel_report: 'failed',
      exec: 'done',
      verify: 'done',
    }, { intel_report_ready: false });
    const { markSkipped } = nextSteps({ type: 'verify_done', cycle_id: 'cycle-1' }, state);
    expect(markSkipped).toContain('goals_assess');
  });

  it('respects skip env flags via options', () => {
    const state = stateWithSteps('cycle-1', {
      intel: 'done',
      intel_report: 'done',
      exec: 'done',
      verify: 'done',
    }, { intel_report_ready: true });
    const { steps, markSkipped } = nextSteps(
      { type: 'verify_done', cycle_id: 'cycle-1', intel_report_ready: true },
      state,
      { skipBeliefUpdate: true, skipGoalsAssess: true },
    );
    expect(steps.map((s) => s.type)).not.toContain('belief_update');
    expect(steps.map((s) => s.type)).not.toContain('goals_assess');
    expect(markSkipped).toContain('belief_update');
    expect(markSkipped).toContain('goals_assess');
  });

  it('does not enqueue when cycle is closed', () => {
    const state = stateWithSteps('cycle-1', { diary: 'done' });
    state.status = 'closed';
    const { steps } = nextSteps({ type: 'verify_done', cycle_id: 'cycle-1' }, state);
    expect(steps).toEqual([]);
  });

  it('shouldStartCycleFromTick respects open cycles and pending tasks', () => {
    expect(shouldStartCycleFromTick({ openCycles: [] })).toBe(true);
    expect(shouldStartCycleFromTick({ openCycles: [{ cycle_id: 'c1' }] })).toBe(false);
    expect(shouldStartCycleFromTick({ openCycles: [], throttle: true })).toBe(false);
    expect(shouldStartCycleFromTick({ openCycles: [], pendingTaskCount: 1 })).toBe(false);
  });

  it('builds stable step idempotency keys', () => {
    expect(stepIdempotencyKey('alpha', 'cycle-1', 'intel')).toBe('alpha:cycle-1:intel');
  });

  it('maps step completion to events', () => {
    expect(eventFromStepCompletion('exec', { status: 'failed' }, { cycle_id: 'c1' }).type).toBe('exec_failed');
    expect(eventFromStepCompletion('diary', { status: 'done' }, { cycle_id: 'c1' }).type).toBe('cycle_closed');
  });

  it('reconcileCycle fills missing verify after exec done', () => {
    const state = stateWithSteps('cycle-1', {
      intel: 'done',
      intel_report: 'done',
      exec: 'done',
    }, { decisions_queued: 1 });
    const { steps } = reconcileCycle(state);
    expect(steps.some((s) => s.type === 'verify')).toBe(true);
  });

  it('reconcileCycle enqueues exec when intel and intel_report are done but exec is pending', () => {
    const state = stateWithSteps('cycle-1', {
      intel: 'done',
      intel_report: 'done',
      exec: 'pending',
    }, { decisions_queued: 1, intel_report_ready: true });
    const { steps } = reconcileCycle(state);
    expect(steps.map((s) => s.type)).toEqual(['exec']);
  });

  it('isStepTerminal covers done failed skipped', () => {
    const state = stateWithSteps('cycle-1', { intel: 'skipped' });
    expect(isStepTerminal(state, 'intel')).toBe(true);
  });

  it('agent_loop pipeline enqueues agent_loop on cycle_due and skips intel/intel_report', () => {
    const state = createEmptyCycleState({
      cycleId: 'cycle-loop',
      subject: 'alpha',
      meta: { pipeline: 'agent_loop' },
    });
    expect(state.steps.agent_loop).toBeTruthy();
    expect(state.steps.exec).toBeTruthy();
    expect(state.steps.intel).toBeUndefined();
    expect(state.steps.intel_report).toBeUndefined();
    const { steps } = nextSteps({ type: 'cycle_due', cycle_id: 'cycle-loop' }, state);
    expect(steps.map((s) => s.type)).toEqual(['agent_loop']);
  });

  it('agent_loop_done enqueues exec', () => {
    const state = stateWithSteps('cycle-loop', { agent_loop: 'done', exec: 'pending' }, { pipeline: 'agent_loop' });
    const { steps } = nextSteps({ type: 'agent_loop_done', cycle_id: 'cycle-loop' }, state);
    expect(steps.map((s) => s.type)).toEqual(['exec']);
  });

  it('maps agent_loop completion events', () => {
    expect(eventFromStepCompletion('agent_loop', { status: 'done' }, { cycle_id: 'c1' }).type)
      .toBe('agent_loop_done');
    expect(eventFromStepCompletion('agent_loop', { status: 'failed' }, { cycle_id: 'c1' }).type)
      .toBe('agent_loop_failed');
  });

  it('reconcileCycle for agent_loop fills exec after agent_loop done', () => {
    const state = stateWithSteps('cycle-loop', {
      agent_loop: 'done',
      exec: 'pending',
      verify: 'pending',
    }, { pipeline: 'agent_loop', intel_report_ready: true });
    const { steps } = reconcileCycle(state);
    expect(steps.some((s) => s.type === 'exec')).toBe(true);
    expect(steps.some((s) => s.type === 'verify')).toBe(false);
    expect(steps.some((s) => s.type === 'intel')).toBe(false);
  });
});
