export const APPROVAL_MODES = Object.freeze({
  MANUAL: 'manual',
  AUTO_GUARDED: 'auto_guarded',
  AUTO_ALL: 'auto_all',
});

export function normalizeApprovalMode(value) {
  const mode = String(value || APPROVAL_MODES.MANUAL).trim().toLowerCase();
  return Object.values(APPROVAL_MODES).includes(mode) ? mode : APPROVAL_MODES.MANUAL;
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
  return Boolean(
    action.approval_granted
    || action.params?.approval_granted
    || action.params?.approval === 'granted',
  );
}

export function autoApprovalDecision(action = {}, {
  mode = process.env.JEA_APPROVAL_MODE,
} = {}) {
  const normalizedMode = normalizeApprovalMode(mode);
  if (approvalGranted(action)) {
    return { approved: true, mode: normalizedMode, reason: 'explicit_approval_granted' };
  }
  if (!actionRequiresApproval(action)) {
    return { approved: true, mode: normalizedMode, reason: 'approval_not_required' };
  }
  if (normalizedMode === APPROVAL_MODES.AUTO_ALL) {
    return { approved: true, mode: normalizedMode, reason: 'auto_all' };
  }
  const type = action.type ?? action.action_type;
  const permissionProfile = action.params?.permission_profile ?? action.params?.run_spec?.permission_profile;
  const lowRisk = ['record_observation', 'propose_probe', 'write_retrospective'].includes(type)
    || (type === 'agent_run' && permissionProfile === 'read_only');
  if (normalizedMode === APPROVAL_MODES.AUTO_GUARDED && lowRisk) {
    return { approved: true, mode: normalizedMode, reason: 'auto_guarded_low_risk' };
  }
  return { approved: false, mode: normalizedMode, reason: 'approval_required' };
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
