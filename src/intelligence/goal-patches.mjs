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

export function checkGoalInvariants(nextGoals) {
  const shape = validateGoalShape(nextGoals);
  if (!shape.valid) return { ok: false, reason: shape.reason, detail: shape.detail };

  const outcomeCount = countOutcomeChildren(nextGoals);
  if (outcomeCount < 1) {
    return { ok: false, reason: 'invariant_fail', detail: 'at least one outcome child required' };
  }
  if (outcomeCount > MAX_OUTCOME_CHILDREN) {
    return { ok: false, reason: 'invariant_fail', detail: `at most ${MAX_OUTCOME_CHILDREN} outcome children` };
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

/** Balanced auto-apply gates: add/remove need refine+high; update_child allows medium+. */
export function gatePatchForAutoApply(patch, assessment) {
  if (!assessment || assessment.status !== 'refine') {
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

export function selectPatchesForAutoApply(patches, assessment) {
  const applicable = [];
  const skipped = [];
  for (const patch of patches) {
    const gate = gatePatchForAutoApply(patch, assessment);
    if (gate.allowed) applicable.push(patch);
    else skipped.push({ patch, reason: gate.reason });
  }
  return { applicable, skipped };
}

export function collectRemoveChildGoalIds(patches) {
  return patches
    .filter((p) => p.op === 'remove_child')
    .map((p) => p.child_id);
}

export function childIdsFromGoals(goals) {
  return (goals?.children || []).map((c) => c.id).filter(Boolean);
}
