import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvolutionEngine } from 'js-evolution-engine/engine';
import { AIDrivenObserver } from '../../node_modules/js-evolution-engine/src/observe/ai-driven-observer.mjs';
import { isoBeijing } from '../../node_modules/js-evolution-engine/src/core/time.mjs';
import {
  chatMessages,
  parseJsonFromText,
  serializeMessages,
} from '../ai/messages.mjs';
import { LocalDecisionQueue } from './decision-queue.mjs';
import {
  persistIntelReport,
  prepareIntelReport,
  updateStandingMemoryWithAi,
} from './report-builder.mjs';
import {
  buildConversationSystemPrompt,
  buildDecideUserPrompt,
  buildReportUserPrompt,
} from './conversation-prompts.mjs';
import {
  buildObservationEvidenceGuard,
  formatObservationEvidenceGuard,
} from './observation-guard.mjs';
import { persistPhase1ConversationContext } from './conversation-context.mjs';
import {
  formatOperatorBriefsForPrompt,
  markOperatorBriefsProcessed,
  readPendingOperatorBriefs,
  summarizeOperatorBriefsForContext,
} from './operator-briefs.mjs';
import { validateAgentRunSpec } from '../actions/agent-run-spec.mjs';

function summarizeAnalysis(analysis) {
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

function buildBriefing(cycle, context) {
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

function attachExecutionContext(action, {
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

function validateQueuedAction(action, ctx) {
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

function runtimeFromHost(projectRoot, host) {
  return {
    runtimeRoot: host?.runtimeRoot || projectRoot,
    subject: host?.subject || host?.appName || 'js-evolution-agent',
    dataNamespace: host?.dataNamespace || 'default',
  };
}

function toPreDecisionReportContext(reportContext) {
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

function safeQueueSummary(queue) {
  if (!queue || typeof queue.summarize !== 'function') return null;
  try {
    return queue.summarize();
  } catch {
    return null;
  }
}

function appendObservationGuard(rules, guardText) {
  return [rules || '', guardText || ''].filter(Boolean).join('\n\n');
}

function buildStandingMemoryExtraContext({
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
 * Host-side intel pipeline that makes two consecutive OpenAI-style message
 * calls: report first, then strict Analyze+Decide JSON using the full prior
 * conversation as context.
 */
export class ConversationalIntelligencePipeline {
  constructor({
    aiClient,
    host = null,
    projectRoot = null,
    goalId = null,
    mode = 'local',
    engine = null,
    decisionQueue = null,
    agentContextDocs = null,
    actionRegistry = null,
    runtime = null,
    updateStandingMemory = true,
  } = {}) {
    if (mode !== 'local') {
      throw new Error('ConversationalIntelligencePipeline currently supports mode=local only');
    }
    this.aiClient = aiClient;
    this.host = host;
    this.mode = mode;
    this.goalId = goalId;
    this.engine = engine || new EvolutionEngine({
      aiClient,
      host,
      projectRoot,
      goalId,
      actionRegistry,
      agentContextDocs,
    });
    this.projectRoot = projectRoot || this.engine.projectRoot;
    this.agentContextDocs = Array.isArray(agentContextDocs) ? agentContextDocs : [];
    this.actionRegistry = actionRegistry || this.engine.actionRegistry;
    this.runtime = runtime || runtimeFromHost(this.projectRoot, host);
    this.updateStandingMemory = updateStandingMemory;
    this.decisionQueue = decisionQueue || new LocalDecisionQueue({
      dataDir: join(this.projectRoot, 'data', 'evolution'),
      logFn: (msg) => this._log(msg),
    });
  }

  async run({ dryRun = false } = {}) {
    const cycleId = this.engine.cycleId;
    const result = {
      cycle_id: cycleId,
      timestamp: isoBeijing(),
      mode: this.mode,
      dry_run: dryRun,
      success: false,
      actions: [],
      issues_created: [],
      decisions_queued: [],
      decisions_skipped: [],
      report: null,
      standing_memory_update: null,
      error: null,
    };

    const logger = this.engine.evolutionLogger;
    let cycleEnded = false;

    try {
      this.engine.setGoalId(this.goalId);
      const goalsText = this.engine.goalProvider.formatForPrompt(this.goalId);
      const observeGoalsText = typeof this.engine.goalProvider.formatForObserve === 'function'
        ? this.engine.goalProvider.formatForObserve(this.goalId)
        : goalsText;
      const rules = this.engine.loadRules();
      const humanGuidance = this.engine.guidanceReader.readGuidance();
      const observationGuard = buildObservationEvidenceGuard({ subject: this.runtime.subject });
      const observationGuardText = formatObservationEvidenceGuard(observationGuard);
      const operatorBriefRead = readPendingOperatorBriefs(this.runtime.runtimeRoot);
      const operatorBriefs = operatorBriefRead.briefs;
      const operatorBriefsContext = summarizeOperatorBriefsForContext(operatorBriefs);
      const operatorBriefsPrompt = formatOperatorBriefsForPrompt(operatorBriefs);
      const intelligenceContext = this.host?.knowledgeWriter?.buildContextSummary?.() || '';

      logger.startCycle(cycleId);
      logger.setGoalId(this.goalId);
      logger.setAiDriven(true);
      logger.setDryRun(dryRun);

      this._log(`[${cycleId}] phase 1/3: observe`);
      logger.startPhase('observe');
      const observer = new AIDrivenObserver({
        aiClient: this.aiClient,
        host: this.host,
        evolutionLogger: logger,
        goalsText: observeGoalsText,
        rules: appendObservationGuard(rules, observationGuardText),
        projectRoot: this.projectRoot,
        logger: this.host?.logger,
      });
      const observation = await observer.observe();
      logger.logPhase('observe', {
        outputs: { ai_driven: observation.ai_driven },
        prompt: observation._prompt,
        aiResponse: observation.observation_report,
        aiDriven: true,
      });

      const preliminaryIntelResult = {
        ...result,
        success: true,
        actions: [],
        decisions_queued: [],
        decisions_skipped: [],
      };
      const queueSummary = safeQueueSummary(this.decisionQueue);
      const preparedReport = prepareIntelReport({
        intelResult: preliminaryIntelResult,
        runtime: this.runtime,
        store: this.host?.intelligenceStore,
        agentContextDocs: this.agentContextDocs,
        queueSummary,
        operatorBriefs: operatorBriefsContext,
      });
      const reportPromptContext = toPreDecisionReportContext(preparedReport.reportContext);

      const systemPrompt = buildConversationSystemPrompt({
        agentContextDocs: this.agentContextDocs,
        actionRegistry: this.actionRegistry,
      });
      const reportUserPrompt = buildReportUserPrompt({
        cycleId,
        language: preparedReport.language,
        goalsText,
        rules,
        humanGuidance,
        operatorBriefs: operatorBriefsPrompt,
        intelligenceContext,
        observationReport: observation.observation_report,
        reportContext: reportPromptContext,
      });
      const reportMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reportUserPrompt },
      ];

      this._log(`[${cycleId}] phase 2/3: conversational report`);
      logger.startPhase('intel_report');
      let reportMarkdown = null;
      let reportSource = 'fallback';
      let reportReason = null;
      try {
        const md = await chatMessages(this.aiClient, reportMessages, { thinking: 'medium', timeout: 600 });
        if (typeof md === 'string' && md.trim()) {
          reportMarkdown = md.trim() + '\n';
          reportSource = 'ai';
        } else {
          reportReason = 'empty-output';
        }
      } catch (e) {
        reportReason = e?.message || String(e);
        this._log(`report generation failed: ${reportReason}`, 'warning');
      }

      const persistedReport = await persistIntelReport({
        intelResult: preliminaryIntelResult,
        runtime: this.runtime,
        store: this.host?.intelligenceStore,
        agentContextDocs: this.agentContextDocs,
        aiClient: reportSource === 'ai' ? this.aiClient : null,
        logger: this.host?.logger,
        md: reportMarkdown,
        source: reportSource,
        fallbackReason: reportReason,
        updateStandingMemory: false,
        ...preparedReport,
      });
      reportMarkdown = persistedReport.markdown;
      result.report = persistedReport;
      logger.logPhase('intel_report', {
        outputs: {
          source: persistedReport.source,
          md_path: persistedReport.mdPath,
          language: persistedReport.indexRecord.language,
        },
        prompt: serializeMessages(reportMessages),
        aiResponse: reportMarkdown,
        aiDriven: reportSource === 'ai',
        fallbackUsed: reportSource !== 'ai',
        error: reportReason,
      });

      const decideUserPrompt = buildDecideUserPrompt({
        goalsText,
        rules,
        humanGuidance,
        operatorBriefs: operatorBriefsPrompt,
        intelligenceContext,
        observationReport: observation.observation_report,
        reportContext: preparedReport.reportContext,
        actionRegistry: this.actionRegistry,
      });
      const decideMessages = [
        ...reportMessages,
        { role: 'assistant', content: reportMarkdown },
        { role: 'user', content: decideUserPrompt },
      ];

      this._log(`[${cycleId}] phase 3/3: analyze + decide`);
      logger.startPhase('analyze_decide');
      const rawDecision = await chatMessages(this.aiClient, decideMessages, { thinking: 'medium', timeout: 600 });
      let analysis = null;
      let analysisParseError = null;
      try {
        analysis = parseJsonFromText(this.aiClient, rawDecision);
      } catch (e) {
        analysisParseError = e?.message || String(e);
        this._log(`analyze+decide JSON parse failed: ${analysisParseError}; deferring without actions`, 'warning');
        analysis = {
          analysis: {
            key_patterns: [],
            root_causes: {},
            opportunities: [],
          },
          decision: 'defer',
          rationale: `Analyze+Decide JSON was invalid; no actions were queued. ${analysisParseError}`,
          actions: [],
          goal_coverage: { covered: [], not_covered: {} },
          deferred: [{
            action: 'retry_analyze_decide',
            reason: analysisParseError,
            revisit_after: 'next cycle',
          }],
          risk_mitigation: ['Do not queue actions from invalid Analyze+Decide JSON.'],
          goal_suggestions: [],
          confidence_score: 0,
          error_code: 'invalid_ai_json',
          parse_error: analysisParseError,
        };
      }
      result.analysis = analysis;
      result.actions = Array.isArray(analysis?.actions) ? analysis.actions : [];
      result.conversation_context_path = persistPhase1ConversationContext({
        runtimeRoot: this.runtime.runtimeRoot,
        cycleId,
        timestamp: result.timestamp,
        goalId: this.goalId,
        runtime: this.runtime,
        operatorBriefs: operatorBriefsContext,
        observation,
        reportMessages,
        reportMarkdown,
        reportSource: persistedReport.source,
        reportPath: persistedReport.mdPath,
        decideMessages,
        rawDecision,
        analysis,
        actions: result.actions,
      });
      logger.logPhase('analyze_decide', {
        outputs: {
          decision: analysis?.decision,
          actions_count: result.actions.length,
          conversation_context_path: result.conversation_context_path,
        },
        prompt: serializeMessages(decideMessages),
        aiResponse: rawDecision,
        aiDriven: true,
        fallbackUsed: Boolean(analysisParseError),
        error: analysisParseError,
      });

      this._log(`[${cycleId}] phase 3b: standing memory`);
      logger.startPhase('standing_memory');
      const shouldUpdateStandingMemory = this.updateStandingMemory && !dryRun;
      const memoryUpdate = shouldUpdateStandingMemory
        ? await updateStandingMemoryWithAi({
          aiClient: this.aiClient,
          store: this.host?.intelligenceStore,
          language: preparedReport.language,
          reportContext: preparedReport.reportContext,
          reportMarkdown,
          cycleId,
          generatedAt: result.timestamp,
          logger: this.host?.logger,
          extraContext: buildStandingMemoryExtraContext({
            analysis,
            actions: result.actions,
            reportPath: persistedReport.mdPath,
            conversationContextPath: result.conversation_context_path,
          }),
        })
        : { status: 'skipped', reason: dryRun ? 'dry-run' : 'disabled' };
      result.standing_memory_update = memoryUpdate;
      logger.logPhase('standing_memory', {
        outputs: {
          status: memoryUpdate.status,
          reason: memoryUpdate.reason,
        },
        aiDriven: shouldUpdateStandingMemory,
        fallbackUsed: false,
        error: memoryUpdate.status === 'failed' ? memoryUpdate.reason : null,
      });

      if (!dryRun) {
        const analysisContext = summarizeAnalysis(analysis);
        const draftDir = join(this.projectRoot, 'data', 'evolution', 'draft_issues', cycleId);
        mkdirSync(draftDir, { recursive: true });
        result.actions = result.actions.map((action) => attachExecutionContext(action, {
          reportPath: persistedReport.mdPath,
          conversationContextPath: result.conversation_context_path,
          reportMarkdown,
          analysisContext,
        }));
        writeFileSync(
          join(draftDir, 'briefing.md'),
          buildBriefing({
            cycle_id: cycleId,
            timestamp: result.timestamp,
            goal_id: this.goalId,
            actions: result.actions,
          }, analysisContext),
          'utf-8',
        );
        writeFileSync(
          join(draftDir, 'issues.json'),
          JSON.stringify({ cycle_id: cycleId, actions: result.actions }, null, 2),
          'utf-8',
        );
        const queued = this.decisionQueue.addDecisionsDetailed
          ? this.decisionQueue.addDecisionsDetailed({
            cycleId,
            actions: result.actions,
            analysisContext,
            metadata: {
              report_path: persistedReport.mdPath,
              conversation_context_path: result.conversation_context_path,
            },
            validateAction: (action) => validateQueuedAction(action, {
              projectRoot: this.projectRoot,
              host: this.host,
              runtime: this.runtime,
              cycleId,
            }),
          })
          : { ids: this.decisionQueue.addDecisions({
            cycleId,
            actions: result.actions,
            analysisContext,
          }), skipped: [] };
        result.decisions_queued = queued.ids;
        result.decisions_skipped = queued.skipped;
        this._log(`wrote draft + queued ${result.decisions_queued.length} decision(s), skipped ${result.decisions_skipped.length} at ${draftDir}`);
        const processedBriefs = markOperatorBriefsProcessed(this.runtime.runtimeRoot, operatorBriefs, {
          cycleId,
          outcome: result.decisions_queued.length ? 'consumed_with_decisions' : 'consumed_without_decisions',
        });
        result.operator_briefs = {
          pending_read: operatorBriefsContext,
          invalid: operatorBriefRead.invalid,
          processed: processedBriefs,
        };
      }

      result.success = true;
      logger.endCycle(true);
      cycleEnded = true;
    } catch (e) {
      result.error = e?.message || String(e);
      this._log(`conversational intel pipeline failed: ${result.error}`, 'error');
      if (!cycleEnded) logger.endCycle(false, result.error);
    }

    return result;
  }

  _log(msg, level = 'info') {
    const logger = this.host?.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[intel] ${msg}`);
  }
}
