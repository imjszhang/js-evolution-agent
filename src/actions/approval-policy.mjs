const VALID_MODES = new Set(['manual', 'auto_guarded', 'auto_all']);

const AUTO_GUARDED_RECORD_TYPES = new Set([
  'run_evidence_audit',
  'record_observation',
  'propose_probe',
  'write_retrospective',
  'request_core_review',
]);

const AUTO_GUARDED_AGENT_PROFILES = new Set(['read_only']);

const BLOCKED_AGENT_PROFILES = new Set([
  'remote_write_review',
  'workspace_write',
]);

const GUARDED_SAFETY_CLASSES = new Set([
  'guarded_probe',
  'guarded_record',
]);

/** Action-semantic keywords: apply on every auto_guarded branch (incl. read_only / record). */
const ACTION_SEMANTIC_KEYWORDS = [
  'publish',
  'release',
  'remote_write',
  'remote write',
  'baseline_update',
  'baseline update',
  'rank baseline',
  '解除阻塞',
  'unblock',
  'human intervention',
  '人工介入',
  'core_apply',
  'core apply',
  'approval_granted',
  'requires_human_review',
];

/**
 * Generic security keywords: only for non-read_only agent_run (blocks safety_class smuggling).
 * Exempt for read_only and record types — mentioning .env/secret is their job.
 */
const SECURITY_KEYWORDS = [
  'credential leak',
  'secret',
  '.env',
];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function collectActionText(action, runSpec = null) {
  const params = asObject(action?.params);
  const spec = runSpec ?? asObject(params.run_spec);
  const context = asObject(spec.context);
  return [
    action?.type,
    action?.description,
    params.intent,
    params.objective,
    spec.intent,
    spec.objective,
    context.why_now,
    context.desired_decision_effect,
  ]
    .filter((value) => value != null && String(value).trim() !== '')
    .join('\n')
    .toLowerCase();
}

function normalizeKeywordList(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((keyword) => String(keyword ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function subjectSensitiveKeywords(ctx = {}) {
  const approval = asObject(ctx?.host?.subjectApproval);
  return normalizeKeywordList(approval.sensitive_keywords);
}

function hasSensitiveSignal(action, runSpec = null, {
  includeSecurityKeywords = false,
  subjectKeywords = [],
} = {}) {
  const text = collectActionText(action, runSpec);
  const keywords = [
    ...ACTION_SEMANTIC_KEYWORDS,
    ...(includeSecurityKeywords ? SECURITY_KEYWORDS : []),
    ...normalizeKeywordList(subjectKeywords),
  ];
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function hasGuardedSafetyClass(action) {
  const safetyClass = String(getField(action, 'safety_class') ?? '').trim().toLowerCase();
  return GUARDED_SAFETY_CLASSES.has(safetyClass);
}

export function getApprovalMode(env = process.env) {
  const raw = String(env.JEA_APPROVAL_MODE ?? 'manual').trim().toLowerCase();
  return VALID_MODES.has(raw) ? raw : 'manual';
}

export function explicitApprovalFromAction(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(
    getField(action, 'approval_granted')
      || getField(action, 'approved')
      || boundary.approval_granted
      || boundary.approved,
  );
}

function autoAllSubjectPolicy(ctx = {}, env = process.env) {
  const approval = asObject(ctx?.host?.subjectApproval);
  const sandbox = approval.sandbox === true
    || approval.is_sandbox === true
    || ctx?.host?.sandbox === true
    || ['1', 'true', 'yes', 'on'].includes(String(env.JEA_SANDBOX ?? '').trim().toLowerCase())
    || String(env.NODE_ENV ?? '').trim().toLowerCase() === 'test';
  if (approval.allow_auto_all === true) {
    return { allowed: true, reason: 'subject_allow_auto_all' };
  }
  if (sandbox) {
    return { allowed: true, reason: 'sandbox_subject' };
  }
  return { allowed: false, reason: 'auto_all_not_allowed_for_subject' };
}

export function allowsExternalForceAutoApproval(ctx = {}, env = process.env) {
  return getApprovalMode(env) === 'auto_all' && autoAllSubjectPolicy(ctx, env).allowed;
}

function evaluateAutoAll(action, ctx = {}, env = process.env) {
  const policy = autoAllSubjectPolicy(ctx, env);
  if (!policy.allowed) {
    return {
      approved: false,
      mode: 'auto_all',
      reason: policy.reason,
      guardrails: ['registry_approval.allow_auto_all_or_sandbox_required'],
    };
  }
  return {
    approved: true,
    mode: 'auto_all',
    reason: policy.reason,
    guardrails: ['subject_auto_all_policy', 'no_manual_approval_required'],
  };
}

function wrapPolicyDecision(decision) {
  return {
    ...decision,
    auto_approval: decision.approved
      ? {
        mode: decision.mode,
        reason: decision.reason,
        guardrails: decision.guardrails,
      }
      : null,
  };
}

function evaluateAutoGuarded(action, runSpec = null, ctx = {}) {
  const type = String(action?.type ?? '').trim();
  const params = asObject(action?.params);
  const spec = runSpec ?? asObject(params.run_spec);
  const subjectKeywords = subjectSensitiveKeywords(ctx);

  if (type === 'core_apply') {
    return {
      approved: false,
      mode: 'auto_guarded',
      reason: 'core_apply_never_auto_approved',
      guardrails: ['core_apply uses JEA_CORE_APPLY_POLICY only'],
    };
  }

  if (AUTO_GUARDED_RECORD_TYPES.has(type)) {
    // Record types: action-semantic + subject keywords only (security words exempt).
    if (hasSensitiveSignal(action, spec, {
      includeSecurityKeywords: false,
      subjectKeywords,
    })) {
      return {
        approved: false,
        mode: 'auto_guarded',
        reason: 'sensitive_signal_detected',
        guardrails: ['blocked_by_keyword_or_intent_guard'],
      };
    }
    return {
      approved: true,
      mode: 'auto_guarded',
      reason: 'low_risk_record_action',
      guardrails: ['record_type_allowlist'],
    };
  }

  if (type !== 'agent_run') {
    return {
      approved: false,
      mode: 'auto_guarded',
      reason: 'action_type_not_allowlisted',
      guardrails: ['agent_run_or_record_types_only'],
    };
  }

  const permissionProfile = String(spec.permission_profile ?? getField(action, 'permission_profile') ?? '').trim();
  if (BLOCKED_AGENT_PROFILES.has(permissionProfile)) {
    return {
      approved: false,
      mode: 'auto_guarded',
      reason: 'blocked_permission_profile',
      guardrails: [`permission_profile=${permissionProfile || 'unknown'}`],
    };
  }

  const isReadOnly = AUTO_GUARDED_AGENT_PROFILES.has(permissionProfile);
  // Security keywords only for non-read_only agent_run (e.g. safety_class grey channel).
  if (hasSensitiveSignal(action, spec, {
    includeSecurityKeywords: !isReadOnly,
    subjectKeywords,
  })) {
    return {
      approved: false,
      mode: 'auto_guarded',
      reason: 'sensitive_signal_detected',
      guardrails: ['blocked_by_keyword_or_intent_guard'],
    };
  }

  if (!isReadOnly) {
    return {
      approved: false,
      mode: 'auto_guarded',
      reason: 'permission_profile_not_read_only',
      guardrails: [`permission_profile=${permissionProfile || 'unknown'}`],
    };
  }

  if (hasGuardedSafetyClass(action)) {
    return {
      approved: true,
      mode: 'auto_guarded',
      reason: 'explicit_guarded_safety_class',
      guardrails: [
        'read_only_profile',
        `safety_class=${getField(action, 'safety_class')}`,
      ],
    };
  }

  return {
    approved: true,
    mode: 'auto_guarded',
    reason: 'read_only_agent_run',
    guardrails: ['read_only_profile', 'no_sensitive_signal'],
  };
}

export function resolveApprovalDecision(action, ctx = {}, options = {}) {
  const env = options.env ?? process.env;
  const mode = getApprovalMode(env);
  const runSpec = options.runSpec ?? asObject(asObject(action?.params).run_spec);

  if (explicitApprovalFromAction(action)) {
    return {
      approved: true,
      mode,
      reason: 'explicit_approval',
      guardrails: [],
      auto_approval: null,
    };
  }

  if (mode === 'manual') {
    return {
      approved: false,
      mode,
      reason: 'manual_mode',
      guardrails: [],
      auto_approval: null,
    };
  }

  if (mode === 'auto_guarded') {
    return wrapPolicyDecision(evaluateAutoGuarded(action, runSpec, ctx));
  }

  if (mode === 'auto_all') {
    return wrapPolicyDecision(evaluateAutoAll(action, ctx, env));
  }

  return {
    approved: false,
    mode: 'manual',
    reason: 'unknown_mode_fallback_manual',
    guardrails: [],
    auto_approval: null,
  };
}

export function isActionApproved(action, ctx = {}, options = {}) {
  return resolveApprovalDecision(action, ctx, options).approved;
}
