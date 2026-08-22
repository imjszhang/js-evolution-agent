import {
  explicitApprovalFromAction,
  getApprovalMode,
  resolveApprovalDecision,
} from '../approval-policy.mjs';

export const APPROVAL_MODES = Object.freeze({
  MANUAL: 'manual',
  AUTO_GUARDED: 'auto_guarded',
  AUTO_ALL: 'auto_all',
});

export function normalizeApprovalMode(value) {
  return getApprovalMode({ JEA_APPROVAL_MODE: value });
}

export function actionRequiresApproval(action = {}) {
  return Boolean(
    action.requires_approval
    || action.approval_required
    || action.params?.requires_approval
    || action.params?.approval_required
    || action.params?.approval_granted === false,
  );
}

export function approvalGranted(action = {}) {
  return explicitApprovalFromAction(action)
    || action.params?.approval === 'granted';
}

export function autoApprovalDecision(action = {}, {
  mode = process.env.JEA_APPROVAL_MODE,
  subjectApproval = null,
  sandbox = false,
  env = process.env,
} = {}) {
  const normalizedMode = normalizeApprovalMode(mode);
  if (approvalGranted(action)) {
    return { approved: true, mode: normalizedMode, reason: 'explicit_approval_granted' };
  }
  if (!actionRequiresApproval(action)) {
    return { approved: true, mode: normalizedMode, reason: 'approval_not_required' };
  }
  const decision = resolveApprovalDecision(action, {
    host: { subjectApproval, sandbox },
  }, {
    env: { ...env, JEA_APPROVAL_MODE: normalizedMode },
  });
  return decision.approved
    ? decision
    : { ...decision, reason: decision.reason || 'approval_required' };
}

export function assertApprovalAllowed(action = {}, options = {}) {
  const decision = autoApprovalDecision(action, options);
  if (!decision.approved) {
    const err = new Error(`Approval required for action ${action.type ?? 'unknown'}`);
    err.code = 'approval_required';
    err.approval = decision;
    throw err;
  }
  return decision;
}
