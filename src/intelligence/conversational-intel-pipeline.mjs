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
} from './report-builder.mjs';
import {
  buildConversationSystemPrompt,
  buildDecideUserPrompt,
  buildReportUserPrompt,
} from './conversation-prompts.mjs';
import { persistPhase1ConversationContext } from './conversation-context.mjs';

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
      report: null,
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
        rules,
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
      };
      const preparedReport = prepareIntelReport({
        intelResult: preliminaryIntelResult,
        runtime: this.runtime,
        store: this.host?.intelligenceStore,
        agentContextDocs: this.agentContextDocs,
      });
      const reportPromptContext = toPreDecisionReportContext(preparedReport.reportContext);

      const systemPrompt = buildConversationSystemPrompt({
        agentContextDocs: this.agentContextDocs,
        actionRegistry: this.actionRegistry,
      });
      const reportUserPrompt = buildReportUserPrompt({
        cycleId,
        goalsText,
        rules,
        humanGuidance,
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
      const analysis = parseJsonFromText(this.aiClient, rawDecision);
      result.analysis = analysis;
      result.actions = Array.isArray(analysis?.actions) ? analysis.actions : [];
      result.conversation_context_path = persistPhase1ConversationContext({
        runtimeRoot: this.runtime.runtimeRoot,
        cycleId,
        timestamp: result.timestamp,
        goalId: this.goalId,
        runtime: this.runtime,
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
      });

      if (!dryRun) {
        const analysisContext = summarizeAnalysis(analysis);
        const draftDir = join(this.projectRoot, 'data', 'evolution', 'draft_issues', cycleId);
        mkdirSync(draftDir, { recursive: true });
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
        result.decisions_queued = this.decisionQueue.addDecisions({
          cycleId,
          actions: result.actions,
          analysisContext,
        });
        this._log(`wrote draft + queued ${result.decisions_queued.length} decision(s) at ${draftDir}`);
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
