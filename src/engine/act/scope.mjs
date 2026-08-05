/**
 * Agent-run scope helpers for dual-channel exec wave scheduling.
 *
 * Parallel-eligible: permission_profile=read_only (no write / remote profiles).
 * Exclusive: write-class profiles or missing/unknown run_spec → wave width 1.
 */

export const WRITE_PERMISSION_PROFILES = new Set([
  'workspace_write',
  'remote_write_review',
  'sandbox_patch',
  'core_apply',
]);

/**
 * @param {object|null|undefined} decision
 * @returns {{ profile: string|null, primary_cwd_kind: string|null, exclusive: boolean, parallel: boolean }}
 */
export function classifyAgentRunScope(decision) {
  const action = decision?.action ?? decision ?? {};
  const runSpec = action?.params?.run_spec ?? action?.run_spec ?? {};
  const profile = String(
    runSpec.permission_profile
    ?? runSpec.permissionProfile
    ?? action?.permission_profile
    ?? action?.permissionProfile
    ?? '',
  ).trim() || null;
  const primaryKind = String(
    runSpec.primary_cwd_kind
    ?? runSpec.primaryCwdKind
    ?? runSpec.resource_scope
    ?? '',
  ).trim() || null;

  if (!profile) {
    return { profile: null, primary_cwd_kind: primaryKind, exclusive: true, parallel: false };
  }
  if (profile === 'read_only') {
    return { profile, primary_cwd_kind: primaryKind, exclusive: false, parallel: true };
  }
  return { profile, primary_cwd_kind: primaryKind, exclusive: true, parallel: false };
}

export function isExclusiveAgentDecision(decision) {
  return classifyAgentRunScope(decision).exclusive;
}

export function isParallelAgentDecision(decision) {
  return classifyAgentRunScope(decision).parallel;
}

/**
 * Compute wave width: min(cap, demand, backpressureCap), with exclusive collapse.
 *
 * @param {object} opts
 * @param {object[]} opts.pendingAgents pending agent_run decisions (already sorted for claim)
 * @param {number} opts.cap concurrency cap after remaining budget
 * @param {boolean} [opts.lastWaveHadFailure]
 * @param {number} [opts.blockedThisCycle]
 */
export function computeAgentWaveWidth({
  pendingAgents = [],
  cap = 1,
  lastWaveHadFailure = false,
  blockedThisCycle = 0,
} = {}) {
  const safeCap = Math.max(0, Math.floor(Number(cap) || 0));
  if (safeCap < 1 || !pendingAgents.length) {
    return { width: 0, exclusive: false, demand: 0, backpressureCap: 0 };
  }

  let backpressureCap = safeCap;
  if (blockedThisCycle >= 3) backpressureCap = 1;
  else if (lastWaveHadFailure) backpressureCap = Math.max(1, Math.floor(safeCap / 2));

  const first = pendingAgents[0];
  const exclusive = isExclusiveAgentDecision(first);
  if (exclusive) {
    return { width: 1, exclusive: true, demand: 1, backpressureCap };
  }

  let parallelDemand = 0;
  for (const d of pendingAgents) {
    if (isExclusiveAgentDecision(d)) break;
    parallelDemand += 1;
  }
  const demand = Math.max(1, parallelDemand || 1);
  const width = Math.min(safeCap, demand, backpressureCap);
  return { width, exclusive: false, demand, backpressureCap };
}
