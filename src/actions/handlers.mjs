import { runReadOnlyProbe } from './probe-runner.mjs';
import { runAgenticAction } from './agent-adapter.mjs';
import {
  applyRunSpecToAction,
  normalizeAgentRunSpec,
  validateAgentRunSpec,
} from './agent-run-spec.mjs';
import {
  actionMissingExecutionRoot,
  actionRequiresExecutionRoot,
  resolveActionExecutionRoots,
  rootMetadata,
  rootMismatchResult,
} from './execution-root.mjs';
import {
  createBranchWorktree,
  createCoreApplyWorktree,
} from './worktree-manager.mjs';
import { runConfiguredExternalAction } from './configured-external-runner.mjs';
import {
  getConfiguredExternalAction,
  loadSubjectActionConfig,
} from './configured-actions.mjs';
import {
  checkLaneStatus,
  getSubjectRepoLane,
  openLanePullRequest,
  runLaneCommand,
} from './lane-manager.mjs';
import { validateAuthorityScope } from './authority-contract.mjs';
import { buildEvidenceContract } from './resource-registry.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESOURCE_SCOPES } from './resource-registry.mjs';

function requireParams(action, fields) {
  const missing = fields.filter((field) => action?.params?.[field] == null && action?.[field] == null);
  if (missing.length) {
    throw new Error(`missing required field(s): ${missing.join(', ')}`);
  }
}

const DIRECT_AGENT_EXECUTE_REQUIRED_PARAMS = [
  'objective',
  'mode',
  'boundary',
  'acceptance',
  'escape_hatch_reason',
];

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

const COMPATIBILITY_ACTION_TYPES = new Set(['run_probe', 'agent_execute']);

function compatibilityReceiptFields(action) {
  if (!COMPATIBILITY_ACTION_TYPES.has(action?.type)) return {};
  return {
    compatibility_action: true,
    escape_hatch_reason: getField(action, 'escape_hatch_reason') ?? null,
  };
}

function storeFrom(ctx) {
  const store = ctx?.host?.intelligenceStore;
  if (!store) throw new Error('host.intelligenceStore is not configured');
  return store;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function objectHasContent(value) {
  const obj = asObject(value);
  return Object.values(obj).some((item) => {
    if (Array.isArray(item)) return item.length > 0;
    if (item && typeof item === 'object') return Object.keys(item).length > 0;
    return item != null && item !== '';
  });
}

function listCount(value) {
  const obj = asObject(value);
  return Object.values(obj).reduce((sum, item) => {
    if (Array.isArray(item)) return sum + item.length;
    if (item && typeof item === 'object') return sum + Object.keys(item).length;
    return sum + (item == null || item === '' ? 0 : 1);
  }, 0);
}

function agentStatusToProbeStatus(status) {
  if (status === 'completed') return 'succeeded';
  if (status === 'requires_human_review') return 'blocked';
  return status || 'inconclusive';
}

function executionRootFor(action, ctx) {
  return resolveActionExecutionRoots(action, ctx).executionRoot;
}

function rootMetadataFor(action, ctx) {
  return rootMetadata(resolveActionExecutionRoots(action, ctx));
}

function probeHasHostBoundaryBlock(probeResult = {}) {
  if (probeResult.status === 'blocked' || probeResult.reason) return true;
  const steps = asArray(probeResult.evidence?.steps);
  return steps.some((step) => step?.status === 'blocked' || step?.evidence?.blocked);
}

function persistLocalProbeResult(store, action, ctx, probeResult, overrides = {}) {
  const metadata = rootMetadataFor(action, ctx);
  const event = {
    type: `probe_${probeResult.status}`,
    action_type: action.type,
    probe_id: probeResult.probe_id,
    probe_type: probeResult.probe_type,
    target: probeResult.target,
    status: probeResult.status,
    summary: probeResult.summary,
    ...metadata,
  };

  store.recordProbeEvent(probeResult.probe_id, event);
  store.recordProbeResult(probeResult);
  store.recordEvolutionEvent(event);

  const result = {
    success: true,
    message: probeResult.summary,
    probe_id: probeResult.probe_id,
    execution_root: probeResult.execution_root ?? executionRootFor(action, ctx),
    ...metadata,
    status: probeResult.status,
    probe_type: probeResult.probe_type,
    outcome_success: probeResult.success,
    evidence: probeResult.evidence ?? {},
    writes: {},
    provider: null,
    fallback_used: false,
    host_boundary_preflight: !!overrides.host_boundary_preflight,
    ...overrides,
    ...compatibilityReceiptFields(action),
  };
  store.recordActionReceipt(action, result, ctx);
  return result;
}

function summarizeAgenticExecution(agentResult = {}) {
  const agent = agentResult.agent ?? {};
  const outputs = asObject(agent.outputs);
  const executionRoot = outputs.execution_root
    ?? outputs.claude?.options?.execution_root
    ?? outputs.cursor?.options?.execution_root
    ?? outputs.claude?.options?.cwd
    ?? outputs.cursor?.options?.cwd
    ?? null;
  const evidence = asObject(agent.evidence ?? outputs.evidence);
  const writes = asObject(agent.writes ?? outputs.writes);
  return {
    success: !!agentResult.success,
    deferred: !!agentResult.deferred,
    provider: agentResult.provider ?? agent.provider ?? 'llm_only',
    status: agent.status ?? (agentResult.deferred ? 'deferred' : (agentResult.success ? 'completed' : 'failed')),
    message: agentResult.message ?? agentResult.error ?? agent.summary ?? '',
    requires_approval: !!agent.requires_approval,
    action_type: agent.action_type ?? null,
    action_id: agent.action_id ?? null,
    served_goal: agent.served_goal ?? null,
    execution_root: executionRoot,
    root_metadata: agentResult.root_metadata ?? outputs.root_metadata ?? null,
    evidence,
    writes,
    verification_hints: agent.verification_hints ?? [],
    next_actions: agent.next_actions ?? [],
    outputs,
    created_files: agent.created_files ?? [],
    modified_files: agent.modified_files ?? [],
    test_results: agent.test_results ?? [],
    agent,
    error: agentResult.error ?? null,
  };
}

async function runPhase2Agent(action, ctx, {
  mode = 'observe',
  objective = null,
  acceptance = null,
} = {}) {
  const actionObjective = getField(action, 'objective') ?? action?.description ?? '';
  const actionAcceptance = getField(action, 'acceptance') ?? getField(action, 'acceptance_criteria') ?? '';
  const targets = [
    ...asArray(getField(action, 'target')),
    ...asArray(getField(action, 'targets')),
    ...asArray(getField(action, 'initial_targets')),
  ].filter(Boolean);
  const primaryObjective = [
    actionObjective || objective || `Execute the Phase 2 action '${action?.type ?? 'unknown'}'.`,
    targets.length ? `Targets: ${targets.map(String).join(', ')}` : '',
    objective && actionObjective ? `Phase 2 wrapper instruction: ${objective}` : '',
  ].filter(Boolean).join('\n');

  const agentAction = {
    type: 'agent_execute',
    description: `Agentic Phase 2 execution for ${action?.type ?? 'unknown action'}`,
    params: {
      provider: getField(action, 'provider') ?? undefined,
      mode,
      boundary: getField(action, 'boundary') ?? undefined,
      cwd: getField(action, 'cwd') ?? undefined,
      approval_granted: getField(action, 'approval_granted') ?? undefined,
      approved: getField(action, 'approved') ?? undefined,
      allowedTools: getField(action, 'allowedTools') ?? getField(action, 'allowed_tools') ?? undefined,
      disallowedTools: getField(action, 'disallowedTools') ?? getField(action, 'disallowed_tools') ?? undefined,
      permissionMode: getField(action, 'permissionMode') ?? getField(action, 'permission_mode') ?? undefined,
      maxTurns: getField(action, 'maxTurns') ?? getField(action, 'max_turns') ?? undefined,
      objective: primaryObjective,
      context: {
        phase: 'exec',
        contract: [
          'Execute the action intent and return the final auditable action result.',
          'Do not mutate project files unless the action boundary explicitly permits it.',
          'For host-backed writes, return explicit writes.* records; the host will validate and persist only those records.',
          'For investigations, return explicit evidence.* records. Do not rely on a hard-coded local finalizer to decide the final outcome.',
        ],
        action,
      },
      acceptance: actionAcceptance || acceptance || 'Return a JSON action result with status, summary, evidence, writes, verification_hints, and next_actions.',
    },
  };

  const agentResult = await runAgenticAction(agentAction, ctx);
  return summarizeAgenticExecution(agentResult);
}

function agentBlockedResult(agenticExecution) {
  return {
    success: false,
    deferred: !!agenticExecution.deferred,
    message: agenticExecution.message || agenticExecution.error || 'agentic Phase 2 execution did not approve local finalization',
    status: agenticExecution.status,
    provider: agenticExecution.provider,
    requires_approval: !!agenticExecution.requires_approval,
    evidence: agenticExecution.evidence ?? {},
    writes: agenticExecution.writes ?? {},
    verification_hints: agenticExecution.verification_hints ?? [],
    next_actions: agenticExecution.next_actions ?? [],
    agentic_execution: agenticExecution,
    error: agenticExecution.error,
  };
}

function agentActionResult(action, agenticExecution, overrides = {}) {
  const metadata = agenticExecution.root_metadata ?? {};
  const evidence = agenticExecution.evidence ?? {};
  return {
    success: agenticExecution.success && !agenticExecution.requires_approval,
    provider: agenticExecution.provider,
    status: agenticExecution.status,
    requires_approval: agenticExecution.requires_approval,
    message: agenticExecution.message,
    action_type: agenticExecution.action_type ?? action?.type ?? 'unknown',
    action_id: agenticExecution.action_id ?? action?.id ?? null,
    served_goal: agenticExecution.served_goal ?? action?.serves_goal ?? null,
    execution_root: agenticExecution.execution_root ?? agenticExecution.outputs?.execution_root ?? null,
    ...metadata,
    evidence: {
      ...evidence,
      evidence_contract: evidence.evidence_contract ?? buildEvidenceContract({
        executionRoot: agenticExecution.execution_root ?? agenticExecution.outputs?.execution_root ?? metadata.execution_root ?? null,
        resourceScope: metadata.resource_scope,
        resourceKind: metadata.resource_kind,
        rootResolutionSource: metadata.root_resolution_source,
        path: metadata.relative_targets?.[0] ?? null,
        status: agenticExecution.status,
        observation: {
          status: agenticExecution.status,
          execution_status: agenticExecution.execution_status ?? agenticExecution.agent?.execution_status ?? agenticExecution.status,
          schema_status: agenticExecution.schema_status ?? agenticExecution.agent?.schema_status ?? null,
          acceptance_status: agenticExecution.acceptance_status ?? null,
        },
        evidenceLayer: 'execution',
      }),
    },
    writes: agenticExecution.writes ?? {},
    verification_hints: agenticExecution.verification_hints ?? [],
    next_actions: agenticExecution.next_actions ?? [],
    agent: agenticExecution.agent ?? null,
    agentic_execution: agenticExecution,
    fallback_used: false,
    ...overrides,
    ...compatibilityReceiptFields(action),
  };
}

function blockedAgentRunResult(action, reason, details, ctx) {
  const roots = details?.roots ?? null;
  const result = {
    success: false,
    status: 'blocked',
    pipeline_status: 'completed',
    agent_status: 'not_started',
    acceptance_status: 'blocked',
    goal_progress_status: 'not_progressed',
    message: reason,
    error: reason,
    provider: details?.provider ?? null,
    requires_approval: false,
    execution_root: details?.roots?.executionRoot ?? details?.runSpec?.primary_cwd ?? null,
    root_metadata: roots ? rootMetadata(roots) : null,
    run_spec: details?.runSpec ? {
      primary_cwd: details.runSpec.primary_cwd,
      primary_cwd_kind: details.runSpec.primary_cwd_kind,
      additional_directories: details.runSpec.additional_directories,
      permission_profile: details.runSpec.permission_profile,
      provider: details.runSpec.provider ?? null,
      intent: details.runSpec.intent,
      expected_output: details.runSpec.expected_output,
    } : null,
    evidence: {
      reason,
      errors: details?.errors ?? [],
      warnings: details?.warnings ?? [],
      root_metadata: roots ? rootMetadata(roots) : null,
      evidence_contract: buildEvidenceContract({
        executionRoot: roots?.executionRoot ?? details?.runSpec?.primary_cwd ?? null,
        resourceScope: roots?.resourceScope,
        resourceKind: roots?.resourceKind,
        rootResolutionSource: roots?.rootResolutionSource,
        path: roots?.relativeTargets?.[0] ?? null,
        status: 'blocked',
        observation: { status: 'blocked', reason },
        evidenceLayer: 'execution',
      }),
    },
    writes: {},
    outputs: {},
    created_files: [],
    modified_files: [],
    test_results: [],
    verification_hints: details?.verification_hints ?? [],
    fallback_used: false,
  };
  storeFrom(ctx).recordActionReceipt(action, result, ctx);
  return result;
}

function preflightAgentRun(action, ctx, executionAction, runSpec) {
  const validation = validateAgentRunSpec(action, ctx);
  if (!validation.valid) {
    return {
      blocked: true,
      reason: 'invalid agent_run execution package',
      details: {
        errors: validation.errors,
        warnings: validation.warnings,
        runSpec: validation.spec,
        roots: validation.roots,
        verification_hints: ['Fix params.run_spec before queueing this agent_run.'],
      },
    };
  }

  const roots = resolveActionExecutionRoots(executionAction, ctx);
  if (roots.rootMismatch) {
    return {
      blocked: true,
      reason: 'root_mismatch',
      details: {
        errors: ['root_mismatch'],
        runSpec,
        roots,
        verification_hints: ['Set run_spec.primary_cwd_kind/resource_scope or cwd to the authoritative resource root.'],
      },
    };
  }
  const authority = validateAuthorityScope(executionAction, ctx, roots);
  if (!authority.valid) {
    return {
      blocked: true,
      reason: 'non_authoritative_execution_scope',
      details: {
        errors: ['non_authoritative_execution_scope'],
        warnings: [authority.message],
        runSpec,
        roots,
        verification_hints: [
          authority.message,
          'Use the authoritative primary_cwd_kind for this capability, or dispatch the configured external action for the target tool.',
        ],
      },
    };
  }
  if (runSpec.primary_cwd_kind && roots.rootResolutionSource === 'default_fallback') {
    return {
      blocked: true,
      reason: 'default_fallback execution root is not allowed for agent_run',
      details: {
        errors: ['default_fallback'],
        runSpec,
        roots,
        verification_hints: ['Configure an authoritative root for the requested resource scope.'],
      },
    };
  }
  const requiresApproval = Boolean(getField(executionAction, 'requires_approval'));
  const approved = Boolean(getField(executionAction, 'approval_granted') || getField(executionAction, 'approved'));
  if (requiresApproval && !approved) {
    return {
      blocked: true,
      reason: 'approval_required',
      details: {
        errors: ['approval_required'],
        runSpec,
        roots,
        verification_hints: ['Grant approval before executing this agent_run.'],
      },
    };
  }
  return { blocked: false };
}

function legacyFallbackAllowed(action) {
  return Boolean(getField(action, 'allow_legacy_fallback') || getField(action, 'diagnostic_fallback'));
}

function agentExecutionRequested(action) {
  return Boolean(
    getField(action, 'provider')
      || getField(action, 'force_agent')
      || getField(action, 'require_agentic_execution')
      || getField(action, 'boundary')
      || getField(action, 'cwd')
      || getField(action, 'allowedTools')
      || getField(action, 'allowed_tools')
      || getField(action, 'permissionMode')
      || getField(action, 'permission_mode')
      || getField(action, 'maxTurns')
      || getField(action, 'max_turns'),
  );
}

function retrospectiveEnrichmentRequested(action) {
  return Boolean(
    getField(action, 'enrich')
      || getField(action, 'agent_enrich')
      || getField(action, 'force_agent')
      || getField(action, 'require_agentic_execution'),
  );
}

function buildRetrospectiveRecord(action) {
  return {
    summary: getField(action, 'summary'),
    outcome: getField(action, 'outcome') ?? 'reviewed',
    lessons: getField(action, 'lessons') ?? [],
    next_actions: getField(action, 'next_actions') ?? [],
    action_type: action.type,
    served_goal: action.serves_goal ?? getField(action, 'serves_goal') ?? null,
  };
}

export function buildRetrospectiveEnrichmentAction(action) {
  const params = asObject(action?.params);
  return {
    ...action,
    params: {
      ...params,
      // Retrospective enrichment is reasoning-only. Do not inherit the global
      // code-agent provider and do not expose file tools unless explicitly set.
      provider: getField(action, 'provider') ?? 'llm_only',
      allowedTools: getField(action, 'allowedTools') ?? getField(action, 'allowed_tools') ?? [],
      mode: getField(action, 'mode') ?? 'propose',
    },
  };
}

function explicitApproval(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(
    getField(action, 'approval_granted')
      || getField(action, 'approved')
      || boundary.approval_granted
      || boundary.approved,
  );
}

function sandboxConfigured(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(getField(action, 'cwd') || boundary.cwd || boundary.sandbox || boundary.worktree);
}

function sandboxBacking(action) {
  const boundary = asObject(getField(action, 'boundary'));
  const backing = [];
  if (getField(action, 'cwd') || boundary.cwd) backing.push('cwd');
  if (boundary.worktree) backing.push('worktree');
  if (boundary.sandbox) backing.push('sandbox');
  if (boundary.container) backing.push('container');
  if (boundary.acl) backing.push('acl');
  if (boundary.provider_enforcement || boundary.provider_enforced) backing.push('provider');
  return backing.length ? backing : ['none'];
}

function boundaryRelevantPaths(action, result = {}) {
  return [
    ...asArray(getField(action, 'target')),
    ...asArray(getField(action, 'targets')),
    ...asArray(getField(action, 'initial_targets')),
    ...asArray(result.created_files),
    ...asArray(result.modified_files),
  ]
    .filter((value) => typeof value === 'string' && value.trim())
    .slice(0, 20);
}

function hasSensitivePathSignal(paths) {
  return paths.some((path) => {
    const text = path.toLowerCase();
    return text.includes('.env')
      || text.includes('credential')
      || text.includes('secret')
      || text.includes('token')
      || text.endsWith('.pem')
      || text.endsWith('.key');
  });
}

function summarizeBoundaryRisk(action, result = {}) {
  const paths = boundaryRelevantPaths(action, result);
  const backing = sandboxBacking(action);
  const hasBacking = backing.some((item) => item !== 'none');
  const writesObserved = paths.length > 0 || listCount(result.writes) > 0;
  const sensitivePathSignal = hasSensitivePathSignal(paths);
  const approvalGranted = explicitApproval(action);

  return {
    boundary_contract: getField(action, 'boundary') == null ? 'missing' : 'present',
    boundary_model: hasBacking ? 'backed_by_execution_context' : 'soft_contract_only',
    sandbox_backing: backing,
    approval_granted: approvalGranted,
    requires_approval: !!result.requires_approval,
    writes_observed: writesObserved,
    declared_paths: paths,
    sensitive_path_signal: sensitivePathSignal,
    review_recommended: sensitivePathSignal || (writesObserved && !approvalGranted && !hasBacking),
  };
}

function coreApplyPolicy() {
  const value = String(process.env.JEA_CORE_APPLY_POLICY ?? 'review').trim().toLowerCase();
  return ['disabled', 'review', 'auto'].includes(value) ? value : 'review';
}

function coreApplyAudit(result = {}, workspace = null) {
  const evidence = asObject(result.evidence);
  const outputs = asObject(result.outputs);
  const writes = asObject(result.writes);
  const changedFiles = [
    ...asArray(result.modified_files),
    ...asArray(result.created_files),
    ...asArray(evidence.changed_files),
    ...asArray(outputs.changed_files),
  ];
  const testResults = [
    ...asArray(result.test_results),
    ...asArray(evidence.test_results),
    ...asArray(evidence.tests_run),
    ...asArray(outputs.test_results),
    ...asArray(outputs.tests_run),
  ];
  const diffSummary = evidence.diff_summary ?? outputs.diff_summary ?? writes.diff_summary ?? null;
  const rollbackPlan = evidence.rollback_plan ?? outputs.rollback_plan ?? writes.rollback_plan ?? null;
  const deathBoundaryResult = evidence.death_boundary_result ?? outputs.death_boundary_result ?? writes.death_boundary_result ?? null;
  return {
    changed_files: changedFiles,
    diff_summary: diffSummary,
    test_results: testResults,
    rollback_plan: rollbackPlan,
    death_boundary_result: deathBoundaryResult,
    worktree: workspace ?? result.core_apply_workspace ?? evidence.worktree ?? outputs.worktree ?? null,
    complete: changedFiles.length > 0
      && Boolean(diffSummary)
      && testResults.length > 0
      && Boolean(rollbackPlan)
      && Boolean(deathBoundaryResult),
  };
}

function explicitWorkspace(action) {
  const boundary = asObject(getField(action, 'boundary'));
  const path = getField(action, 'cwd') ?? boundary.cwd ?? boundary.sandbox ?? boundary.worktree ?? null;
  if (!path) return null;
  return {
    path,
    branch: boundary.branch ?? null,
    auto_created: false,
    created: false,
    cleanup_hint: [],
  };
}

function actionWithWorkspace(action, workspace) {
  if (!workspace?.path) return action;
  const params = asObject(action?.params);
  const boundary = asObject(params.boundary ?? action?.boundary);
  return {
    ...action,
    params: {
      ...params,
      cwd: workspace.path,
      boundary: {
        ...boundary,
        worktree: workspace.path,
      },
    },
  };
}

const AGENT_RUN_WRITE_PROFILES = new Set(['workspace_write', 'remote_write_review']);

function agentRunTargetsTargetRepo(action, ctx, runSpec) {
  const repoLane = getSubjectRepoLane(ctx);
  if (!repoLane?.configured || !repoLane.repoRoot) return false;
  const targetRoot = resolve(repoLane.repoRoot);
  const primaryKind = String(runSpec.primary_cwd_kind ?? '').trim();
  if (primaryKind === RESOURCE_SCOPES.TARGET_REPO) return true;
  if (runSpec.primary_cwd && resolve(runSpec.primary_cwd) === targetRoot) return true;
  const externalRoots = asObject(ctx?.host?.externalRoots ?? ctx?.host?.external_roots);
  if (primaryKind && externalRoots[primaryKind] && resolve(String(externalRoots[primaryKind])) === targetRoot) {
    return true;
  }
  return false;
}

function agentRunNeedsLaneWorktree(action, ctx, runSpec) {
  if (explicitWorkspace(action)) return false;
  if (!agentRunTargetsTargetRepo(action, ctx, runSpec)) return false;
  const profile = String(runSpec.permission_profile ?? 'read_only').trim();
  const mode = String(getField(action, 'mode') ?? runSpec.permission?.mode ?? '').trim();
  if (profile === 'read_only' && mode !== 'sandbox_patch') return false;
  if (!AGENT_RUN_WRITE_PROFILES.has(profile) && mode !== 'sandbox_patch') return false;
  return true;
}

function actionWithAgentRunWorkspace(action, workspace, laneMeta = {}) {
  if (!workspace?.path) return action;
  const params = asObject(action?.params);
  const boundary = asObject(params.boundary ?? action?.boundary);
  const runSpec = asObject(params.run_spec ?? params.runSpec);
  const context = asObject(runSpec.context);
  return {
    ...action,
    params: {
      ...params,
      cwd: workspace.path,
      resource_scope: RESOURCE_SCOPES.LANE_WORKTREE,
      resourceScope: RESOURCE_SCOPES.LANE_WORKTREE,
      boundary: {
        ...boundary,
        worktree: workspace.path,
        branch: workspace.branch ?? boundary.branch ?? null,
      },
      run_spec: {
        ...runSpec,
        primary_cwd: workspace.path,
        primary_cwd_kind: RESOURCE_SCOPES.LANE_WORKTREE,
        context: {
          ...context,
          lane_execution: {
            target_repo_root: laneMeta.targetRepoRoot ?? null,
            lane_branch: laneMeta.lane ?? null,
            work_branch: workspace.branch ?? null,
            worktree_path: workspace.path,
            auto_created: workspace.auto_created ?? true,
          },
        },
      },
    },
  };
}

function prepareAgentRunLaneWorkspace(action, ctx, runSpec) {
  if (!agentRunNeedsLaneWorktree(action, ctx, runSpec)) {
    return { ok: true, action, workspace: null, laneMeta: null };
  }

  const repoLane = getSubjectRepoLane(ctx);
  const laneStatus = typeof ctx?.host?.checkLaneStatus === 'function'
    ? ctx.host.checkLaneStatus(repoLane)
    : checkLaneStatus(repoLane);
  if (!laneStatus.ok) {
    return {
      ok: false,
      error: `subject repo lane is not ready: ${laneStatus.errors.join('; ')}`,
      workspace: null,
      laneMeta: null,
    };
  }

  const create = ctx?.host?.createAgentRunWorktree
    ?? ((opts) => createBranchWorktree({
      repoRoot: repoLane.repoRoot,
      baseBranch: repoLane.lane,
      workBranchPrefix: repoLane.workBranchPrefix,
      cycleId: opts.cycleId,
      actionId: opts.actionId,
      target: opts.target,
    }));

  try {
    const workspace = create({
      repoRoot: repoLane.repoRoot,
      cycleId: ctx?.cycleId,
      actionId: ctx?.actionId ?? action?.id ?? getField(action, 'id'),
      target: runSpec.intent ?? action?.description,
    });
    const laneMeta = {
      targetRepoRoot: repoLane.repoRoot,
      lane: repoLane.lane,
    };
    const updatedAction = actionWithAgentRunWorkspace(action, workspace, laneMeta);
    return { ok: true, action: updatedAction, workspace, laneMeta };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      workspace: null,
      laneMeta: null,
    };
  }
}

function prepareCoreApplyWorkspace(action, ctx) {
  const provided = explicitWorkspace(action);
  if (provided) return { ok: true, action, workspace: provided };

  const repoLane = getSubjectRepoLane(ctx);
  const create = ctx?.host?.createCoreApplyWorktree
    ?? (repoLane?.configured
      ? (opts) => createBranchWorktree({
        repoRoot: repoLane.repoRoot,
        baseBranch: repoLane.lane,
        workBranchPrefix: repoLane.workBranchPrefix,
        cycleId: opts.cycleId,
        actionId: opts.actionId,
        target: opts.target,
      })
      : createCoreApplyWorktree);
  try {
    const workspace = create({
      repoRoot: repoLane?.repoRoot ?? ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd(),
      cycleId: ctx?.cycleId,
      actionId: ctx?.actionId ?? action?.id ?? getField(action, 'id'),
      target: getField(action, 'target') ?? action?.description,
    });
    return { ok: true, action: actionWithWorkspace(action, workspace), workspace };
  } catch (e) {
    return {
      ok: false,
      error: e?.message || String(e),
      workspace: null,
    };
  }
}

function missingAgentArtifactsResult(action, agenticExecution, artifactKind) {
  return agentActionResult(action, agenticExecution, {
    success: false,
    status: agenticExecution.status === 'completed' ? 'blocked' : agenticExecution.status,
    message: `agent-first execution returned no ${artifactKind}; legacy finalizer is disabled unless allow_legacy_fallback is set`,
    missing_agent_artifacts: artifactKind,
    fallback_available: true,
  });
}

function persistObservationWrites(store, action, agenticExecution) {
  const observations = asArray(agenticExecution.writes?.observations);
  if (!observations.length) return 0;
  return store.ingestObservation(observations.map((observation) => ({
    source: observation.source ?? 'agent_phase2',
    subject: observation.subject ?? action.description ?? action.type ?? 'unspecified',
    kind: observation.kind ?? 'evolution_signal',
    content: observation.content ?? observation.summary ?? agenticExecution.message,
    confidence: observation.confidence ?? 'medium',
    tags: observation.tags ?? ['agent-first'],
    ...observation,
  })));
}

function persistRetrospectiveWrites(store, action, agenticExecution) {
  const retrospectives = asArray(agenticExecution.writes?.retrospectives);
  if (!retrospectives.length) return 0;
  let written = 0;
  for (const review of retrospectives) {
    written += store.recordRetrospective({
      summary: review.summary ?? agenticExecution.message,
      outcome: review.outcome ?? agenticExecution.status ?? 'reviewed',
      lessons: review.lessons ?? [],
      next_actions: review.next_actions ?? agenticExecution.next_actions ?? [],
      action_type: action.type,
      ...review,
    });
  }
  return written;
}

function persistProbeProposalWrites(store, action, agenticExecution) {
  const proposals = asArray(
    agenticExecution.writes?.probe_proposals
      ?? agenticExecution.writes?.proposals
      ?? agenticExecution.writes?.probe_events,
  );
  if (!proposals.length) return { written: 0, probeId: null };
  let written = 0;
  let firstProbeId = null;
  for (const proposal of proposals) {
    const probeId = proposal.probe_id ?? action.id ?? `probe-${Date.now()}`;
    firstProbeId ??= probeId;
    const event = {
      type: proposal.type ?? 'probe_proposed',
      action_type: action.type,
      target: proposal.target ?? getField(action, 'target') ?? action.description ?? 'unspecified',
      hypothesis: proposal.hypothesis ?? getField(action, 'hypothesis'),
      success_signal: proposal.success_signal ?? getField(action, 'success_signal'),
      failure_signal: proposal.failure_signal ?? getField(action, 'failure_signal'),
      death_boundary: proposal.death_boundary ?? getField(action, 'death_boundary'),
      status: proposal.status ?? 'proposed_only',
      ...proposal,
    };
    written += store.recordProbeEvent(probeId, event);
    written += store.recordEvolutionEvent({ ...event, probe_id: probeId });
  }
  return { written, probeId: firstProbeId };
}

function persistProbeResultWrites(store, action, agenticExecution) {
  const metadata = agenticExecution.root_metadata ?? {};
  const explicitResults = asArray(agenticExecution.writes?.probe_results);
  const shouldSynthesize = !explicitResults.length && objectHasContent(agenticExecution.evidence);
  const probeResults = shouldSynthesize
    ? [{
      probe_id: action.probe_id ?? action.id ?? `probe-${Date.now()}`,
      probe_type: getField(action, 'probe_type') ?? 'agent_investigation',
      target: getField(action, 'target') ?? getField(action, 'targets') ?? action.description ?? 'agent-evidence',
      status: agentStatusToProbeStatus(agenticExecution.status),
      success: agenticExecution.success && !agenticExecution.requires_approval,
      summary: agenticExecution.message,
      evidence: agenticExecution.evidence,
    }]
    : explicitResults;
  if (!probeResults.length) return { written: 0, probeId: null, synthesized: false };

  let written = 0;
  let firstProbeId = null;
  for (const raw of probeResults) {
    const probeId = raw.probe_id ?? raw.id ?? action.probe_id ?? action.id ?? `probe-${Date.now()}`;
    firstProbeId ??= probeId;
    const probeResult = {
      probe_id: probeId,
      probe_type: raw.probe_type ?? getField(action, 'probe_type') ?? 'agent_investigation',
      target: raw.target ?? getField(action, 'target') ?? getField(action, 'targets') ?? action.description ?? 'agent-evidence',
      status: raw.status ?? agentStatusToProbeStatus(agenticExecution.status),
      success: raw.success ?? (agenticExecution.success && !agenticExecution.requires_approval),
      summary: raw.summary ?? agenticExecution.message,
      ...metadata,
      evidence: {
        ...metadata,
        ...(raw.evidence ?? agenticExecution.evidence ?? {}),
      },
      ...raw,
    };
    const event = {
      type: `probe_${probeResult.status}`,
      action_type: action.type,
      probe_id: probeId,
      probe_type: probeResult.probe_type,
      target: probeResult.target,
      status: probeResult.status,
      summary: probeResult.summary,
      ...metadata,
    };
    written += store.recordProbeEvent(probeId, event);
    written += store.recordProbeResult(probeResult);
    written += store.recordEvolutionEvent(event);
  }
  return { written, probeId: firstProbeId, synthesized: shouldSynthesize };
}

function persistCoreReviewWrites(store, action, agenticExecution) {
  const reviews = asArray(agenticExecution.writes?.core_reviews);
  if (!reviews.length) return 0;
  let written = 0;
  for (const review of reviews) {
    written += store.recordEvolutionEvent({
      type: 'core_review_requested',
      action_type: action.type,
      target: review.target ?? getField(action, 'target') ?? action.description ?? 'unspecified',
      rationale: review.rationale ?? getField(action, 'rationale') ?? action.rationale ?? '',
      risks: review.risks ?? getField(action, 'risks') ?? [],
      approval_needed: true,
      status: 'requires_human_review',
      ...review,
    });
  }
  return written;
}

async function runConfiguredExternalActionHandler(action, ctx) {
  const store = storeFrom(ctx);
  const externalResult = await runConfiguredExternalAction(action, ctx);
  const observations = persistObservationWrites(store, action, {
    writes: externalResult.writes ?? {},
    message: externalResult.message,
  });
  store.recordEvolutionEvent({
    type: 'configured_external_action',
    action_type: action.type,
    command: externalResult.command,
    tool: externalResult.tool,
    status: externalResult.status ?? (externalResult.success ? 'completed' : 'failed'),
    success: !!externalResult.success,
    requires_approval: !!externalResult.requires_approval,
    summary: externalResult.message ?? externalResult.status ?? '',
    evidence: externalResult.evidence ?? externalResult.evaluation ?? externalResult.candidate ?? null,
  });
  const result = {
    success: !!externalResult.success,
    status: externalResult.status ?? (externalResult.success ? 'completed' : 'failed'),
    message: externalResult.message ?? `configured external command ${externalResult.command} completed`,
    requires_approval: !!externalResult.requires_approval,
    provider: 'configured-external-runner',
    evidence: externalResult.evidence ?? {},
    writes: externalResult.writes ?? {},
    outputs: externalResult,
    writes_applied: { observations },
    fallback_used: false,
  };
  store.recordActionReceipt(action, result, ctx);
  return result;
}

const FORBIDDEN_OBSERVATION_FIELDS = new Set(['simulation_results']);

const SCORE_FIELD_NAMES = new Set([
  'winRate', 'score', 'rating', 'rank', 'elo',
  'survivalScore', 'fitness', 'performance',
]);

function _flattenObject(obj, prefix = '') {
  if (obj == null || typeof obj !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, _flattenObject(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function _hasForbiddenField(observation) {
  const flat = _flattenObject(observation);
  for (const field of FORBIDDEN_OBSERVATION_FIELDS) {
    if (flat[field] != null) return field;
  }
  for (const key of Object.keys(flat)) {
    if (FORBIDDEN_OBSERVATION_FIELDS.has(key)) return key;
    for (const seg of key.split('.')) {
      if (FORBIDDEN_OBSERVATION_FIELDS.has(seg)) return seg;
    }
  }
  return null;
}

function _extractScoreFields(observation) {
  const flat = _flattenObject(observation);
  const scores = {};
  for (const [key, value] of Object.entries(flat)) {
    const baseName = key.split('.').pop();
    if (SCORE_FIELD_NAMES.has(baseName) && typeof value === 'number') {
      scores[key] = value;
    }
  }
  return scores;
}

function _findSimulationDir(ctx) {
  const dataRoot = ctx?.host?.dataRoot;
  const projectRoot = ctx?.projectRoot;
  const candidates = [];
  if (dataRoot) {
    candidates.push(join(dataRoot, '..', 'simulations'));
  }
  if (projectRoot) {
    candidates.push(join(projectRoot, 'runtime', 'subjects'));
    candidates.push(join(projectRoot, 'data', 'simulations'));
  }
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch { /* skip */ }
  }
  return null;
}

function _readSimulationDir(dir, scores, onFound) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const data = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
          _extractSimulationScores(data, scores);
          if (onFound) onFound(true);
        } catch { /* skip unparseable */ }
      }
    }
  } catch { /* skip unreadable dir */ }
}

function _walkSimulationFiles(dir, scores, opts = {}) {
  const onFound = opts?.found;
  try {
    if (dir.split(/[/\\]/).pop() === 'simulations') {
      _readSimulationDir(dir, scores, onFound);
      return;
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'simulations') {
          _readSimulationDir(fullPath, scores, onFound);
        } else {
          _walkSimulationFiles(fullPath, scores, opts);
        }
      }
    }
  } catch { /* skip unreadable dir */ }
}

function _extractSimulationScores(data, scores) {
  if (data == null) return;
  if (typeof data.score === 'number') scores.add(data.score);
  if (typeof data.winRate === 'number') scores.add(data.winRate);
  const sims = Array.isArray(data.simulations) ? data.simulations : [];
  for (const sim of sims) {
    if (typeof sim.score === 'number') scores.add(sim.score);
    const m = sim.metrics;
    if (m) {
      if (typeof m.winRate === 'number') scores.add(m.winRate);
      if (typeof m.score === 'number') scores.add(m.score);
      if (typeof m.survivalScore === 'number') scores.add(m.survivalScore);
    }
  }
}

function _collectAllSimulationScores(ctx) {
  const dataRoot = ctx?.host?.dataRoot;
  const projectRoot = ctx?.projectRoot;
  const candidates = [];
  if (dataRoot) {
    candidates.push(join(dataRoot, '..', 'simulations'));
  }
  if (projectRoot) {
    candidates.push(join(projectRoot, 'data', 'simulations'));
    candidates.push(join(projectRoot, 'runtime', 'subjects'));
  }
  const scores = new Set();
  let foundAny = false;
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) {
        _walkSimulationFiles(dir, scores, { found: (v) => { foundAny = foundAny || v; } });
      }
    } catch { /* skip */ }
  }
  if (!foundAny) return null;
  return scores;
}

function _validateObservation(observation, ctx) {
  const forbiddenField = _hasForbiddenField(observation);
  if (forbiddenField) {
    return { valid: false, reason: `Observation contains forbidden field: ${forbiddenField}` };
  }

  const obsScores = _extractScoreFields(observation);
  if (Object.keys(obsScores).length > 0) {
    const simScores = _collectAllSimulationScores(ctx);
    if (simScores !== null && simScores.size > 0) {
      const unmatched = Object.entries(obsScores).filter(([, v]) => !simScores.has(v));
      if (unmatched.length > 0) {
        const fields = unmatched.map(([k]) => k).join(', ');
        return {
          valid: false,
          reason: `Score field(s) not traceable to any simulation record: ${fields}. Scores must reference actual simulation outputs.`,
        };
      }
    }
  }

  return { valid: true };
}

function _blockObservationResult(action, reason, ctx) {
  const store = storeFrom(ctx);
  const result = {
    success: false,
    status: 'blocked',
    message: reason,
    provider: 'local',
    fallback_used: false,
    evidence: {},
    writes: {},
  };
  store.recordActionReceipt(action, result, ctx);
  return result;
}

const builtInActionHandlers = {
  async lane_status(action, ctx) {
    const store = storeFrom(ctx);
    const config = {
      ...asObject(getSubjectRepoLane(ctx)),
      ...asObject(action?.params?.repoLane ?? action?.repoLane),
    };
    const status = checkLaneStatus(config);
    const result = {
      success: status.ok,
      status: status.ok ? 'ready' : 'blocked',
      message: status.ok
        ? `lane ready: ${status.lane}`
        : `lane not ready: ${status.errors.join('; ')}`,
      provider: 'local',
      requires_approval: false,
      evidence: {
        repo_lane: status,
      },
      writes: {},
      fallback_used: false,
    };
    store.recordEvolutionEvent({
      type: 'lane_status_checked',
      status: result.status,
      subject_lane: status.lane,
      repo_root: status.repoRoot,
      ok: status.ok,
      errors: status.errors,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async lane_observe(action, ctx) {
    const store = storeFrom(ctx);
    const config = {
      ...asObject(getSubjectRepoLane(ctx)),
      ...asObject(action?.params?.repoLane ?? action?.repoLane),
    };
    const command = getField(action, 'command') ?? config.runCommand;
    const evidence = runLaneCommand(config, {
      command,
      kind: 'observe',
      timeoutMs: Number(getField(action, 'timeout_ms') ?? 120_000),
    });
    const result = {
      success: evidence.success,
      status: evidence.success ? (evidence.skipped ? 'skipped' : 'completed') : 'failed',
      message: evidence.skipped
        ? 'lane observe skipped because no Run Command is configured'
        : `lane observe ${evidence.success ? 'completed' : 'failed'}: ${command ?? '(none)'}`,
      provider: 'local',
      requires_approval: false,
      evidence: { lane_observe: evidence },
      writes: {},
      fallback_used: false,
    };
    store.recordEvolutionEvent({
      type: 'lane_observe',
      status: result.status,
      repo_root: evidence.repoRoot,
      subject_lane: evidence.lane,
      command,
      exit_code: evidence.exitCode,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async lane_verify(action, ctx) {
    const store = storeFrom(ctx);
    const config = {
      ...asObject(getSubjectRepoLane(ctx)),
      ...asObject(action?.params?.repoLane ?? action?.repoLane),
    };
    const command = getField(action, 'command') ?? config.testCommand;
    const evidence = runLaneCommand(config, {
      command,
      kind: 'verify',
      timeoutMs: Number(getField(action, 'timeout_ms') ?? 120_000),
    });
    const result = {
      success: evidence.success,
      status: evidence.success ? (evidence.skipped ? 'skipped' : 'passed') : 'failed',
      message: evidence.skipped
        ? 'lane verify skipped because no Test Command is configured'
        : `lane verify ${evidence.success ? 'passed' : 'failed'}: ${command ?? '(none)'}`,
      provider: 'local',
      requires_approval: false,
      evidence: { lane_verify: evidence },
      writes: {},
      fallback_used: false,
    };
    store.recordEvolutionEvent({
      type: 'lane_verify',
      status: result.status,
      repo_root: evidence.repoRoot,
      subject_lane: evidence.lane,
      command,
      exit_code: evidence.exitCode,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async github_open_lane_pr(action, ctx) {
    const store = storeFrom(ctx);
    const config = {
      ...asObject(getSubjectRepoLane(ctx)),
      ...asObject(action?.params?.repoLane ?? action?.repoLane),
    };
    const pr = openLanePullRequest(config, {
      headBranch: getField(action, 'head_branch') ?? getField(action, 'headBranch'),
      title: getField(action, 'title'),
      body: getField(action, 'body'),
      draft: getField(action, 'draft') ?? true,
    });
    const result = {
      success: pr.success,
      status: pr.success ? 'opened' : 'failed',
      message: pr.success
        ? `opened lane PR from ${pr.headBranch} to ${pr.baseBranch}`
        : `failed to open lane PR: ${pr.error}`,
      provider: 'gh',
      requires_approval: false,
      evidence: { github_open_lane_pr: pr },
      writes: {},
      fallback_used: false,
    };
    store.recordEvolutionEvent({
      type: 'github_open_lane_pr',
      status: result.status,
      subject_lane: pr.baseBranch,
      head_branch: pr.headBranch,
      pr_url: pr.pr?.stdout || null,
      error: pr.error,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async agent_run(action, ctx) {
    const store = storeFrom(ctx);
    const runSpecForLane = normalizeAgentRunSpec(action, ctx);
    const workspacePrep = prepareAgentRunLaneWorkspace(action, ctx, runSpecForLane);
    if (!workspacePrep.ok) {
      return blockedAgentRunResult(action, 'agent_run could not prepare lane worktree', {
        errors: ['lane_worktree_unavailable'],
        runSpec: runSpecForLane,
        verification_hints: [
          workspacePrep.error,
          'Run jea subject lane init when the lane branch is missing.',
          'Fix git worktree creation or provide boundary.worktree/cwd explicitly.',
        ],
      }, ctx);
    }
    let executionAction = applyRunSpecToAction(workspacePrep.action, ctx);
    let runSpec = normalizeAgentRunSpec(executionAction, ctx);
    const preflight = preflightAgentRun(action, ctx, executionAction, runSpec);
    if (preflight.blocked) {
      return blockedAgentRunResult(action, preflight.reason, preflight.details, ctx);
    }
    const agentResult = await runAgenticAction(executionAction, ctx);
    const agent = asObject(agentResult.agent);
    const executionStatus = agent.execution_status ?? agent.status ?? (agentResult.success ? 'completed' : 'failed');
    const schemaStatus = agent.schema_status ?? (agentResult.success ? 'valid' : 'invalid');
    const schemaMissing = asArray(agent.schema_missing);
    const agentStatus = agent.status ?? executionStatus;
    const requiresApproval = !!agent.requires_approval;
    const hasExecutionEvidence = listCount(agent.evidence) > 0
      || listCount(agent.writes) > 0
      || listCount(agent.outputs) > 0
      || asArray(agent.modified_files).length > 0
      || asArray(agent.created_files).length > 0;
    const executionSucceeded = ['completed', 'succeeded', 'improved'].includes(String(executionStatus).toLowerCase())
      || (hasExecutionEvidence && !['failed', 'blocked'].includes(String(executionStatus).toLowerCase()));
    const acceptanceStatus = requiresApproval
      ? 'requires_human_review'
      : (executionSucceeded && schemaStatus === 'valid' ? 'passed' : (executionSucceeded ? 'schema_invalid' : 'failed'));
    const rootMetadataValue = agentResult.root_metadata ?? null;
    const evidence = asObject(agent.evidence);
    const providerFailure = agent.provider_failure ?? agentResult.provider_failure ?? null;
    const laneWorkspaceEvidence = workspacePrep.workspace
      ? {
        lane_workspace: {
          ...workspacePrep.workspace,
          target_repo_root: workspacePrep.laneMeta?.targetRepoRoot ?? null,
          lane_branch: workspacePrep.laneMeta?.lane ?? null,
        },
      }
      : {};
    const result = {
      success: executionSucceeded && schemaStatus === 'valid' && !requiresApproval,
      status: agentStatus,
      execution_status: executionStatus,
      schema_status: schemaStatus,
      schema_missing: schemaMissing,
      pipeline_status: 'completed',
      agent_status: agentStatus,
      acceptance_status: acceptanceStatus,
      goal_progress_status: executionSucceeded && hasExecutionEvidence && !requiresApproval ? 'progressed' : 'not_progressed',
      message: agent.summary ?? agentResult.message ?? agentResult.error ?? providerFailure?.message ?? '',
      error: agentResult.error ?? providerFailure?.message ?? null,
      provider: agentResult.provider ?? agent.provider ?? null,
      requires_approval: requiresApproval,
      execution_root: agentResult.execution_root ?? runSpec.primary_cwd,
      root_metadata: rootMetadataValue,
      run_spec: {
        primary_cwd: runSpec.primary_cwd,
        primary_cwd_kind: runSpec.primary_cwd_kind,
        additional_directories: runSpec.additional_directories,
        permission_profile: runSpec.permission_profile,
        provider: runSpec.provider ?? agentResult.provider ?? agent.provider ?? null,
        intent: runSpec.intent,
        expected_output: runSpec.expected_output,
      },
      agent,
      lane_workspace: workspacePrep.workspace
        ? {
          ...workspacePrep.workspace,
          target_repo_root: workspacePrep.laneMeta?.targetRepoRoot ?? null,
          lane_branch: workspacePrep.laneMeta?.lane ?? null,
        }
        : null,
      evidence: {
        ...evidence,
        ...laneWorkspaceEvidence,
        ...(providerFailure ? { provider_failure: providerFailure } : {}),
        evidence_contract: evidence.evidence_contract ?? buildEvidenceContract({
          executionRoot: agentResult.execution_root ?? runSpec.primary_cwd,
          resourceScope: rootMetadataValue?.resource_scope ?? runSpec.primary_cwd_kind,
          resourceKind: rootMetadataValue?.resource_kind ?? null,
          rootResolutionSource: rootMetadataValue?.root_resolution_source ?? null,
          path: rootMetadataValue?.relative_targets?.[0] ?? null,
          status: agentStatus,
          observation: {
            status: agentStatus,
            execution_status: executionStatus,
            schema_status: schemaStatus,
            acceptance_status: acceptanceStatus,
          },
          evidenceLayer: 'execution',
        }),
      },
      writes: asObject(agent.writes),
      outputs: {
        ...asObject(agent.outputs),
        ...(providerFailure ? { provider_failure: providerFailure } : {}),
      },
      created_files: asArray(agent.created_files),
      modified_files: asArray(agent.modified_files),
      test_results: asArray(agent.test_results),
      verification_hints: [
        ...asArray(agent.verification_hints),
        ...(providerFailure ? [`provider failure phase: ${providerFailure.phase}`] : []),
      ],
      fallback_used: false,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async record_observation(action, ctx) {
    requireParams(action, ['content']);
    const store = storeFrom(ctx);

    const actionParams = asObject(action?.params);
    const entryValidation = _validateObservation(actionParams, ctx);
    if (!entryValidation.valid) {
      return _blockObservationResult(action, entryValidation.reason, ctx);
    }

    if (!agentExecutionRequested(action)) {
      const observation = {
        source: getField(action, 'source') ?? 'oada-action',
        subject: getField(action, 'subject') ?? action.description ?? 'unspecified',
        kind: getField(action, 'kind') ?? 'evolution_signal',
        content: getField(action, 'content'),
        confidence: getField(action, 'confidence') ?? 'medium',
        tags: getField(action, 'tags') ?? ['js-evolution-agent'],
      };
      const obsValidation = _validateObservation(observation, ctx);
      if (!obsValidation.valid) {
        return _blockObservationResult(action, obsValidation.reason, ctx);
      }
      const written = store.ingestObservation(observation);
      const result = {
        success: written > 0,
        status: written > 0 ? 'recorded' : 'failed',
        message: written > 0 ? 'recorded observation locally (host-backed write)' : 'observation was not recorded',
        provider: 'local',
        fallback_used: false,
        writes_applied: { observations: written },
        evidence: {},
        writes: { observations: [observation] },
        verification_hints: written > 0
          ? ['record_observation is a host-backed write only; use agent_run for investigations.']
          : [],
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Execute a low-risk intelligence observation write. Return writes.observations with the exact observation records the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentObservations = asArray(agenticExecution.writes?.observations);
    const invalidAgentObs = agentObservations.find((obs) => !_validateObservation(obs, ctx).valid);
    if (invalidAgentObs) {
      const obsValidation = _validateObservation(invalidAgentObs, ctx);
      return _blockObservationResult(action, obsValidation.reason, ctx);
    }
    const agentWritten = persistObservationWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'recorded',
        message: `recorded ${agentWritten} observation(s) from agent writes`,
        writes_applied: { observations: agentWritten },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.observations');
      result.verification_hints = [
        ...(result.verification_hints ?? []),
        'record_observation requires writes.observations from the agent; use agent_run for investigations, then record_observation to persist conclusions.',
      ];
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const observation = {
      source: getField(action, 'source') ?? 'oada-action',
      subject: getField(action, 'subject') ?? action.description ?? 'unspecified',
      kind: getField(action, 'kind') ?? 'evolution_signal',
      content: getField(action, 'content'),
      confidence: getField(action, 'confidence') ?? 'medium',
      tags: getField(action, 'tags') ?? ['js-evolution-agent'],
    };
    const obsValidation = _validateObservation(observation, ctx);
    if (!obsValidation.valid) {
      return _blockObservationResult(action, obsValidation.reason, ctx);
    }
    const written = store.ingestObservation(observation);
    const result = {
      success: written > 0,
      message: `recorded ${written} observation(s)`,
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async propose_probe(action, ctx) {
    requireParams(action, ['hypothesis', 'success_signal', 'failure_signal', 'death_boundary']);
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Execute a bounded probe proposal write. Return writes.probe_proposals with the proposal events the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWrites = persistProbeProposalWrites(store, action, agenticExecution);
    if (agentWrites.written > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'proposed_only',
        message: `probe proposal recorded from agent writes: ${agentWrites.probeId}`,
        probe_id: agentWrites.probeId,
        writes_applied: { probe_proposals: agentWrites.written },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.probe_proposals');
      result.verification_hints = [
        ...(result.verification_hints ?? []),
        'propose_probe registers experiment plans only; execute experiments with agent_run after the proposal is recorded.',
      ];
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const probeId = getField(action, 'probe_id') ?? action.id ?? `probe-${Date.now()}`;
    const event = {
      type: 'probe_proposed',
      action_type: action.type,
      target: getField(action, 'target') ?? action.description ?? 'unspecified',
      hypothesis: getField(action, 'hypothesis'),
      success_signal: getField(action, 'success_signal'),
      failure_signal: getField(action, 'failure_signal'),
      death_boundary: getField(action, 'death_boundary'),
      status: 'proposed_only',
    };
    store.recordProbeEvent(probeId, event);
    store.recordEvolutionEvent({ ...event, probe_id: probeId });
    const result = {
      success: true,
      message: `probe proposal recorded: ${probeId}`,
      probe_id: probeId,
      status: 'proposed_only',
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async run_probe(action, ctx) {
    const store = storeFrom(ctx);
    const roots = resolveActionExecutionRoots(action, ctx);
    const metadata = rootMetadata(roots);
    if (roots.rootMismatch) {
      const result = {
        ...rootMismatchResult(action, roots, 'local'),
        ...compatibilityReceiptFields(action),
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    if (actionRequiresExecutionRoot(action) && actionMissingExecutionRoot(action, ctx)) {
      const result = {
        success: false,
        status: 'blocked',
        message: 'run_probe requires params.executionRoot or params.cwd for local file work; prefer agent_run with permission_profile=read_only for new investigations',
        provider: 'local',
        fallback_used: false,
        error: 'missing executionRoot',
        ...metadata,
        evidence: metadata,
        writes: {},
        verification_hints: ['Prefer agent_run with permission_profile=read_only instead of run_probe for new decisions.'],
        ...compatibilityReceiptFields(action),
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const preflightProbeResult = runReadOnlyProbe(action, ctx);
    if (probeHasHostBoundaryBlock(preflightProbeResult)) {
      return persistLocalProbeResult(store, action, ctx, preflightProbeResult, {
        message: `Probe blocked by host preflight before agent execution: ${preflightProbeResult.summary}`,
        verification_hints: [
          'host preflight blocked the local probe path; this does not prove provider-level agent access is blocked',
          'remove sensitive/off-limits targets or provide a safe in-namespace target before using agentic investigation',
        ],
        host_boundary_preflight: true,
        boundary_risk: {
          ...summarizeBoundaryRisk(action),
          preflight_result: 'blocked_local_probe',
          provider_isolation_proven: false,
        },
      });
    }

    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'observe',
      objective: 'Execute this read-only probe as an agentic Phase 2 investigation. Return evidence describing what was actually checked and writes.probe_results if structured probe evidence should be persisted.',
      acceptance: 'Return JSON with status, summary, evidence, optional writes.probe_results, verification_hints, and next_actions. Do not rely on the host to infer the final outcome from the original target fields.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentProbeWrites = persistProbeResultWrites(store, action, agenticExecution);
    if (agentProbeWrites.written > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agentStatusToProbeStatus(agenticExecution.status),
        message: agenticExecution.message || 'agent probe evidence recorded',
        execution_root: executionRootFor(action, ctx),
        ...rootMetadataFor(action, ctx),
        probe_id: agentProbeWrites.probeId,
        probe_type: getField(action, 'probe_type') ?? 'agent_investigation',
        outcome_success: true,
        writes_applied: { probe_results: agentProbeWrites.written },
        synthesized_probe_result: agentProbeWrites.synthesized,
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = {
        ...missingAgentArtifactsResult(action, agenticExecution, 'evidence or writes.probe_results'),
        verification_hints: [
          ...(agenticExecution.verification_hints ?? []),
          'run_probe is a compatibility action; prefer agent_run with permission_profile=read_only for new investigations.',
        ],
        ...compatibilityReceiptFields(action),
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const probeResult = runReadOnlyProbe(action, ctx);
    return persistLocalProbeResult(store, action, ctx, probeResult, {
      execution_root: executionRootFor(action, ctx),
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    });
  },

  async agent_execute(action, ctx) {
    requireParams(action, DIRECT_AGENT_EXECUTE_REQUIRED_PARAMS);
    const store = storeFrom(ctx);
    const roots = resolveActionExecutionRoots(action, ctx);
    if (roots.rootMismatch) {
      const result = rootMismatchResult(action, roots, getField(action, 'provider') ?? 'llm_only');
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentResult = await runAgenticAction(action, ctx);
    const agent = agentResult.agent ?? {};
    const metadata = agentResult.root_metadata ?? rootMetadata(roots);
    const result = {
      success: !!agentResult.success,
      deferred: !!agentResult.deferred,
      message: agentResult.message ?? agentResult.error ?? agent.summary ?? 'agent execution completed',
      provider: agentResult.provider ?? agent.provider ?? (action?.params?.provider ?? 'llm_only'),
      status: agent.status ?? (agentResult.deferred ? 'deferred' : (agentResult.success ? 'completed' : 'failed')),
      requires_approval: !!agent.requires_approval,
      action_type: agent.action_type ?? action.type,
      action_id: agent.action_id ?? action.id ?? null,
      served_goal: agent.served_goal ?? action.serves_goal ?? null,
      execution_root: agentResult.execution_root ?? agent.outputs?.execution_root ?? agent.outputs?.claude?.options?.execution_root ?? agent.outputs?.cursor?.options?.execution_root ?? executionRootFor(action, ctx),
      ...metadata,
      evidence: agent.evidence ?? {},
      writes: agent.writes ?? {},
      created_files: agent.created_files ?? [],
      modified_files: agent.modified_files ?? [],
      test_results: agent.test_results ?? [],
      verification_hints: [
        ...(agent.verification_hints ?? []),
        'agent_execute is a compatibility escape hatch; prefer agent_run for new decisions.',
      ],
      next_actions: agent.next_actions ?? [],
      agent,
      error: agentResult.error,
      ...compatibilityReceiptFields(action),
    };
    result.boundary_risk = summarizeBoundaryRisk(action, result);

    store.recordEvolutionEvent({
      type: 'agent_execute',
      action_type: action.type,
      provider: result.provider,
      status: result.status,
      objective: getField(action, 'objective') ?? action.description ?? 'unspecified',
      mode: getField(action, 'mode') ?? 'propose',
      execution_root: result.execution_root,
      resource_kind: result.resource_kind,
      resource_scope: result.resource_scope,
      root_resolution_source: result.root_resolution_source,
      requires_approval: result.requires_approval,
      summary: result.message,
      boundary_risk: result.boundary_risk,
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async write_retrospective(action, ctx) {
    requireParams(action, ['summary']);
    const store = storeFrom(ctx);
    if (!retrospectiveEnrichmentRequested(action)) {
      const review = buildRetrospectiveRecord(action);
      const written = store.recordRetrospective(review);
      const result = {
        success: written > 0,
        status: written > 0 ? 'recorded' : 'failed',
        message: written > 0 ? 'retrospective recorded locally (host-backed write)' : 'retrospective was not recorded',
        provider: 'local',
        requires_approval: false,
        action_type: action.type,
        action_id: action.id ?? null,
        served_goal: review.served_goal,
        evidence: {},
        writes: { retrospectives: [review] },
        writes_applied: { retrospectives: written },
        fallback_used: false,
        verification_hints: written > 0
          ? ['write_retrospective records conclusions only; use agent_run when more evidence is needed.']
          : [],
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const agenticExecution = await runPhase2Agent(buildRetrospectiveEnrichmentAction(action), ctx, {
      mode: 'propose',
      objective: 'Execute a retrospective write. Return writes.retrospectives with the learning records the host should persist.',
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWritten = persistRetrospectiveWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        status: agenticExecution.status ?? 'recorded',
        message: `retrospective recorded from agent writes (${agentWritten})`,
        writes_applied: { retrospectives: agentWritten },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (!legacyFallbackAllowed(action)) {
      const result = missingAgentArtifactsResult(action, agenticExecution, 'writes.retrospectives');
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const review = buildRetrospectiveRecord(action);
    const written = store.recordRetrospective(review);
    const result = {
      success: written > 0,
      message: 'retrospective recorded',
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: true,
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async core_apply(action, ctx) {
    requireParams(action, ['target', 'rationale', 'boundary', 'acceptance', 'death_boundary']);
    const store = storeFrom(ctx);
    const policy = coreApplyPolicy();
    const approved = explicitApproval(action);
    const hasSandbox = sandboxConfigured(action);

    if (policy === 'disabled') {
      const result = {
        success: false,
        status: 'requires_human_review',
        message: 'core_apply is disabled by JEA_CORE_APPLY_POLICY; request_core_review or patch proposal is required',
        requires_approval: true,
        provider: null,
        policy,
        evidence: {},
        writes: {},
        fallback_used: false,
        verification_hints: ['Ordinary target-repo edits belong in agent_run + lane worktree, not core_apply.'],
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    if (policy === 'review' && !approved && !hasSandbox) {
      const result = {
        success: true,
        status: 'requires_human_review',
        message: 'core_apply requires explicit approval or a sandbox/worktree when JEA_CORE_APPLY_POLICY=review',
        requires_approval: true,
        provider: null,
        policy,
        evidence: {
          policy,
          target: getField(action, 'target') ?? action.description ?? 'unspecified',
          rationale: getField(action, 'rationale') ?? action.rationale ?? '',
        },
        writes: {},
        verification_hints: ['grant approval_granted=true, provide boundary.sandbox/worktree, or set JEA_CORE_APPLY_POLICY=auto'],
        fallback_used: false,
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const workspacePrep = prepareCoreApplyWorkspace(action, ctx);
    if (!workspacePrep.ok) {
      const result = {
        success: false,
        status: 'blocked',
        message: `core_apply could not prepare an isolated worktree: ${workspacePrep.error}`,
        requires_approval: true,
        provider: null,
        policy,
        evidence: {
          worktree_error: workspacePrep.error,
          target: getField(action, 'target') ?? action.description ?? 'unspecified',
        },
        writes: {},
        verification_hints: ['fix git worktree creation or provide boundary.worktree/boundary.sandbox/cwd explicitly'],
        fallback_used: false,
      };
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const executionAction = workspacePrep.action;
    const agenticExecution = await runPhase2Agent(executionAction, ctx, {
      mode: 'core_apply',
      objective: [
        'Execute this approved core-layer change as an auditable core_apply action.',
        'Modify and test only inside the provided boundary.worktree/cwd; do not apply changes to the source checkout directly.',
        'Return changed_files, diff_summary, tests_run or test_results, rollback_plan, and death_boundary_result.',
        'If you cannot safely apply the change, return requires_human_review with a patch proposal instead of mutating files.',
      ].join('\n'),
      acceptance: [
        'Return JSON with status, summary, evidence, writes, modified_files/created_files, test_results, verification_hints, next_actions.',
        'Evidence must include diff_summary, rollback_plan, and death_boundary_result.',
      ].join(' '),
    });
    if (!agenticExecution.success || agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      result.policy = policy;
      result.core_apply_workspace = workspacePrep.workspace;
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const audit = coreApplyAudit(agenticExecution, workspacePrep.workspace);
    const result = agentActionResult(action, agenticExecution, {
      success: true,
      status: agenticExecution.status ?? 'completed',
      message: agenticExecution.message || 'core_apply completed',
      policy,
      core_apply_workspace: workspacePrep.workspace,
      core_apply_audit: audit,
      verification_hints: audit.complete
        ? agenticExecution.verification_hints
        : [
          ...agenticExecution.verification_hints,
          'core_apply receipt is missing changed_files, diff_summary, test_results/tests_run, rollback_plan, or death_boundary_result',
        ],
    });
    store.recordActionReceipt(action, result, ctx);
    return result;
  },

  async request_core_review(action, ctx) {
    const store = storeFrom(ctx);
    const agenticExecution = await runPhase2Agent(action, ctx, {
      mode: 'propose',
      objective: 'Record a core-layer review request by returning writes.core_reviews. Do not mutate files and do not apply the requested core change.',
    });
    if (!agenticExecution.success && !agenticExecution.requires_approval) {
      const result = agentBlockedResult(agenticExecution);
      store.recordActionReceipt(action, result, ctx);
      return result;
    }
    const agentWritten = persistCoreReviewWrites(store, action, agenticExecution);
    if (agentWritten > 0) {
      const result = agentActionResult(action, agenticExecution, {
        success: true,
        message: 'core-layer request recorded for human review from agent writes; no mutation executed',
        requires_approval: true,
        status: 'requires_human_review',
        writes_applied: { core_reviews: agentWritten },
      });
      store.recordActionReceipt(action, result, ctx);
      return result;
    }

    const event = {
      type: 'core_review_requested',
      action_type: action.type,
      target: getField(action, 'target') ?? action.description ?? 'unspecified',
      rationale: getField(action, 'rationale') ?? action.rationale ?? '',
      risks: getField(action, 'risks') ?? [],
      approval_needed: true,
      status: 'requires_human_review',
    };
    store.recordEvolutionEvent(event);
    const result = {
      success: true,
      message: legacyFallbackAllowed(action)
        ? 'core-layer request recorded for human review via legacy fallback; no mutation executed'
        : 'core-layer request recorded for human review from action params; no mutation executed',
      requires_approval: true,
      status: 'requires_human_review',
      agentic_execution: agenticExecution,
      evidence: agenticExecution.evidence,
      writes: agenticExecution.writes,
      provider: agenticExecution.provider,
      fallback_used: legacyFallbackAllowed(action),
      writes_applied: { core_reviews: 1 },
    };
    store.recordActionReceipt(action, result, ctx);
    return result;
  },
};

export const actionHandlers = new Proxy(builtInActionHandlers, {
  get(target, prop, receiver) {
    if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
    if (getConfiguredExternalAction(prop)) {
      return async (action, ctx) => runConfiguredExternalActionHandler(action, ctx);
    }
    return undefined;
  },
  ownKeys(target) {
    return [
      ...Reflect.ownKeys(target),
      ...loadSubjectActionConfig().actions.map((action) => action.name),
    ];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (Reflect.has(target, prop)) return Reflect.getOwnPropertyDescriptor(target, prop);
    if (typeof prop === 'string' && getConfiguredExternalAction(prop)) {
      return { enumerable: true, configurable: true };
    }
    return undefined;
  },
});

const baseActionVerifiers = Object.fromEntries(
  Object.keys(actionHandlers).map((type) => [
    type,
    {
      verify(action, result) {
        const metric = result?.agentic_execution || result?.agent
          ? 'agent_action_result'
          : 'handler_receipt';
        const requiresApproval = Boolean(result?.requires_approval);
        const evidence_count = listCount(result?.evidence);
        const writes_count = listCount(result?.writes);
        const status = result?.success && !requiresApproval
          ? (type === 'run_probe' && !result?.fallback_used && evidence_count === 0 && writes_count === 0 ? 'partial' : 'improved')
          : (type === 'request_core_review' && result?.success && requiresApproval ? 'improved' : (requiresApproval ? 'partial' : 'blocked'));
        return {
          action,
          metric,
          value: {
            success: !!result?.success,
            status: result?.status ?? 'recorded',
            message: result?.message ?? '',
            provider: result?.provider ?? result?.agentic_execution?.provider ?? null,
            requires_approval: requiresApproval,
            fallback_used: !!result?.fallback_used,
            compatibility_action: !!result?.compatibility_action,
            escape_hatch_reason: result?.escape_hatch_reason ?? null,
            evidence_count,
            writes_count,
            verification_hints: result?.verification_hints ?? result?.agentic_execution?.verification_hints ?? [],
          },
          status,
        };
      },
    },
  ]),
);

export const actionVerifiers = {
  ...baseActionVerifiers,
  agent_run: {
    verify(action, result) {
      const evidence_count = listCount(result?.evidence);
      const writes_count = listCount(result?.writes);
      const outputs_count = listCount(result?.outputs);
      const expectedRoot = result?.run_spec?.primary_cwd ?? null;
      const actualRoot = result?.execution_root ?? result?.agent?.outputs?.claude?.options?.cwd ?? result?.agent?.outputs?.cursor?.options?.cwd ?? null;
      const rootMatches = !expectedRoot || !actualRoot || expectedRoot === actualRoot;
      const hasReceipt = Boolean(result?.agent && result?.status && result?.message);
      const hasEvidence = evidence_count > 0
        || writes_count > 0
        || outputs_count > 0
        || asArray(result?.modified_files).length > 0
        || asArray(result?.created_files).length > 0;
      const requiresApproval = Boolean(result?.requires_approval);
      const status = result?.success && hasReceipt && hasEvidence && rootMatches && !requiresApproval
        ? 'improved'
        : (hasReceipt ? 'partial' : 'blocked');
      const acceptanceStatus = result?.acceptance_status ?? (result?.success ? 'passed' : 'failed');
      const goalProgressStatus = result?.goal_progress_status ?? (status === 'improved' ? 'progressed' : 'not_progressed');
      return {
        action,
        metric: 'agent_run_receipt',
        value: {
          success: !!result?.success,
          status: result?.status ?? 'unknown',
          execution_status: result?.execution_status ?? result?.agent?.execution_status ?? null,
          schema_status: result?.schema_status ?? result?.agent?.schema_status ?? null,
          schema_missing: result?.schema_missing ?? result?.agent?.schema_missing ?? [],
          pipeline_status: result?.pipeline_status ?? null,
          agent_status: result?.agent_status ?? null,
          acceptance_status: acceptanceStatus,
          goal_progress_status: goalProgressStatus,
          provider: result?.provider ?? result?.agent?.provider ?? null,
          requires_approval: requiresApproval,
          execution_root: actualRoot,
          expected_root: expectedRoot,
          root_matches: rootMatches,
          additional_directories: result?.run_spec?.additional_directories ?? [],
          permission_profile: result?.run_spec?.permission_profile ?? null,
          evidence_count,
          writes_count,
          outputs_count,
          verification_hints: result?.verification_hints ?? [],
        },
        status: result?.status === 'blocked' || acceptanceStatus === 'blocked'
          ? 'blocked'
        : (goalProgressStatus === 'progressed' && ['passed', 'schema_invalid'].includes(acceptanceStatus) ? status : 'partial'),
      };
    },
  },
  core_apply: {
    verify(action, result) {
      const audit = result?.core_apply_audit ?? coreApplyAudit(result ?? {});
      const requiresApproval = Boolean(result?.requires_approval);
      const evidence_count = listCount(result?.evidence);
      const writes_count = listCount(result?.writes);
      const base = {
        action,
        metric: result?.agentic_execution || result?.agent ? 'agent_action_result' : 'handler_receipt',
        value: {
          success: !!result?.success,
          status: result?.status ?? 'unknown',
          message: result?.message ?? '',
          provider: result?.provider ?? result?.agentic_execution?.provider ?? null,
          requires_approval: requiresApproval,
          fallback_used: !!result?.fallback_used,
          evidence_count,
          writes_count,
          policy: result?.policy ?? coreApplyPolicy(),
          audit,
          verification_hints: result?.verification_hints ?? result?.agentic_execution?.verification_hints ?? [],
        },
      };
      if (!result?.success) return { ...base, status: requiresApproval ? 'partial' : 'blocked' };
      if (requiresApproval) return { ...base, status: 'partial' };
      return { ...base, status: audit.complete ? 'improved' : 'partial' };
    },
  },
  agent_execute: {
    verify(action, result) {
      const hasReceipt = Boolean(result?.provider && result?.status && result?.agent);
      const needsHuman = Boolean(result?.requires_approval);
      const evidence_count = listCount(result?.evidence);
      const writes_count = listCount(result?.writes);
      return {
        action,
        metric: 'agent_action_result',
        value: {
          success: !!result?.success,
          provider: result?.provider ?? null,
          status: result?.status ?? 'unknown',
          requires_approval: needsHuman,
          message: result?.message ?? '',
          compatibility_action: !!result?.compatibility_action,
          escape_hatch_reason: result?.escape_hatch_reason ?? null,
          fallback_used: !!result?.fallback_used,
          evidence_count,
          writes_count,
          modified_files: result?.modified_files ?? [],
          created_files: result?.created_files ?? [],
          test_results: result?.test_results ?? [],
          verification_hints: result?.verification_hints ?? [],
        },
        status: result?.success && hasReceipt && !needsHuman
          ? 'improved'
          : (hasReceipt ? 'partial' : 'blocked'),
      };
    },
  },
};

