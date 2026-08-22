/**
 * Shared Phase-1 helpers used by classic conversational intel and report-centric agent_loop.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAgentRunSpec } from '../actions/agent-run-spec.mjs';
import { missingRequiredActionParams } from '../actions/registry.mjs';
import { extractBeliefContext } from '../contracts/belief-context.mjs';
import { validateActionShape } from '../contracts/decision.mjs';
import { resolveHostExternalRoots } from '../infra/subjects.mjs';
import { markOperatorBriefsProcessed } from './operator-briefs.mjs';

export const BELIEF_BOUND_ACTION_TYPES = new Set([
  'agent_run',
  'agent_execute',
  'run_probe',
  'propose_probe',
]);

const BELIEF_RELATIONS = new Set([
  'test_belief',
  'strengthen_belief',
  'refute_belief',
  'create_belief',
  'recover_blocker',
]);

function actionExpectedOutput(action) {
  const runSpec = action?.params?.run_spec
    ?? action?.params?.runSpec
    ?? action?.run_spec
    ?? action?.runSpec
    ?? {};
  return runSpec.expected_output ?? runSpec.expectedOutput ?? null;
}

function validateBeliefIntent(action, decisionContext) {
  if (!decisionContext || typeof decisionContext !== 'object') return { valid: true };
  const context = extractBeliefContext(action);
  const beliefId = typeof context.belief_id === 'string' ? context.belief_id.trim() : '';
  const relation = typeof context.belief_relation === 'string' ? context.belief_relation.trim() : '';
  const expectedUpdate = typeof context.expected_belief_update === 'string'
    ? context.expected_belief_update.trim()
    : '';
  const noBeliefReason = typeof context.no_belief_reason === 'string'
    ? context.no_belief_reason.trim()
    : '';
  const requiresBinding = BELIEF_BOUND_ACTION_TYPES.has(action?.type);

  if (!beliefId && !relation && !expectedUpdate) {
    if (requiresBinding) {
      return {
        valid: false,
        errors: [`belief_binding_required: ${action?.type || 'unknown'} requires belief_id, belief_relation, expected_belief_update`],
      };
    }
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(noBeliefReason)) {
      return {
        valid: false,
        errors: ['belief_exemption_required: params.context.no_belief_reason must be a machine-readable snake_case code'],
      };
    }
    return { valid: true };
  }

  const errors = [];
  if (!beliefId) errors.push('belief_id is required');
  if (!BELIEF_RELATIONS.has(relation)) {
    errors.push(`belief_relation must be one of: ${[...BELIEF_RELATIONS].join(', ')}`);
  }
  if (!expectedUpdate) errors.push('expected_belief_update is required');
  if (errors.length) return { valid: false, errors };

  const beliefs = decisionContext.current_beliefs ?? {};
  const active = Array.isArray(beliefs.active) ? beliefs.active : [];
  const validated = Array.isArray(beliefs.validated) ? beliefs.validated : [];
  const refuted = Array.isArray(beliefs.refuted)
    ? beliefs.refuted
    : (Array.isArray(beliefs.recently_refuted) ? beliefs.recently_refuted : []);
  const retired = Array.isArray(beliefs.retired) ? beliefs.retired : [];
  const canonical = Array.isArray(beliefs.beliefs) ? beliefs.beliefs : [];
  const activeIds = new Set([...active, ...validated].map((belief) => belief?.id).filter(Boolean));
  const refutedIds = new Set(refuted.map((belief) => belief?.id).filter(Boolean));
  const existingIds = new Set(
    [...active, ...validated, ...refuted, ...retired, ...canonical]
      .map((belief) => belief?.id)
      .filter(Boolean),
  );
  const bootstrapIds = decisionContext.bootstrap_belief_ids instanceof Set
    ? decisionContext.bootstrap_belief_ids
    : new Set(decisionContext.bootstrap_belief_ids ?? []);

  if (relation === 'create_belief') {
    const expectedClaim = typeof (
      context.expected_belief_claim
      ?? context.belief_claim
      ?? context.claim
    ) === 'string'
      ? String(context.expected_belief_claim ?? context.belief_claim ?? context.claim).trim()
      : '';
    const expectedOutput = actionExpectedOutput(action);
    if (action?.type !== 'agent_run') {
      errors.push('create_belief is restricted to agent_run');
    }
    if (!expectedClaim) errors.push('expected_belief_claim is required for create_belief');
    if (!Array.isArray(expectedOutput) || !expectedOutput.some((item) => (
      typeof item === 'string' && item.trim()
    ))) {
      errors.push('run_spec.expected_output must contain at least one claim for create_belief');
    }
    if (existingIds.has(beliefId)) {
      errors.push(`belief_id_already_exists: ${beliefId}`);
    }
    if (existingIds.size > 0) {
      errors.push('create_belief_bootstrap_requires_fresh_subject');
    }
    if (bootstrapIds.has(beliefId)) {
      errors.push(`create_belief_duplicate_in_batch: ${beliefId}`);
    } else if (bootstrapIds.size > 0) {
      errors.push('create_belief_bootstrap_allows_one_belief');
    }
    return errors.length ? { valid: false, errors } : { valid: true, bootstrap_belief_id: beliefId };
  }

  if (activeIds.has(beliefId) || bootstrapIds.has(beliefId)) return { valid: true };
  if (refutedIds.has(beliefId)) {
    if (relation === 'recover_blocker') return { valid: true };
    return {
      valid: false,
      errors: [`belief_refuted_requires_recovery: ${beliefId} must use recover_blocker`],
    };
  }
  return { valid: false, errors: [`belief_id_unknown: ${beliefId}`] };
}

export function summarizeAnalysis(analysis) {
  if (!analysis) return '';
  if (typeof analysis === 'string') return analysis.slice(0, 3000);
  const a = analysis.analysis || analysis;
  const parts = [];
  if (a.key_patterns?.length) {
    parts.push(`Key patterns: ${a.key_patterns.slice(0, 5).join('; ')}`);
  }
  if (a.root_causes) {
    parts.push(`Root causes: ${JSON.stringify(a.root_causes)}`);
  }
  if (analysis.rationale) parts.push(`Rationale: ${analysis.rationale}`);
  return parts.join('\n').slice(0, 3000);
}

export function buildBriefing(cycle, context) {
  const lines = [
    `# OADA Intelligence Briefing - ${cycle.cycle_id}`,
    `*Generated:* ${cycle.timestamp}`,
    cycle.goal_id ? `*Focus goal:* \`${cycle.goal_id}\`` : '',
    '',
    '## Summary',
    context || '(no analysis context)',
    '',
    `## Decisions (${cycle.actions.length})`,
  ];
  for (const a of cycle.actions) {
    lines.push(`- **[${a.type}]** ${a.description || ''} (priority: ${a.priority || 'medium'})`);
    if (a.serves_goal) lines.push(`  - serves: ${a.serves_goal}`);
    if (a.expected_impact) lines.push(`  - impact: ${a.expected_impact}`);
  }
  return lines.join('\n');
}

export function attachExecutionContext(action, {
  reportPath = null,
  conversationContextPath = null,
  reportMarkdown = null,
  analysisContext = '',
} = {}) {
  if (action?.type !== 'agent_run') return action;
  const params = action.params && typeof action.params === 'object' ? action.params : {};
  const runSpec = params.run_spec && typeof params.run_spec === 'object' ? params.run_spec : {};
  const context = runSpec.context && typeof runSpec.context === 'object'
    ? runSpec.context
    : { notes: runSpec.context ?? null };
  return {
    ...action,
    params: {
      ...params,
      run_spec: {
        ...runSpec,
        context: {
          ...context,
          phase1_report_path: context.phase1_report_path ?? reportPath,
          phase1_conversation_context_path: context.phase1_conversation_context_path ?? conversationContextPath,
          phase1_report_markdown: context.phase1_report_markdown ?? reportMarkdown,
          analysis_context: context.analysis_context ?? analysisContext,
        },
      },
    },
  };
}

export function validateQueuedAction(action, ctx) {
  const shape = validateActionShape(action);
  if (!shape.ok) {
    return { valid: false, errors: shape.errors };
  }
  const missing = missingRequiredActionParams(action);
  if (missing.length) {
    return { valid: false, errors: [`missing required field(s): ${missing.join(', ')}`] };
  }
  const beliefValidation = validateBeliefIntent(action, ctx?.beliefDecisionContext);
  if (action.type !== 'agent_run') return beliefValidation;
  try {
    const validation = validateAgentRunSpec(action, ctx);
    return {
      valid: validation.valid && beliefValidation.valid,
      errors: [
        ...(validation.errors ?? []),
        ...(beliefValidation.errors ?? []),
      ],
      warnings: validation.warnings,
      run_spec: {
        primary_cwd: validation.spec?.primary_cwd ?? null,
        primary_cwd_kind: validation.spec?.primary_cwd_kind ?? null,
        permission_profile: validation.spec?.permission_profile ?? null,
      },
    };
  } catch (e) {
    return { valid: false, errors: [e?.message || String(e)] };
  }
}

export function toPreDecisionReportContext(reportContext) {
  const current = reportContext?.current_cycle || {};
  return {
    ...reportContext,
    current_cycle: {
      cycle_id: current.cycle_id ?? null,
      mode: current.mode ?? null,
      stage: 'pre_analyze_decide_report',
      note: 'Only pre-decision evidence is available at this stage.',
    },
  };
}

export function safeQueueSummary(queue) {
  if (!queue || typeof queue.summarize !== 'function') return null;
  try {
    return queue.summarize();
  } catch {
    return null;
  }
}

export function safeBacklogSummary(queue, { limit = 15 } = {}) {
  if (!queue || typeof queue.getBacklogSummary !== 'function') return null;
  try {
    return queue.getBacklogSummary({ limit });
  } catch {
    return null;
  }
}

/**
 * Apply Decide queue_ops against DecisionQueue with status guards.
 * @returns {{ applied: object[], skipped: object[] }}
 */
export function applyQueueOps(decisionQueue, queueOps = [], {
  emitEvent = null,
  cycleId = null,
} = {}) {
  const applied = [];
  const skipped = [];
  if (!decisionQueue || !Array.isArray(queueOps) || !queueOps.length) {
    return { applied, skipped };
  }
  for (const opItem of queueOps) {
    const op = opItem?.op;
    const id = opItem?.id;
    if (!op || !id) {
      skipped.push({ ...opItem, reason: 'invalid_op' });
      continue;
    }
    let result;
    if (op === 'requeue') {
      if (typeof decisionQueue.requeueDecision !== 'function') {
        skipped.push({ op, id, reason: 'unsupported' });
        continue;
      }
      result = decisionQueue.requeueDecision(id);
    } else if (op === 'retire') {
      if (typeof decisionQueue.retireDecision !== 'function') {
        skipped.push({ op, id, reason: 'unsupported' });
        continue;
      }
      result = decisionQueue.retireDecision(id, opItem.reason || '');
    } else {
      skipped.push({ op, id, reason: 'unknown_op' });
      continue;
    }
    if (result?.ok) {
      const entry = { op, id, status: result.status, reason: opItem.reason || null };
      applied.push(entry);
      if (typeof emitEvent === 'function') {
        try {
          emitEvent({
            type: 'decide_queue_op',
            status: 'ok',
            cycle_id: cycleId,
            op,
            decision_id: id,
            reason: opItem.reason || null,
          });
        } catch { /* ignore */ }
      }
    } else {
      skipped.push({
        op,
        id,
        reason: result?.reason || 'rejected',
        status: result?.status ?? null,
      });
    }
  }
  return { applied, skipped };
}

/**
 * Render Decision Backlog for Decide dynamic payload.
 */
export function formatDecisionBacklogForPrompt(backlog, { language = 'zh' } = {}) {
  if (!backlog) return '';
  const pendingCount = backlog.pending_count ?? 0;
  const blockedCount = backlog.blocked_count ?? 0;
  if (pendingCount === 0 && blockedCount === 0) return '';

  const isEn = String(language).toLowerCase().startsWith('en');
  const lines = [
    '## Decision Backlog',
    '',
    isEn
      ? 'Structured cross-cycle queue state (not narrative carryover). Pending items continue automatically — do not re-enqueue duplicates (fingerprint dedupes). Blocked items require queue_ops (requeue or retire).'
      : '跨轮结构化队列状态（非叙事 carryover）。pending 会自动继续执行——不要重复入队（fingerprint 去重）。blocked 必须通过 queue_ops（requeue 或 retire）表态。',
    '',
    `pending_count: ${pendingCount}`,
    `blocked_count: ${blockedCount}`,
  ];
  if (backlog.truncated) {
    lines.push(isEn ? '(list truncated; counts are complete)' : '（列表已截断；计数完整）');
  }

  const renderItems = (label, items) => {
    if (!items?.length) return;
    lines.push('', `### ${label}`);
    for (const item of items) {
      const bits = [
        item.id,
        `type=${item.type}`,
        `attempts=${item.attempts ?? 0}/${item.max_attempts ?? '?'}`,
      ];
      if (item.permission_profile) bits.push(`profile=${item.permission_profile}`);
      if (item.serves_goal) bits.push(`goal=${item.serves_goal}`);
      if (item.last_error) bits.push(`err=${item.last_error}`);
      if (item.description) bits.push(item.description);
      lines.push(`- ${bits.join(' | ')}`);
    }
  };
  renderItems('blocked', backlog.blocked);
  renderItems('pending', backlog.pending);
  return lines.join('\n');
}

export function buildStandingMemoryExtraContext({
  analysis,
  actions,
  reportPath,
  conversationContextPath,
} = {}) {
  return {
    stage: 'post_analyze_decide',
    report_path: reportPath ?? null,
    conversation_context_path: conversationContextPath ?? null,
    decision: analysis?.decision ?? null,
    rationale: analysis?.rationale ?? null,
    actions: (actions || []).map((a) => ({
      type: a.type,
      description: a.description,
      serves_goal: a.serves_goal,
      priority: a.priority,
      expected_impact: a.expected_impact,
      risk: a.risk,
    })),
    goal_coverage: analysis?.goal_coverage ?? null,
    deferred: analysis?.deferred ?? [],
    risk_mitigation: analysis?.risk_mitigation ?? [],
    confidence_score: analysis?.confidence_score ?? null,
  };
}

/**
 * Attach report context to actions, write draft briefing, queue decisions, archive briefs.
 */
export async function queueAnalyzeDecideActions({
  projectRoot,
  host = null,
  runtime = null,
  decisionQueue,
  cycleId,
  timestamp,
  goalId = null,
  analysis,
  actions = [],
  reportPath = null,
  conversationContextPath = null,
  reportMarkdown = null,
  operatorBriefs = [],
  /** @deprecated Ignored: Decide actions are fully enqueued (no JEA_EXEC_LIMIT truncation). */
  maxActions = null,
  pipeline,
  batchId = null,
  beliefDecisionContext = null,
} = {}) {
  if (pipeline == null || pipeline === '') {
    throw new Error('queueAnalyzeDecideActions requires an explicit pipeline (phases | agent_loop | reactor)');
  }
  void maxActions; // retained for call-site compatibility; never truncates
  const analysisContext = summarizeAnalysis(analysis);
  const toQueue = Array.isArray(actions) ? [...actions] : [];

  const emitEvent = (event) => {
    try {
      host?.intelligenceStore?.recordEvolutionEvent?.(event);
    } catch { /* ignore */ }
  };
  const queueOpsResult = applyQueueOps(decisionQueue, analysis?.queue_ops || [], {
    emitEvent,
    cycleId,
  });

  const draftDir = join(projectRoot, 'data', 'evolution', 'draft_issues', cycleId);
  mkdirSync(draftDir, { recursive: true });
  const enriched = toQueue.map((action) => attachExecutionContext(action, {
    reportPath,
    conversationContextPath,
    reportMarkdown,
    analysisContext,
  }));
  writeFileSync(
    join(draftDir, 'briefing.md'),
    buildBriefing({
      cycle_id: cycleId,
      timestamp,
      goal_id: goalId,
      actions: enriched,
    }, analysisContext),
    'utf-8',
  );
  writeFileSync(
    join(draftDir, 'issues.json'),
    JSON.stringify({ cycle_id: cycleId, actions: enriched }, null, 2),
    'utf-8',
  );

  if (enriched.length > 0 && host) {
    const jeaRoot = host?.sourceRoot ?? projectRoot;
    const subject = runtime?.subject ?? host?.subject ?? null;
    try {
      const { externalRoots, subjectRepoLane } = await resolveHostExternalRoots({
        root: jeaRoot,
        subject,
      });
      host.externalRoots = externalRoots;
      host.resourceRoots = externalRoots;
      host.subjectRepoLane = subjectRepoLane;
    } catch {
      // refresh failure should not block queue; validate will catch bad specs
    }
  }

  const bootstrapBeliefIds = new Set();
  const queued = decisionQueue.addDecisionsDetailed
    ? decisionQueue.addDecisionsDetailed({
      cycleId,
      actions: enriched,
      analysisContext,
      metadata: {
        report_path: reportPath,
        conversation_context_path: conversationContextPath,
        pipeline,
        ...(batchId ? { producer_batch_id: batchId } : {}),
        ...(pipeline === 'reactor' && cycleId ? { reaction_id: cycleId, producer: 'cognitive' } : {}),
      },
      validateAction: (action) => {
        const validation = validateQueuedAction(action, {
          projectRoot: host?.sourceRoot ?? projectRoot,
          host,
          runtime,
          cycleId,
          beliefDecisionContext: beliefDecisionContext
            ? { ...beliefDecisionContext, bootstrap_belief_ids: bootstrapBeliefIds }
            : null,
        });
        if (validation.valid) {
          const context = extractBeliefContext(action);
          if (context.belief_relation === 'create_belief' && context.belief_id) {
            bootstrapBeliefIds.add(context.belief_id);
          }
        }
        return validation;
      },
    })
    : {
      ids: decisionQueue.addDecisions({
        cycleId,
        actions: enriched,
        analysisContext,
      }),
      skipped: [],
    };

  const runtimeRoot = runtime?.runtimeRoot || projectRoot;
  const processedBriefs = markOperatorBriefsProcessed(runtimeRoot, operatorBriefs, {
    cycleId,
    batchId,
    outcome: queued.ids?.length ? 'consumed_with_decisions' : 'consumed_without_decisions',
  });

  return {
    actions: enriched,
    decisions_queued: queued.ids || [],
    decisions_skipped: queued.skipped || [],
    deferred_overflow: [],
    queue_ops_applied: queueOpsResult.applied,
    queue_ops_skipped: queueOpsResult.skipped,
    operator_briefs_processed: processedBriefs,
    analysisContext,
    draftDir,
  };
}
