/**
 * Shared Phase-1 helpers used by classic conversational intel and report-centric agent_loop.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateAgentRunSpec } from '../actions/agent-run-spec.mjs';
import { resolveHostExternalRoots } from '../infra/subjects.mjs';
import { markOperatorBriefsProcessed } from './operator-briefs.mjs';

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
  if (action?.type !== 'agent_run') return { valid: true };
  const validation = validateAgentRunSpec(action, ctx);
  return {
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    run_spec: {
      primary_cwd: validation.spec?.primary_cwd ?? null,
      primary_cwd_kind: validation.spec?.primary_cwd_kind ?? null,
      permission_profile: validation.spec?.permission_profile ?? null,
    },
  };
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
} = {}) {
  if (pipeline == null || pipeline === '') {
    throw new Error('queueAnalyzeDecideActions requires an explicit pipeline (phases | agent_loop)');
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

  const queued = decisionQueue.addDecisionsDetailed
    ? decisionQueue.addDecisionsDetailed({
      cycleId,
      actions: enriched,
      analysisContext,
      metadata: {
        report_path: reportPath,
        conversation_context_path: conversationContextPath,
        pipeline,
      },
      validateAction: (action) => validateQueuedAction(action, {
        projectRoot: host?.sourceRoot ?? projectRoot,
        host,
        runtime,
        cycleId,
      }),
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
