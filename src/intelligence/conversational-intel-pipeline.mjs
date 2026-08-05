import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AIDrivenObserver,
  EvolutionEngine,
  isoBeijing,
} from '../engine/index.mjs';
import {
  chatMessagesDetailed,
  serializeMessages,
} from '../ai/messages.mjs';
import {
  accumulateLlmUsage,
  buildPromptCacheMetadata,
  formatLlmUsageSummary,
  markPromptCacheInvariant,
  summarizeLlmUsage,
} from '../ai/prompt-cache-metadata.mjs';
import { createHostDecisionQueue } from './decision-queue.mjs';
import {
  assembleHostSeenBody,
  auditHostSeenReport,
  spliceHostSeen,
} from './host-seen.mjs';
import { parseAnalyzeDecisionWithRepair } from './decide-json.mjs';
import { repairReportIfNeeded } from './report-repair.mjs';
import {
  buildSeenSection,
  persistIntelReport,
  prepareIntelReport,
  updateStandingMemoryWithAi,
} from './report-builder.mjs';
import {
  buildConversationSystemPromptParts,
  buildDecideUserPromptParts,
  buildReportUserPromptParts,
} from './conversation-prompts.mjs';

// Re-export for backward-compatible test/import paths.
export {
  normalizeAnalyzeDecision,
  parseAnalyzeDecisionWithRepair,
} from './decide-json.mjs';
import {
  buildObservationEvidenceGuard,
  formatObservationEvidenceGuard,
} from './observation-guard.mjs';
import { persistPhase1ConversationContext } from './conversation-context.mjs';
import {
  formatOperatorBriefsForPrompt,
  readPendingOperatorBriefs,
  summarizeOperatorBriefsForContext,
} from './operator-briefs.mjs';
import { resolveHostExternalRoots } from '../cli/utils/subjects.mjs';
import {
  buildStandingMemoryExtraContext,
  formatDecisionBacklogForPrompt,
  queueAnalyzeDecideActions,
  safeBacklogSummary,
  safeQueueSummary,
  toPreDecisionReportContext,
} from './phase1-shared.mjs';

export { toPreDecisionReportContext, queueAnalyzeDecideActions } from './phase1-shared.mjs';

function runtimeFromHost(projectRoot, host) {
  return {
    runtimeRoot: host?.runtimeRoot || projectRoot,
    subject: host?.subject || host?.appName || 'js-evolution-agent',
    dataNamespace: host?.dataNamespace || 'default',
  };
}

function appendObservationGuard(rules, guardText) {
  return [rules || '', guardText || ''].filter(Boolean).join('\n\n');
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
    this.decisionQueue = decisionQueue || createHostDecisionQueue({
      dataDir: join(this.projectRoot, 'data', 'evolution'),
      logFn: (msg) => this._log(msg),
    });
  }

  async _refreshHostExternalRoots() {
    const jeaRoot = this.host?.sourceRoot ?? this.projectRoot;
    const subject = this.runtime?.subject ?? this.host?.subject ?? null;
    const { externalRoots, subjectRepoLane } = await resolveHostExternalRoots({
      root: jeaRoot,
      subject,
    });
    this.host = {
      ...(this.host || {}),
      externalRoots,
      resourceRoots: externalRoots,
      subjectRepoLane,
    };
    if (this.engine?.host) {
      this.engine.host = this.host;
    }
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
      if (this.host?.subjectResources) {
        preparedReport.reportContext.subject_resources = this.host.subjectResources;
      }
      const reportPromptContext = toPreDecisionReportContext(preparedReport.reportContext);
      const mechanicalSeen = buildSeenSection(preparedReport.reportContext) || '(none)';
      const hostSeenBody = assembleHostSeenBody({
        reportContext: preparedReport.reportContext,
        queueSummary,
        operatorBriefs: operatorBriefsContext,
        mechanicalSeen,
        verifiedFacts: [],
      });

      const systemPromptParts = buildConversationSystemPromptParts({
        agentContextDocs: this.agentContextDocs,
        actionRegistry: this.actionRegistry,
      });
      const systemPrompt = systemPromptParts.content;
      const reportPromptParts = buildReportUserPromptParts({
        cycleId,
        language: preparedReport.language,
        goalsText,
        rules,
        humanGuidance,
        operatorBriefs: operatorBriefsPrompt,
        intelligenceContext,
        observationReport: observation.observation_report,
        reportContext: reportPromptContext,
        hostSeenBody,
      });
      const reportUserPrompt = reportPromptParts.content;
      const reportMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reportUserPrompt },
      ];
      const reportPromptCache = buildPromptCacheMetadata({
        profile: 'phase1_report',
        messages: reportMessages,
        stablePrefix: [systemPromptParts.stablePrefix, reportPromptParts.stablePrefix].join('\n\n--- stable turn ---\n\n'),
        dynamicPayload: reportPromptParts.dynamicPayload,
      });
      const reportPromptCacheInvariant = markPromptCacheInvariant({
        scope: 'phase1_report',
        metadata: reportPromptCache,
        logger: this.host?.logger,
      });

      const recordsDir = join(
        this.runtime.runtimeRoot,
        'data',
        'evolution',
        'records',
        cycleId,
      );
      mkdirSync(recordsDir, { recursive: true });
      const rawReportPath = join(recordsDir, 'phases_report_raw.md');

      this._log(`[${cycleId}] phase 2/3: conversational report (host Seen splice)`);
      logger.startPhase('intel_report');
      let reportSource = 'fallback';
      let reportReason = null;
      let rawReportMarkdown = null;
      let reportUsageSummary = null;
      try {
        const reportResult = await chatMessagesDetailed(this.aiClient, reportMessages, {
          thinking: 'medium',
          timeout: 600,
          phase: 'report',
        });
        const md = reportResult?.text;
        reportUsageSummary = summarizeLlmUsage(reportResult?.usage);
        if (typeof md === 'string' && md.trim()) {
          rawReportMarkdown = `${md.trim()}\n`;
          reportSource = 'ai';
        } else {
          reportReason = 'empty-output';
        }
      } catch (e) {
        reportReason = e?.message || String(e);
        this._log(`report generation failed: ${reportReason}`, 'warning');
      }
      const reportUsageLog = formatLlmUsageSummary(reportUsageSummary, 'prompt-cache phase1_report');
      if (reportUsageLog) this._log(reportUsageLog);

      if (rawReportMarkdown) {
        writeFileSync(rawReportPath, rawReportMarkdown, 'utf-8');
      } else if (!existsSync(rawReportPath)) {
        writeFileSync(rawReportPath, '', 'utf-8');
      }

      const store = this.host?.intelligenceStore;
      let persistReportMarkdown = rawReportMarkdown;
      let reportRepair = {
        rounds: 0,
        attempted: false,
        repaired: false,
        gave_up: false,
        findings_initial: [],
        findings_final: [],
      };
      let reportRepairUsageSummaries = [];
      let repairedReportPath = null;
      if (reportSource === 'ai' && rawReportMarkdown) {
        const repaired = await repairReportIfNeeded({
          aiClient: this.aiClient,
          store,
          reportMessages,
          rawReportMarkdown,
          hostSeenBody,
          language: preparedReport.language,
          logger: this.host?.logger,
          label: 'phases',
        });
        persistReportMarkdown = repaired.rawReportMarkdown;
        reportRepair = repaired.repair;
        reportRepairUsageSummaries = repaired.usageSummaries || [];
        if (reportRepair.rounds > 0 && persistReportMarkdown) {
          repairedReportPath = join(recordsDir, 'phases_report_repaired.md');
          writeFileSync(repairedReportPath, persistReportMarkdown, 'utf-8');
        }
        if (reportRepair.findings_initial?.length) {
          store?.recordEvolutionEvent?.({
            type: 'intel_report_repair',
            pipeline: 'phases',
            cycle_id: cycleId,
            subject: this.runtime?.subject,
            status: reportRepair.repaired
              ? 'repaired'
              : (reportRepair.rounds ? 'gave_up' : 'skipped'),
            rounds: reportRepair.rounds,
            findings_initial: reportRepair.findings_initial,
            findings_final: reportRepair.findings_final,
          });
        }
      }

      const persistedReport = await persistIntelReport({
        intelResult: preliminaryIntelResult,
        runtime: this.runtime,
        store,
        agentContextDocs: this.agentContextDocs,
        aiClient: reportSource === 'ai' ? this.aiClient : null,
        logger: this.host?.logger,
        md: persistReportMarkdown,
        source: reportSource,
        fallbackReason: reportReason,
        updateStandingMemory: false,
        transformMd: (md) => spliceHostSeen(md, hostSeenBody),
        ...preparedReport,
      });
      const reportMarkdown = persistedReport.markdown;
      persistedReport.raw_md_path = rawReportPath;
      persistedReport.repair = {
        rounds: reportRepair.rounds,
        repaired: reportRepair.repaired,
        gave_up: reportRepair.gave_up,
      };
      if (repairedReportPath) persistedReport.repaired_md_path = repairedReportPath;
      auditHostSeenReport({
        markdown: reportMarkdown,
        store,
        operatorBriefs: operatorBriefsContext,
        emitEvent: (event) => store?.recordEvolutionEvent?.({
          ...event,
          cycle_id: cycleId,
          subject: this.runtime?.subject,
        }),
        logger: this.host?.logger,
        eventType: 'phases_report_honesty',
        logLabel: 'phases',
        runtimeRoot: this.runtime?.runtimeRoot ?? null,
      });
      result.report = persistedReport;
      const reportPromptCacheWithUsage = {
        ...reportPromptCache,
        invariant: reportPromptCacheInvariant,
        usage: accumulateLlmUsage([reportUsageSummary, ...reportRepairUsageSummaries]),
      };
      logger.logPhase('intel_report', {
        outputs: {
          source: persistedReport.source,
          md_path: persistedReport.mdPath,
          raw_md_path: rawReportPath,
          repaired_md_path: repairedReportPath,
          host_seen_spliced: true,
          language: persistedReport.indexRecord.language,
          prompt_cache: reportPromptCacheWithUsage,
          repair: persistedReport.repair,
        },
        prompt: serializeMessages(reportMessages),
        aiResponse: reportMarkdown,
        aiDriven: reportSource === 'ai',
        fallbackUsed: reportSource !== 'ai',
        error: reportReason,
      });

      const decisionBacklogText = formatDecisionBacklogForPrompt(
        safeBacklogSummary(this.decisionQueue, { limit: 15 }),
        { language: preparedReport.language || 'zh' },
      );
      const decidePromptParts = buildDecideUserPromptParts({
        goalsText,
        rules,
        humanGuidance,
        operatorBriefs: operatorBriefsPrompt,
        intelligenceContext,
        observationReport: observation.observation_report,
        reportContext: preparedReport.reportContext,
        actionRegistry: this.actionRegistry,
        decisionBacklogText,
      });
      const decideUserPrompt = decidePromptParts.content;
      const decideMessages = [
        ...reportMessages,
        { role: 'assistant', content: reportMarkdown },
        { role: 'user', content: decideUserPrompt },
      ];
      const decidePromptCache = buildPromptCacheMetadata({
        profile: 'phase1_decide',
        messages: decideMessages,
        stablePrefix: [
          systemPromptParts.stablePrefix,
          reportPromptParts.stablePrefix,
          decidePromptParts.stablePrefix,
        ].join('\n\n--- stable turn ---\n\n'),
        dynamicPayload: [
          reportPromptParts.dynamicPayload,
          reportMarkdown,
          decidePromptParts.dynamicPayload,
        ].join('\n\n--- dynamic turn ---\n\n'),
      });
      const decidePromptCacheInvariant = markPromptCacheInvariant({
        scope: 'phase1_decide',
        metadata: decidePromptCache,
        logger: this.host?.logger,
      });

      this._log(`[${cycleId}] phase 3/3: analyze + decide`);
      logger.startPhase('analyze_decide');
      const decideResult = await chatMessagesDetailed(this.aiClient, decideMessages, {
        thinking: 'medium',
        timeout: 600,
        phase: 'decide',
      });
      const rawDecision = decideResult?.text;
      const decideUsageSummary = summarizeLlmUsage(decideResult?.usage);
      const decideUsageLog = formatLlmUsageSummary(decideUsageSummary, 'prompt-cache phase1_decide');
      if (decideUsageLog) this._log(decideUsageLog);
      let analysis = null;
      let analysisParseError = null;
      const parsedDecision = await parseAnalyzeDecisionWithRepair(this.aiClient, rawDecision, {
        logger: this.host?.logger,
      });
      analysis = parsedDecision.analysis;
      analysisParseError = parsedDecision.parseError;
      if (!analysis) {
        this._log(`analyze+decide JSON parse failed: ${analysisParseError}; repair failed: ${parsedDecision.repairError}; deferring without actions`, 'warning');
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
          repair_error: parsedDecision.repairError,
        };
      } else if (parsedDecision.repairUsed) {
        analysis.json_repair_used = true;
        analysis.original_parse_error = analysisParseError;
      }
      result.analysis = analysis;
      result.actions = Array.isArray(analysis?.actions) ? analysis.actions : [];
      const decidePromptCacheWithUsage = {
        ...decidePromptCache,
        invariant: decidePromptCacheInvariant,
        usage: decideUsageSummary,
      };
      result.conversation_context_path = persistPhase1ConversationContext({
        runtimeRoot: this.runtime.runtimeRoot,
        cycleId,
        timestamp: result.timestamp,
        goalId: this.goalId,
        runtime: this.runtime,
        operatorBriefs: operatorBriefsContext,
        observation,
        reportMessages,
        reportPromptCache: reportPromptCacheWithUsage,
        reportMarkdown,
        reportSource: persistedReport.source,
        reportPath: persistedReport.mdPath,
        decideMessages,
        decidePromptCache: decidePromptCacheWithUsage,
        rawDecision,
        analysis,
        actions: result.actions,
      });
      logger.logPhase('analyze_decide', {
        outputs: {
          decision: analysis?.decision,
          actions_count: result.actions.length,
          conversation_context_path: result.conversation_context_path,
          prompt_cache: decidePromptCacheWithUsage,
        },
        prompt: serializeMessages(decideMessages),
        aiResponse: rawDecision,
        aiDriven: true,
        fallbackUsed: Boolean(analysis.error_code === 'invalid_ai_json'),
        error: analysis.error_code === 'invalid_ai_json' ? analysisParseError : null,
        jsonRepairUsed: Boolean(parsedDecision.repairUsed && !analysis.error_code),
        repairedAiResponse: parsedDecision.repairedRaw,
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
          runtimeRoot: this.runtime.runtimeRoot,
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
        const queuedResult = await queueAnalyzeDecideActions({
          projectRoot: this.projectRoot,
          host: this.host,
          runtime: this.runtime,
          decisionQueue: this.decisionQueue,
          cycleId,
          timestamp: result.timestamp,
          goalId: this.goalId,
          analysis,
          actions: result.actions,
          reportPath: persistedReport.mdPath,
          conversationContextPath: result.conversation_context_path,
          reportMarkdown,
          operatorBriefs,
          pipeline: 'phases',
        });
        result.actions = queuedResult.actions;
        result.decisions_queued = queuedResult.decisions_queued;
        result.decisions_skipped = queuedResult.decisions_skipped;
        this._log(`wrote draft + queued ${result.decisions_queued.length} decision(s), skipped ${result.decisions_skipped.length} at ${queuedResult.draftDir}`);
        result.operator_briefs = {
          pending_read: operatorBriefsContext,
          invalid: operatorBriefRead.invalid,
          processed: queuedResult.operator_briefs_processed,
        };
      }

      result.injected_operator_fact_ids = Array.isArray(preparedReport.reportContext?.injected_operator_fact_ids)
        ? preparedReport.reportContext.injected_operator_fact_ids
        : [];
      result.pending_operator_facts = preparedReport.reportContext?.pending_operator_facts ?? [];
      result.pending_operator_questions = preparedReport.reportContext?.pending_operator_questions ?? [];

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
