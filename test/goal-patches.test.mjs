import { describe, expect, it } from 'vitest';
import {
  applyGoalPatches,
  buildPartialPatchApply,
  checkGoalInvariants,
  classifyChildRole,
  gatePatchForAutoApply,
  normalizeGoalPatches,
  repairFlatGoalTreePatches,
  selectPatchesForApply,
  validateGoalPatch,
} from '../src/intelligence/goal-patches.mjs';
import { resolveGoalCalibratePolicy } from '../src/intelligence/goal-calibrate-policy.mjs';

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
    expect(next.children.find((c) => c.id === 'outcome-b').role).toBe('outcome');
  });

  it('update_child role=outcome persists and classifyChildRole reads explicit role', () => {
    const tree = {
      ...rootGoal,
      children: [{
        id: 'mislabeled',
        name: 'Quiet outcome',
        intent: 'ship a measurable capability increment',
        good_signal: 'capability improves',
        bad_signal: 'no movement',
        role: 'guard',
        children: [],
      }],
    };
    const patch = normalizeGoalPatches([{
      op: 'update_child',
      child_id: 'mislabeled',
      fields: { role: 'outcome' },
    }])[0];
    expect(validateGoalPatch(patch, tree).valid).toBe(true);
    const next = applyGoalPatches(tree, [patch]);
    const child = next.children.find((c) => c.id === 'mislabeled');
    expect(child.role).toBe('outcome');
    expect(classifyChildRole(child)).toBe('outcome');
  });

  it('rejects invalid update_child role values', () => {
    for (const role of ['probe', '', '  ']) {
      const patch = normalizeGoalPatches([{
        op: 'update_child',
        child_id: 'outcome-a',
        fields: { role },
      }])[0];
      if (!patch) {
        expect(role.trim()).toBe('');
        continue;
      }
      const v = validateGoalPatch(patch, rootGoal);
      expect(v.valid).toBe(false);
      expect(v.reason).toBe('invalid_patch_field');
    }
  });

  it('add_child preserves role on storage and drops invalid role', () => {
    const withRole = normalizeGoalPatches([{
      op: 'add_child',
      parent_id: null,
      child: {
        id: 'outcome-quiet',
        name: 'Quiet',
        intent: 'ship a measurable capability increment',
        good_signal: 'g',
        bad_signal: 'b',
        role: 'outcome',
        children: [],
      },
    }])[0];
    const next = applyGoalPatches(rootGoal, [withRole]);
    expect(next.children.find((c) => c.id === 'outcome-quiet').role).toBe('outcome');

    const badRole = normalizeGoalPatches([{
      op: 'add_child',
      parent_id: null,
      child: {
        id: 'weird-role',
        name: 'Weird',
        intent: 'credential compliance each cycle',
        good_signal: 'g',
        bad_signal: 'b',
        role: 'probe',
        children: [],
      },
    }])[0];
    const nextBad = applyGoalPatches(rootGoal, [badRole]);
    expect(nextBad.children.find((c) => c.id === 'weird-role').role).toBeUndefined();
  });

  it('coerces add_child parent_id from child id to root sibling', () => {
    const patch = normalizeGoalPatches([{
      op: 'add_child',
      parent_id: 'outcome-a',
      child: {
        id: 'guard-switch',
        name: 'Switch guard',
        intent: 'block publish after two failures',
        good_signal: 'g',
        bad_signal: 'b',
        role: 'guard',
        children: [],
      },
    }])[0];
    const { patches, repairs } = repairFlatGoalTreePatches(rootGoal, [patch]);
    expect(repairs).toHaveLength(1);
    expect(repairs[0].from_parent_id).toBe('outcome-a');
    expect(patches[0].parent_id).toBeNull();
    expect(validateGoalPatch(patches[0], rootGoal).valid).toBe(true);
    const next = applyGoalPatches(rootGoal, patches);
    expect(next.children.map((c) => c.id)).toContain('guard-switch');
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

  it('requires at least one outcome child after remove under strict policy', () => {
    const strict = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });
    const patches = normalizeGoalPatches([
      { op: 'remove_child', child_id: 'outcome-a' },
      { op: 'remove_child', child_id: 'guard-a' },
    ]);
    const next = applyGoalPatches(rootGoal, patches);
    expect(checkGoalInvariants(next, strict).ok).toBe(false);
    expect(checkGoalInvariants(next).ok).toBe(true);
  });

  it('gates auto-apply by op and confidence (balanced)', () => {
    const addPatch = { op: 'add_child', child: { id: 'new' } };
    const updatePatch = { op: 'update_child', child_id: 'outcome-a', fields: { intent: 'x' } };
    expect(gatePatchForAutoApply(addPatch, { status: 'refine', confidence: 'medium' }).allowed).toBe(false);
    expect(gatePatchForAutoApply(addPatch, { status: 'refine', confidence: 'high' }).allowed).toBe(true);
    expect(gatePatchForAutoApply(updatePatch, { status: 'refine', confidence: 'medium' }).allowed).toBe(true);
    expect(gatePatchForAutoApply(updatePatch, { status: 'keep', confidence: 'high' }).allowed).toBe(false);
  });

  it('selectPatchesForApply liberal allows medium add_child', () => {
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
    const liberal = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'liberal' });
    const { applicable, skipped } = selectPatchesForApply(patches, {
      status: 'refine',
      confidence: 'medium',
    }, liberal);
    expect(applicable).toHaveLength(2);
    expect(skipped).toHaveLength(0);

    const strict = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });
    const strictResult = selectPatchesForApply(patches, {
      status: 'refine',
      confidence: 'medium',
    }, strict);
    expect(strictResult.applicable).toHaveLength(1);
    expect(strictResult.skipped[0].reason).toBe('confidence_not_high');
  });

  it('buildPartialPatchApply liberal allows three outcome children', () => {
    const liberal = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'liberal' });
    const patches = normalizeGoalPatches([
      {
        op: 'add_child',
        child: {
          id: 'outcome-b',
          name: 'B',
          intent: 'rank baseline',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
      {
        op: 'add_child',
        child: {
          id: 'outcome-c',
          name: 'C',
          intent: 'publish pressure',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
    ]);
    const built = buildPartialPatchApply(rootGoal, patches, {
      status: 'refine',
      confidence: 'high',
    }, liberal);
    expect(built.applicable).toHaveLength(2);
    expect(built.preview.children).toHaveLength(4);
  });

  it('buildPartialPatchApply strict rejects batch over outcome cap', () => {
    const strict = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });
    const patches = normalizeGoalPatches([
      {
        op: 'add_child',
        child: {
          id: 'outcome-b',
          name: 'B',
          intent: 'rank',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
      {
        op: 'add_child',
        child: {
          id: 'outcome-c',
          name: 'C',
          intent: 'publish',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      },
    ]);
    const built = buildPartialPatchApply(rootGoal, patches, {
      status: 'refine',
      confidence: 'high',
    }, strict);
    expect(built.applicable).toHaveLength(0);
    expect(built.invariant?.reason).toBe('invariant_fail');
  });
});
