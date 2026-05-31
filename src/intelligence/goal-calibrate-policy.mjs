/** Phase 4.5 goal auto-calibration policy (liberal default, strict opt-in). */

import { MAX_OUTCOME_CHILDREN } from './goal-patches.mjs';

export const VALID_CALIBRATE_MODES = new Set(['liberal', 'strict']);
export const ACTIONABLE_ASSESSMENT_STATUSES = new Set(['refine', 'split', 'replace']);
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

export function isGoalAutoApplyEnabled(env = process.env) {
  const raw = String(env.JEA_GOAL_AUTO_APPLY ?? '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

export function getGoalCalibrateMode(env = process.env) {
  const raw = String(env.JEA_GOAL_CALIBRATE_MODE ?? 'liberal').trim().toLowerCase();
  return VALID_CALIBRATE_MODES.has(raw) ? raw : 'liberal';
}

function resolveMaxOutcomeChildren(env, mode) {
  const raw = env.JEA_GOAL_MAX_OUTCOME_CHILDREN;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      return n === 0 ? null : n;
    }
  }
  if (mode === 'strict') return MAX_OUTCOME_CHILDREN;
  return null;
}

export function resolveGoalCalibratePolicy(env = process.env) {
  const mode = getGoalCalibrateMode(env);
  const maxOutcomeChildren = resolveMaxOutcomeChildren(env, mode);
  const enforceOutcomeInvariants = maxOutcomeChildren != null || mode === 'strict';

  if (mode === 'strict') {
    return {
      mode: 'strict',
      enforceOutcomeInvariants: true,
      maxOutcomeChildren: maxOutcomeChildren ?? MAX_OUTCOME_CHILDREN,
      minOutcomeChildren: 1,
      actionableStatuses: new Set(['refine']),
      allowPatchOnMedium: false,
      partialPatchApply: false,
      fallbackProposedGoal: false,
      fullReplaceMinConfidence: 'high',
      fullReplaceStatuses: new Set(['refine']),
    };
  }

  return {
    mode: 'liberal',
    enforceOutcomeInvariants: enforceOutcomeInvariants && maxOutcomeChildren != null,
    maxOutcomeChildren,
    minOutcomeChildren: 0,
    actionableStatuses: ACTIONABLE_ASSESSMENT_STATUSES,
    allowPatchOnMedium: true,
    partialPatchApply: true,
    fallbackProposedGoal: true,
    fullReplaceMinConfidence: 'medium',
    fullReplaceStatuses: ACTIONABLE_ASSESSMENT_STATUSES,
  };
}

export function isActionableAssessmentStatus(status, policy) {
  const set = policy?.actionableStatuses ?? ACTIONABLE_ASSESSMENT_STATUSES;
  return set.has(status);
}

export function meetsFullReplaceConfidence(confidence, policy) {
  const min = policy?.fullReplaceMinConfidence ?? 'high';
  const rank = CONFIDENCE_RANK[confidence] ?? 0;
  const minRank = CONFIDENCE_RANK[min] ?? 2;
  return rank >= minRank;
}

export function summarizeGoalCalibratePolicy(policy) {
  const p = policy ?? resolveGoalCalibratePolicy();
  const outcomeCap = p.maxOutcomeChildren == null
    ? 'none'
    : String(p.maxOutcomeChildren);
  return `${p.mode} (outcome_cap=${outcomeCap}, partial=${p.partialPatchApply}, fallback=${p.fallbackProposedGoal})`;
}
