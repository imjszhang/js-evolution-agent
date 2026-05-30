import { describe, expect, it } from 'vitest';
import {
  applyGoalPatches,
  checkGoalInvariants,
  classifyChildRole,
  gatePatchForAutoApply,
  normalizeGoalPatches,
  selectPatchesForAutoApply,
  validateGoalPatch,
} from '../src/intelligence/goal-patches.mjs';

const rootGoal = {
  id: 'main',
  name: 'Main',
  intent: 'Win more',
  good_signal: 'rank up',
  bad_signal: 'stall',
  children: [
    {
      id: 'guard-a',
      name: 'Guard',
      intent: 'credential compliance each cycle',
      good_signal: 'ok',
      bad_signal: 'leak',
      children: [],
    },
    {
      id: 'outcome-a',
      name: 'Iterate',
      intent: 'publish and improve rank each cycle',
      good_signal: 'rank +5',
      bad_signal: 'no publish',
      children: [],
    },
  ],
};

describe('goal-patches', () => {
  it('classifies child roles from keywords', () => {
    expect(classifyChildRole({ id: 'x', intent: 'monitor credentials' })).toBe('guard');
    expect(classifyChildRole({ id: 'y', intent: 'improve rank after publish' })).toBe('outcome');
    expect(classifyChildRole({ id: 'z', intent: 'x', role: 'outcome' })).toBe('outcome');
  });

  it('applies add, update, and remove patches in order', () => {
    const patches = normalizeGoalPatches([
      { op: 'remove_child', child_id: 'guard-a' },
      {
        op: 'add_child',
        parent_id: null,
        child: {
          id: 'outcome-b',
          name: 'Outcome B',
          intent: 'simulate and publish for rank',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
      {
        op: 'update_child',
        child_id: 'outcome-a',
        fields: { intent: 'updated outcome intent' },
      },
    ]);
    const next = applyGoalPatches(rootGoal, patches);
    expect(next.children.map((c) => c.id).sort()).toEqual(['outcome-a', 'outcome-b']);
    expect(next.children.find((c) => c.id === 'outcome-a').intent).toBe('updated outcome intent');
  });

  it('rejects duplicate child id on add', () => {
    const patch = normalizeGoalPatches([{
      op: 'add_child',
      parent_id: null,
      child: {
        id: 'outcome-a',
        name: 'Dup',
        intent: 'rank',
        good_signal: 'g',
        bad_signal: 'b',
        role: 'outcome',
      },
    }])[0];
    expect(validateGoalPatch(patch, rootGoal).valid).toBe(false);
  });

  it('requires at least one outcome child after remove', () => {
    const patches = normalizeGoalPatches([
      { op: 'remove_child', child_id: 'outcome-a' },
      { op: 'remove_child', child_id: 'guard-a' },
    ]);
    const next = applyGoalPatches(rootGoal, patches);
    expect(checkGoalInvariants(next).ok).toBe(false);
  });

  it('gates auto-apply by op and confidence (balanced)', () => {
    const addPatch = { op: 'add_child', child: { id: 'new' } };
    const updatePatch = { op: 'update_child', child_id: 'outcome-a', fields: { intent: 'x' } };
    expect(gatePatchForAutoApply(addPatch, { status: 'refine', confidence: 'medium' }).allowed).toBe(false);
    expect(gatePatchForAutoApply(addPatch, { status: 'refine', confidence: 'high' }).allowed).toBe(true);
    expect(gatePatchForAutoApply(updatePatch, { status: 'refine', confidence: 'medium' }).allowed).toBe(true);
    expect(gatePatchForAutoApply(updatePatch, { status: 'keep', confidence: 'high' }).allowed).toBe(false);
  });

  it('selectPatchesForAutoApply splits applicable and skipped', () => {
    const patches = normalizeGoalPatches([
      { op: 'update_child', child_id: 'outcome-a', fields: { intent: 'new intent text here' } },
      {
        op: 'add_child',
        parent_id: null,
        child: {
          id: 'outcome-c',
          name: 'C',
          intent: 'rank publish',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
    ]);
    const { applicable, skipped } = selectPatchesForAutoApply(patches, {
      status: 'refine',
      confidence: 'medium',
    });
    expect(applicable).toHaveLength(1);
    expect(applicable[0].op).toBe('update_child');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('confidence_not_high');
  });
});
