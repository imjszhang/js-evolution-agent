export const BELIEF_STATUSES = new Set(['active', 'validated', 'refuted', 'retired']);
export const BELIEF_CONFIDENCE = new Set(['low', 'medium', 'high']);
export const BELIEF_CHANGES = new Set([
  'create',
  'strengthen',
  'weaken',
  'validate',
  'refute',
  'unchanged',
  'retire',
  'reopen',
]);

export const CURRENT_BELIEFS_CANONICAL_PATH = 'data/intelligence/beliefs/current_beliefs.json';

export function emptyCurrentBeliefs() {
  return {
    schema_version: 1,
    updated_at: null,
    source_cycle_id: null,
    beliefs: [],
  };
}

export function normalizeCurrentBeliefs(raw = null) {
  if (!raw || typeof raw !== 'object') {
    return {
      exists: false,
      resource_kind: 'current_beliefs',
      resource_scope: 'subject_runtime',
      canonical_path: CURRENT_BELIEFS_CANONICAL_PATH,
      source_role: 'actionable_belief_state',
      ...emptyCurrentBeliefs(),
    };
  }
  const beliefs = Array.isArray(raw.beliefs) ? raw.beliefs : [];
  return {
    exists: true,
    resource_kind: 'current_beliefs',
    resource_scope: 'subject_runtime',
    canonical_path: CURRENT_BELIEFS_CANONICAL_PATH,
    source_role: 'actionable_belief_state',
    schema_version: raw.schema_version ?? 1,
    updated_at: raw.updated_at ?? null,
    source_cycle_id: raw.source_cycle_id ?? null,
    beliefs,
  };
}

export function partitionBeliefs(beliefs = []) {
  const active = [];
  const validated = [];
  const recentlyRefuted = [];
  const retired = [];
  for (const belief of beliefs) {
    const status = belief?.status ?? 'active';
    if (status === 'active') active.push(belief);
    else if (status === 'validated') validated.push(belief);
    else if (status === 'refuted') recentlyRefuted.push(belief);
    else if (status === 'retired') retired.push(belief);
  }
  return { active, validated, recentlyRefuted, retired };
}

export function summarizeBeliefForPrompt(belief) {
  if (!belief) return null;
  return {
    id: belief.id ?? null,
    goal_id: belief.goal_id ?? null,
    claim: belief.claim ?? '',
    status: belief.status ?? 'active',
    confidence: belief.confidence ?? 'medium',
    next_test: belief.next_test ?? null,
    evidence_refs: Array.isArray(belief.evidence_refs) ? belief.evidence_refs : [],
    recheck_trigger: belief.recheck_trigger ?? null,
    origin: belief.origin ?? null,
    origin_fact_id: belief.origin_fact_id ?? null,
    origin_verification: belief.origin_verification ?? null,
  };
}
