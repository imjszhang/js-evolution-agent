/** Goal tree patch operations for incremental child goal calibration. */

export const GOAL_PATCH_OPS = new Set(['add_child', 'update_child', 'remove_child']);
export const GOAL_CHILD_ROLES = new Set(['outcome', 'guard']);
export const UPDATE_CHILD_ALLOWED_FIELDS = new Set(['intent', 'good_signal', 'bad_signal']);
export const MAX_OUTCOME_CHILDREN = 2;

const REQUIRED_GOAL_STRING_FIELDS = ['id', 'name', 'intent', 'good_signal', 'bad_signal'];

const OUTCOME_KEYWORDS = [
  'rank', 'matchcount', 'win rate', 'winrate', '胜率', '排名', '发布', 'publish',
  'simulate', '模拟', 'replay', '竞技', 'performance', 'improve', '提升',
];
const GUARD_KEYWORDS = [
  'credential', '凭据', 'audit', '审计', 'compliance', '合规', 'memory', '记忆',
  'probe', '探针', 'leak', '泄露', 'env', 'guard', '守护',
];

export function validateGoalShape(goal, path = 'goal') {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
    return { valid: false, reason: 'invalid_proposed_goal', detail: `${path} must be an object` };
  }
  for (const field of REQUIRED_GOAL_STRING_FIELDS) {
    if (typeof goal[field] !== 'string' || !goal[field].trim()) {
      return { valid: false, reason: 'invalid_proposed_goal', detail: `${path}.${field} must be a non-empty string` };
    }
  }
  if (!Array.isArray(goal.children)) {
    return { valid: false, reason: 'invalid_proposed_goal', detail: `${path}.children must be an array` };
  }
  for (let i = 0; i < goal.children.length; i += 1) {
    const child = validateGoalShape(goal.children[i], `${path}.children[${i}]`);
    if (!child.valid) return child;
  }
  return { valid: true, reason: null, detail: null };
}

export function flattenGoalIds(goals) {
  if (!goals) return new Set();
  const ids = new Set();
  const visit = (node) => {
    if (!node?.id) return;
    ids.add(node.id);
    for (const child of node.children || []) visit(child);
  };
  visit(goals);
  return ids;
}

export function classifyChildRole(child) {
  const explicit = child?.role;
  if (explicit === 'outcome' || explicit === 'guard') return explicit;
  const hay = `${child?.name || ''} ${child?.intent || ''} ${child?.id || ''}`.toLowerCase();
  if (GUARD_KEYWORDS.some((k) => hay.includes(k.toLowerCase()))) return 'guard';
  if (OUTCOME_KEYWORDS.some((k) => hay.includes(k.toLowerCase()))) return 'outcome';
  return 'guard';
}

function stripChildForStorage(child) {
  const { role, ...rest } = child;
  return {
    ...rest,
    children: Array.isArray(rest.children) ? rest.children : [],
  };
}

export function normalizeGoalPatch(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const op = patch.op;
  if (!GOAL_PATCH_OPS.has(op)) return null;
  const normalized = { op, reason: patch.reason != null ? String(patch.reason) : null };
  if (op === 'add_child') {
    const parentId = patch.parent_id ?? null;
    if (parentId != null && typeof parentId !== 'string') return null;
    normalized.parent_id = parentId;
    if (!patch.child || typeof patch.child !== 'object') return null;
    normalized.child = {
      ...patch.child,
      children: Array.isArray(patch.child.children) ? patch.child.children : [],
    };
    return normalized;
  }
  if (op === 'update_child') {
    if (!patch.child_id || typeof patch.child_id !== 'string') return null;
    normalized.child_id = patch.child_id;
    const fields = patch.fields && typeof patch.fields === 'object' ? patch.fields : {};
    normalized.fields = {};
    for (const key of Object.keys(fields)) {
      if (UPDATE_CHILD_ALLOWED_FIELDS.has(key)) {
        normalized.fields[key] = String(fields[key]);
      }
    }
    if (!Object.keys(normalized.fields).length) return null;
    return normalized;
  }
  if (op === 'remove_child') {
    if (!patch.child_id || typeof patch.child_id !== 'string') return null;
    normalized.child_id = patch.child_id;
    return normalized;
  }
  return null;
}

export function normalizeGoalPatches(patches) {
  if (!Array.isArray(patches)) return [];
  return patches.map(normalizeGoalPatch).filter(Boolean);
}

/**
 * Active goals are a flat tree: children live only under the root.
 * Assessors often set parent_id to an existing child id; coerce to root sibling.
 */
export function repairFlatGoalTreePatches(activeGoals, patches) {
  if (!Array.isArray(patches) || !patches.length) {
    return { patches: patches ?? [], repairs: [] };
  }
  const rootId = activeGoals?.id ?? null;
  const childIds = new Set((activeGoals?.children || []).map((c) => c.id));
  const repairs = [];
  const repaired = patches.map((patch) => {
    if (patch?.op !== 'add_child') return patch;
    const parentId = patch.parent_id ?? null;
    if (parentId == null || parentId === rootId) return patch;
    if (!childIds.has(parentId)) return patch;
    repairs.push({
      op: patch.op,
      child_id: patch.child?.id ?? null,
      from_parent_id: parentId,
      to_parent_id: null,
      reason: 'flat_goal_tree_child_parent_coerced',
    });
    return { ...patch, parent_id: null };
  });
  return { patches: repaired, repairs };
}

export function validateGoalPatch(patch, activeGoals) {
  if (!patch?.op) {
    return { valid: false, reason: 'invalid_patch', detail: 'missing op' };
  }
  const rootId = activeGoals?.id ?? null;
  const childIds = new Set((activeGoals?.children || []).map((c) => c.id));

  if (patch.op === 'add_child') {
    if (patch.parent_id != null && patch.parent_id !== rootId) {
      return { valid: false, reason: 'invalid_patch', detail: 'parent_id must be null or root goal id' };
    }
    const shape = validateGoalShape(patch.child, 'patch.child');
    if (!shape.valid) return shape;
    if (childIds.has(patch.child.id)) {
      return { valid: false, reason: 'duplicate_child_id', detail: patch.child.id };
    }
    const allIds = flattenGoalIds(activeGoals);
    if (allIds.has(patch.child.id)) {
      return { valid: false, reason: 'duplicate_child_id', detail: patch.child.id };
    }
    return { valid: true, reason: null, detail: null };
  }

  if (patch.op === 'update_child') {
    if (!childIds.has(patch.child_id)) {
      return { valid: false, reason: 'child_not_found', detail: patch.child_id };
    }
    for (const key of Object.keys(patch.fields || {})) {
      if (!UPDATE_CHILD_ALLOWED_FIELDS.has(key)) {
        return { valid: false, reason: 'invalid_patch_field', detail: key };
      }
      if (typeof patch.fields[key] !== 'string' || !patch.fields[key].trim()) {
        return { valid: false, reason: 'invalid_patch_field', detail: `${key} must be non-empty` };
      }
    }
    return { valid: true, reason: null, detail: null };
  }

  if (patch.op === 'remove_child') {
    if (!childIds.has(patch.child_id)) {
      return { valid: false, reason: 'child_not_found', detail: patch.child_id };
    }
    return { valid: true, reason: null, detail: null };
  }

  return { valid: false, reason: 'invalid_patch', detail: 'unknown op' };
}

export function countOutcomeChildren(goals) {
  let n = 0;
  for (const child of goals?.children || []) {
    if (classifyChildRole(child) === 'outcome') n += 1;
  }
  return n;
}

export function checkGoalInvariants(nextGoals, policy = null) {
  const shape = validateGoalShape(nextGoals);
  if (!shape.valid) return { ok: false, reason: shape.reason, detail: shape.detail };

  const enforce = policy?.enforceOutcomeInvariants === true;
  if (!enforce) return { ok: true, reason: null, detail: null };

  const minOutcomes = policy?.minOutcomeChildren ?? 1;
  const maxOutcomes = policy?.maxOutcomeChildren ?? MAX_OUTCOME_CHILDREN;
  const outcomeCount = countOutcomeChildren(nextGoals);

  if (outcomeCount < minOutcomes) {
    return {
      ok: false,
      reason: 'invariant_fail',
      detail: minOutcomes === 1
        ? 'at least one outcome child required'
        : `at least ${minOutcomes} outcome children required`,
    };
  }
  if (maxOutcomes != null && outcomeCount > maxOutcomes) {
    return {
      ok: false,
      reason: 'invariant_fail',
      detail: `at most ${maxOutcomes} outcome children`,
    };
  }
  return { ok: true, reason: null, detail: null };
}

const PATCH_ORDER = { remove_child: 0, update_child: 1, add_child: 2 };

export function sortPatchesForApply(patches) {
  return [...patches].sort((a, b) => (PATCH_ORDER[a.op] ?? 9) - (PATCH_ORDER[b.op] ?? 9));
}

export function applyGoalPatches(activeGoals, patches) {
  const sorted = sortPatchesForApply(patches);
  let next = JSON.parse(JSON.stringify(activeGoals));
  if (!Array.isArray(next.children)) next.children = [];

  for (const patch of sorted) {
    if (patch.op === 'remove_child') {
      next.children = next.children.filter((c) => c.id !== patch.child_id);
    } else if (patch.op === 'update_child') {
      next.children = next.children.map((c) => {
        if (c.id !== patch.child_id) return c;
        return { ...c, ...patch.fields };
      });
    } else if (patch.op === 'add_child') {
      next.children = [...next.children, stripChildForStorage(patch.child)];
    }
  }
  return next;
}

/** Strict gates: add/remove need refine+high; update_child allows medium+. */
export function gatePatchForAutoApply(patch, assessment, policy = null) {
  const actionable = policy?.actionableStatuses ?? new Set(['refine']);
  const status = assessment?.status;
  if (!assessment || !actionable.has(status)) {
    return { allowed: false, reason: 'status_not_actionable' };
  }

  if (policy?.mode === 'liberal' || policy?.allowPatchOnMedium) {
    const conf = assessment.confidence ?? 'low';
    if (conf === 'low') return { allowed: false, reason: 'confidence_not_medium' };
    return { allowed: true, reason: null };
  }

  if (status !== 'refine') {
    return { allowed: false, reason: 'status_not_refine' };
  }
  const conf = assessment.confidence ?? 'low';
  if (patch.op === 'update_child') {
    if (conf === 'low') return { allowed: false, reason: 'confidence_not_medium' };
    return { allowed: true, reason: null };
  }
  if (patch.op === 'add_child' || patch.op === 'remove_child') {
    if (conf !== 'high') return { allowed: false, reason: 'confidence_not_high' };
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: 'invalid_patch' };
}

export function selectPatchesForApply(patches, assessment, policy = null) {
  const applicable = [];
  const skipped = [];
  for (const patch of patches) {
    const gate = gatePatchForAutoApply(patch, assessment, policy);
    if (gate.allowed) applicable.push(patch);
    else skipped.push({ patch, reason: gate.reason });
  }
  return { applicable, skipped };
}

/** @deprecated use selectPatchesForApply */
export function selectPatchesForAutoApply(patches, assessment) {
  return selectPatchesForApply(patches, assessment, { mode: 'strict', actionableStatuses: new Set(['refine']) });
}

/**
 * Build applicable patch set: full batch (strict) or per-patch accumulation (liberal partial).
 */
export function buildPartialPatchApply(previousGoal, patches, assessment, policy = null) {
  const warnings = [];
  const repaired = repairFlatGoalTreePatches(previousGoal, patches);
  patches = repaired.patches;
  for (const repair of repaired.repairs) {
    warnings.push(`coerced add_child parent_id ${repair.from_parent_id} → root (flat goal tree)`);
  }
  const gateResult = selectPatchesForApply(patches, assessment, policy);
  let gateSkipped = gateResult.skipped;
  let candidatePatches = gateResult.applicable;

  if (!policy?.partialPatchApply) {
    if (!candidatePatches.length) {
      return { applicable: [], skipped: gateSkipped, preview: null, warnings };
    }
    for (const patch of candidatePatches) {
      const v = validateGoalPatch(patch, previousGoal);
      if (!v.valid) {
        return {
          applicable: [],
          skipped: [...gateSkipped, { patch, reason: v.reason, detail: v.detail }],
          preview: null,
          warnings,
        };
      }
    }
    const preview = applyGoalPatches(previousGoal, candidatePatches);
    const invariants = checkGoalInvariants(preview, policy);
    if (!invariants.ok) {
      return {
        applicable: [],
        skipped: gateSkipped,
        preview: null,
        warnings,
        invariant: invariants,
      };
    }
    return { applicable: candidatePatches, skipped: gateSkipped, preview, warnings };
  }

  const sorted = sortPatchesForApply(candidatePatches);
  const applicable = [];
  const skipped = [...gateSkipped];
  let preview = JSON.parse(JSON.stringify(previousGoal));
  if (!Array.isArray(preview.children)) preview.children = [];

  for (const patch of sorted) {
    const v = validateGoalPatch(patch, preview);
    if (!v.valid) {
      skipped.push({ patch, reason: v.reason, detail: v.detail });
      continue;
    }
    const nextPreview = applyGoalPatches(preview, [patch]);
    const invariants = checkGoalInvariants(nextPreview, policy);
    if (!invariants.ok) {
      skipped.push({ patch, reason: invariants.reason, detail: invariants.detail });
      continue;
    }
    preview = nextPreview;
    applicable.push(patch);
  }

  if (!applicable.length) {
    return { applicable: [], skipped, preview: null, warnings };
  }
  return { applicable, skipped, preview, warnings };
}

export function collectRemoveChildGoalIds(patches) {
  return patches
    .filter((p) => p.op === 'remove_child')
    .map((p) => p.child_id);
}

export function childIdsFromGoals(goals) {
  return (goals?.children || []).map((c) => c.id).filter(Boolean);
}
