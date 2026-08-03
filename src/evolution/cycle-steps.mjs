import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ActionExecutor,
  EvolutionEngine,
  ExecutionPipeline,
  decisionFingerprint,
  formatCurrentTimePromptBlock,
  getCurrentTimeSnapshot,
  isoBeijing,
  verifyActions,
} from '../engine/index.mjs';
import loadConfig from '../../oada.config.mjs'; // project root oada.config.mjs
import { assessActiveGoals, autoCalibrateGoals } from '../domain/cognition/index.mjs';
import { updateActiveBeliefs } from '../intelligence/belief-updater.mjs';
import { runEvidenceAuditQuick } from '../intelligence/evidence-audit.mjs';
import {
  ConversationalIntelligencePipeline,
  parseAnalyzeDecisionWithRepair,
  normalizeAnalyzeDecision,
} from '../intelligence/conversational-intel-pipeline.mjs';
import { verifyWithRestoredConversation } from '../intelligence/conversation-context.mjs';
import { buildEvolutionDiary } from '../intelligence/evolution-diary-builder.mjs';
import { createHostDecisionQueue } from '../intelligence/decision-queue.mjs';
import {
  formatOperatorBriefsForPrompt,
  readPendingOperatorBriefs,
  summarizeOperatorBriefsForContext,
} from '../intelligence/operator-briefs.mjs';
import {
  buildSeenSection,
  prepareIntelReport,
  persistIntelReport,
  updateStandingMemoryWithAi,
} from '../intelligence/report-builder.mjs';
import {
  queueAnalyzeDecideActions,
  toPreDecisionReportContext,
  buildStandingMemoryExtraContext,
} from '../intelligence/phase1-shared.mjs';
import {
  accumulateLlmUsage,
  buildPromptCacheMetadata,
  formatLlmUsageSummary,
  markPromptCacheInvariant,
  summarizeLlmUsage,
} from '../ai/prompt-cache-metadata.mjs';
import { chatMessagesDetailed, serializeMessages } from '../ai/messages.mjs';
import { repairReportIfNeeded } from '../intelligence/report-repair.mjs';
import { markStepStatus, writeStepArtifact } from '../cli/utils/cycle-state.mjs';
import { loadCycleStepContext, loadVerifyReportForCycle } from '../cli/utils/cycle-checkpoints.mjs';
import { extractMarkdownSection } from '../cli/utils/markdown-sections.mjs';
import { buildInvestigationTools } from './agent-loop/tool-registry.mjs';
import { runInvestigationLoop } from './agent-loop/loop-runner.mjs';
import { runMechanicalGuards } from './agent-loop/guard-runner.mjs';
import {
  buildAgentLoopInitialUserPromptParts,
  buildAgentLoopObservationReport,
  buildAgentLoopReportUserPromptParts,
  buildAgentLoopSystemPromptParts,
  buildInvestigationDigest,
  formatToolCatalogForPrompt,
} from '../prompts/agent-loop.mjs';
import {
  buildConversationSystemPromptParts,
  buildDecideUserPromptParts,
} from '../prompts/phase1-conversation.mjs';
import {
  assembleHostSeenBody,
  assembleAgentLoopHostSeenBody,
  auditHostSeenReport,
  spliceHostSeen,
  spliceAgentLoopSeen,
} from '../intelligence/host-seen.mjs';

export { assembleAgentLoopHostSeenBody, assembleHostSeenBody, spliceAgentLoopSeen, spliceHostSeen };

function carryoverPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', 'agent_loop_carryover.json');
}

function readCarryoverItems(runtimeRoot) {
  const path = carryoverPath(runtimeRoot);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(raw?.items) ? raw.items.map(String) : [];
  } catch {
    return [];
  }
}

export function writeCarryoverItems(runtimeRoot, { cycleId, items = [] } = {}) {
  const path = carryoverPath(runtimeRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    cycle_id: cycleId || null,
    created_at: new Date().toISOString(),
    items: Array.isArray(items) ? items.map(String) : [],
  }, null, 2), 'utf-8');
}

export function formatCarryoverSuggestion(suggestion) {
  if (typeof suggestion === 'string') return suggestion.trim();
  if (!suggestion || typeof suggestion !== 'object') return '';
  const text = String(suggestion.suggestion || suggestion.text || suggestion.summary || '').trim();
  const reason = String(suggestion.reason || '').trim();
  if (text && reason) return `${text}（reason: ${reason}）`;
  return text || reason;
}

/** Extract bullet items from diary "next cycle" section for carryover overwrite. */
export function extractCarryoverFromDiaryMarkdown(markdown, { limit = 10 } = {}) {
  const body = extractMarkdownSection(markdown, '下轮应该注意什么')
    || extractMarkdownSection(markdown, 'What the next cycle should remember')
    || '';
  if (!body.trim()) return [];
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

export { loadCycleStepContext } from '../cli/utils/cycle-checkpoints.mjs';

export function skipGoalsAssessFromEnv() {
  const v = process.env.JEA_SKIP_GOALS_ASSESS;
  if (!v) return false;
  return v === '1' || String(v).toLowerCase() === 'true';
}

export function skipBeliefUpdateFromEnv() {
  const v = process.env.JEA_SKIP_BELIEF_UPDATE;
  if (!v) return false;
  return v === '1' || String(v).toLowerCase() === 'true';
}

export function parseExecLimitFromEnv() {
  const raw = process.env.JEA_EXEC_LIMIT;
  if (raw == null || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > 100) return 100;
  return i;
}

function inspectQueue(runtimeRoot) {
  const queueFile = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  if (!existsSync(queueFile)) return [];
  const raw = JSON.parse(readFileSync(queueFile, 'utf-8'));
  return raw.decisions ?? [];
}

export async function buildCycleContext(projectRoot, runtime) {
  const cfg = await loadConfig({ cwd: projectRoot }); // eslint-disable-line -- explicit root
  const engine = new EvolutionEngine({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    actionRegistry: cfg.actionRegistry,
    agentContextDocs: cfg.agentContextDocs,
  });
  return { cfg, engine, runtime, store: cfg.host.intelligenceStore, projectRoot };
}

async function recordStepSidecar(root, subject, cycleId, step, status, metaPatch = {}) {
  if (!cycleId || !root || !subject) return;
  try {
    markStepStatus(root, subject, cycleId, step, { status, metaPatch });
  } catch {
    // sidecar must not break step execution
  }
}

function stateCycleId(intelResult, stateCycleId = null, execResult = null) {
  return stateCycleId || intelResult?.cycle_id || execResult?.cycle_id || null;
}

function parseLoopMaxReadonlyTurns() {
  const readonly = Number(process.env.JEA_LOOP_MAX_READONLY_TURNS);
  const legacy = Number(process.env.JEA_LOOP_MAX_TURNS);
  const candidates = [];
  if (Number.isFinite(readonly)) candidates.push(Math.max(1, Math.min(100, Math.trunc(readonly))));
  if (Number.isFinite(legacy)) candidates.push(Math.max(1, Math.min(100, Math.trunc(legacy))));
  if (!candidates.length) return 6;
  return Math.min(...candidates);
}

/** @deprecated Prefer parseLoopMaxReadonlyTurns */
function parseLoopMaxTurns() {
  return parseLoopMaxReadonlyTurns();
}

function parseLoopWallclockMs() {
  const n = Number(process.env.JEA_LOOP_MAX_WALLCLOCK_MS);
  if (!Number.isFinite(n)) return 1_200_000;
  return Math.max(5_000, Math.trunc(n));
}

function parseLoopToolResultMaxChars() {
  const n = Number(process.env.JEA_LOOP_TOOL_RESULT_MAX_CHARS);
  if (!Number.isFinite(n)) return 6000;
  return Math.max(500, Math.trunc(n));
}

function parseLoopFinishReserveMs() {
  const n = Number(process.env.JEA_LOOP_FINISH_RESERVE_MS);
  if (!Number.isFinite(n)) return 120_000;
  return Math.max(15_000, Math.trunc(n));
}

function parseLoopClosingTimeoutSec() {
  const n = Number(process.env.JEA_LOOP_CLOSING_TIMEOUT_SEC);
  if (!Number.isFinite(n)) return 240;
  return Math.max(30, Math.trunc(n));
}

function buildRestoredConversationForVerify({ systemPrompt, initialUserPrompt, reportMarkdown, executed }) {
  const actionSummary = (executed || []).map((item, idx) => {
    const type = item?.action?.type || 'action';
    const ok = item?.result?.success ? 'ok' : 'failed';
    return `${idx + 1}. ${type} => ${ok}`;
  }).join('\n') || '(none)';
  return [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(initialUserPrompt || '') },
    {
      role: 'assistant',
      content: [
        String(reportMarkdown || ''),
        '',
        '## Agent loop executed actions',
        actionSummary,
      ].join('\n'),
    },
  ];
}

function preloadDedupFromReceipts(store, cycleId) {
  const fingerprints = new Set();
  const already = [];
  try {
    const receipts = store?.readActionReceipts?.({ limit: 100 }) ?? [];
    for (const receipt of receipts) {
      if (receipt?.cycle_id !== cycleId && receipt?.exec_cycle_id !== cycleId) continue;
      const action = receipt.action;
      if (!action) continue;
      fingerprints.add(decisionFingerprint(action));
      already.push({
        type: action.type,
        description: action.description,
        summary: receipt.result?.summary || receipt.result?.message || null,
      });
    }
  } catch {
    // best-effort
  }
  return { fingerprints, already };
}

/**
 * Report-centric agent_loop step: replaces intel + intel_report (Phase 1 only).
 * investigate (readonly) → single-shot report → classic Analyze+Decide queue.
 * Does not execute side effects or write exec.json.
 */
export async function runAgentLoopStep(ctx, { cycleId = null, recordState = null } = {}) {
  const { cfg, engine, runtime, store } = ctx;
  const forcedCycleId = cycleId || process.env.JEA_CYCLE_ID;
  if (forcedCycleId) {
    engine.setCycleId(forcedCycleId);
  }
  const resolvedCycleId = engine.cycleId || forcedCycleId;
  const logger = cfg.host?.logger || null;
  const aiClient = cfg.aiClient;
  const stepStartedAt = Date.now();

  if (!aiClient || typeof aiClient.chatMessagesWithTools !== 'function') {
    throw new Error('agent_loop requires aiClient.chatMessagesWithTools (use DeepSeek or MockToolsAIClient)');
  }

  const operatorBriefRead = readPendingOperatorBriefs(runtime.runtimeRoot);
  const operatorBriefs = operatorBriefRead.briefs || [];
  const operatorBriefsPrompt = formatOperatorBriefsForPrompt(operatorBriefs);
  const operatorBriefsSummary = summarizeOperatorBriefsForContext(operatorBriefs);

  const goalsText = engine.goalProvider.formatForPrompt('bootstrap');
  const rules = engine.loadRules();
  const humanGuidance = engine.guidanceReader.readGuidance();
  const intelligenceContext = cfg.host?.knowledgeWriter?.buildContextSummary?.() || '';
  const decisionQueue = createHostDecisionQueue({
    dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
    logFn: (msg) => logger?.info?.(`[agent_loop] ${msg}`),
  });
  const queueSummary = (() => {
    try {
      return decisionQueue.summarize();
    } catch {
      return null;
    }
  })();

  const prepared = prepareIntelReport({
    intelResult: {
      cycle_id: resolvedCycleId,
      timestamp: isoBeijing(),
      actions: [],
      decisions_queued: [],
    },
    runtime,
    store,
    agentContextDocs: cfg.agentContextDocs,
    queueSummary,
    operatorBriefs: operatorBriefsSummary,
  });
  const language = prepared.language || 'zh';
  const mechanicalSeen = buildSeenSection(prepared.reportContext) || '(none)';
  const execLimit = parseExecLimitFromEnv();
  const budget = {
    maxTurns: parseLoopMaxReadonlyTurns(),
    maxActions: execLimit,
    maxWallClockMs: parseLoopWallclockMs(),
    toolResultMaxChars: parseLoopToolResultMaxChars(),
    finishReserveMs: parseLoopFinishReserveMs(),
    reportDecideReserveMs: parseLoopFinishReserveMs(),
    closingTimeoutSec: parseLoopClosingTimeoutSec(),
    actionsUsed: 0,
  };

  const autoArchive = process.env.JEA_QUEUE_AUTO_ARCHIVE;
  if (autoArchive !== '0' && String(autoArchive).toLowerCase() !== 'false') {
    try {
      const archived = decisionQueue.archiveDecisions?.({
        statuses: ['completed', 'expired'],
        dryRun: false,
      });
      if (archived?.archived?.length) {
        logger?.info?.(`[agent_loop] auto-archived ${archived.archived.length} queue decision(s)`);
      }
    } catch {
      // archive failure must not block the step
    }
  }

  const loopCtx = {
    cfg,
    host: cfg.host,
    runtime,
    store,
    cycleId: resolvedCycleId,
    decisionQueue,
    actionRegistry: cfg.actionRegistry,
    budget,
    dedup: new Set(),
    queued: [],
    executed: [],
    investigation: null,
    queryLog: [],
    emitEvent: (event) => store.recordEvolutionEvent({
      ...event,
      cycle_id: resolvedCycleId,
      subject: runtime.subject,
    }),
    logger,
  };
  loopCtx.executed = loopCtx.queued;

  const carryoverItems = readCarryoverItems(runtime.runtimeRoot);
  const tools = buildInvestigationTools(loopCtx);
  // Snapshot once for this intel step so investigate↔report share one clock field;
  // get_current_time tool may refresh later if the model asks.
  const currentTimeBlock = formatCurrentTimePromptBlock(getCurrentTimeSnapshot());
  const investigateSystemParts = buildAgentLoopSystemPromptParts({
    agentContextDocs: cfg.agentContextDocs,
    toolCatalogText: formatToolCatalogForPrompt(tools),
    language,
  });
  const investigateUserParts = buildAgentLoopInitialUserPromptParts({
    cycleId: resolvedCycleId,
    currentTime: currentTimeBlock,
    language,
    goalsText,
    rules,
    humanGuidance,
    operatorBriefs: operatorBriefsPrompt,
    intelligenceContext,
    reportContext: prepared.reportContext,
    mechanicalSeen,
    carryover: carryoverItems,
  });

  const investigatePromptCache = buildPromptCacheMetadata({
    profile: 'agent_loop_investigate',
    messages: [
      { role: 'system', content: investigateSystemParts.content },
      { role: 'user', content: investigateUserParts.content },
    ],
    stablePrefix: investigateSystemParts.stablePrefix,
    dynamicPayload: investigateUserParts.dynamicPayload,
  });
  const investigatePromptCacheInvariant = markPromptCacheInvariant({
    scope: 'agent_loop_investigate',
    metadata: investigatePromptCache,
    logger,
  });

  const turnsPath = join(
    runtime.runtimeRoot,
    'data',
    'evolution',
    'records',
    resolvedCycleId,
    'agent_loop_turns.jsonl',
  );
  mkdirSync(dirname(turnsPath), { recursive: true });

  logger?.info?.(`[agent_loop] phase investigate (maxTurns=${budget.maxTurns})`);
  const investigateResult = await runInvestigationLoop({
    aiClient,
    systemPrompt: investigateSystemParts.content,
    initialUserPrompt: investigateUserParts.content,
    tools,
    budget,
    emitEvent: (event) => store.recordEvolutionEvent({
      ...event,
      cycle_id: resolvedCycleId,
      subject: runtime.subject,
    }),
    logger,
    turnsPath,
  });
  const investigation = investigateResult.investigation || {
    findings_summary: '(investigation missing)',
    enough_for_report: true,
    open_gaps: [],
    gaps_closed: [],
    forced: true,
    forced_reason: 'missing_investigation',
  };
  if (Array.isArray(investigation.rejected_facts) && investigation.rejected_facts.length) {
    store.recordEvolutionEvent({
      type: 'agent_loop_rejected_facts',
      cycle_id: resolvedCycleId,
      subject: runtime.subject,
      count: investigation.rejected_facts.length,
      rejected: investigation.rejected_facts.slice(0, 20),
    });
  }
  const investigationDigest = buildInvestigationDigest({
    investigation,
    queryLog: investigateResult.queryLog || loopCtx.queryLog || [],
  });
  const hostSeenBody = assembleHostSeenBody({
    reportContext: prepared.reportContext,
    queueSummary,
    operatorBriefs: operatorBriefsSummary,
    mechanicalSeen,
    verifiedFacts: investigation.verified_facts || [],
  });
  const observationReport = buildAgentLoopObservationReport({
    mechanicalSeen: hostSeenBody,
    investigationDigest,
  });

  // --- Phase: single-shot report (model writes judgement; host owns Seen) ---
  const reportPromptContext = toPreDecisionReportContext(prepared.reportContext);
  const systemPromptParts = buildConversationSystemPromptParts({
    agentContextDocs: cfg.agentContextDocs,
    actionRegistry: cfg.actionRegistry,
  });
  const reportPromptParts = buildAgentLoopReportUserPromptParts({
    cycleId: resolvedCycleId,
    currentTime: currentTimeBlock,
    language,
    goalsText,
    rules,
    humanGuidance,
    operatorBriefs: operatorBriefsPrompt,
    hostSeenBody,
    investigationDigest,
    reportContext: reportPromptContext,
  });
  const reportMessages = [
    { role: 'system', content: systemPromptParts.content },
    { role: 'user', content: reportPromptParts.content },
  ];
  const reportPromptCache = buildPromptCacheMetadata({
    profile: 'agent_loop_report',
    messages: reportMessages,
    stablePrefix: [systemPromptParts.stablePrefix, reportPromptParts.stablePrefix].join('\n\n--- stable turn ---\n\n'),
    dynamicPayload: reportPromptParts.dynamicPayload,
  });
  const reportPromptCacheInvariant = markPromptCacheInvariant({
    scope: 'agent_loop_report',
    metadata: reportPromptCache,
    logger,
  });

  const recordsDir = join(
    runtime.runtimeRoot,
    'data',
    'evolution',
    'records',
    resolvedCycleId,
  );
  mkdirSync(recordsDir, { recursive: true });
  const rawReportPath = join(recordsDir, 'agent_loop_report_raw.md');

  logger?.info?.('[agent_loop] phase report (single-shot, host Seen splice)');
  let reportSource = 'fallback';
  let reportReason = null;
  let rawReportMarkdown = null;
  let reportUsageSummary = null;
  try {
    const reportResult = await chatMessagesDetailed(aiClient, reportMessages, {
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
    logger?.warning?.(`[agent_loop] report generation failed: ${reportReason}`);
  }
  const reportUsageLog = formatLlmUsageSummary(reportUsageSummary, 'prompt-cache agent_loop_report');
  if (reportUsageLog) logger?.info?.(reportUsageLog);

  if (rawReportMarkdown) {
    writeFileSync(rawReportPath, rawReportMarkdown, 'utf-8');
  } else if (existsSync(rawReportPath) === false) {
    // No model raw; still leave an empty marker only when AI never produced output.
    writeFileSync(rawReportPath, '', 'utf-8');
  }

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
      aiClient,
      store,
      reportMessages,
      rawReportMarkdown,
      hostSeenBody,
      language,
      logger,
      label: 'agent_loop',
    });
    persistReportMarkdown = repaired.rawReportMarkdown;
    reportRepair = repaired.repair;
    reportRepairUsageSummaries = repaired.usageSummaries || [];
    if (reportRepair.rounds > 0 && persistReportMarkdown) {
      repairedReportPath = join(recordsDir, 'agent_loop_report_repaired.md');
      writeFileSync(repairedReportPath, persistReportMarkdown, 'utf-8');
    }
    if (reportRepair.findings_initial?.length) {
      store.recordEvolutionEvent({
        type: 'intel_report_repair',
        pipeline: 'agent_loop',
        cycle_id: resolvedCycleId,
        subject: runtime.subject,
        status: reportRepair.repaired
          ? 'repaired'
          : (reportRepair.rounds ? 'gave_up' : 'skipped'),
        rounds: reportRepair.rounds,
        findings_initial: reportRepair.findings_initial,
        findings_final: reportRepair.findings_final,
      });
    }
  }

  // Splice host Seen inside persist (before redactSecrets) so index/tldr match disk
  // and Seen cannot bypass redaction via a post-persist rewrite.
  const persistedReport = await persistIntelReport({
    intelResult: {
      cycle_id: resolvedCycleId,
      timestamp: isoBeijing(),
      actions: [],
      decisions_queued: [],
    },
    runtime,
    store,
    agentContextDocs: cfg.agentContextDocs,
    aiClient: reportSource === 'ai' ? aiClient : null,
    logger,
    md: persistReportMarkdown,
    source: reportSource === 'ai' ? 'agent_loop' : 'fallback',
    fallbackReason: reportReason,
    updateStandingMemory: false,
    transformMd: (md) => spliceHostSeen(md, hostSeenBody),
    ...prepared,
  });
  persistedReport.repair = {
    rounds: reportRepair.rounds,
    repaired: reportRepair.repaired,
    gave_up: reportRepair.gave_up,
  };
  if (repairedReportPath) persistedReport.repaired_md_path = repairedReportPath;
  const reportMarkdown = persistedReport.markdown;
  auditHostSeenReport({
    markdown: reportMarkdown,
    store,
    operatorBriefs,
    emitEvent: (event) => store.recordEvolutionEvent({
      ...event,
      cycle_id: resolvedCycleId,
      subject: runtime.subject,
    }),
    logger,
    eventType: 'agent_loop_report_honesty',
    logLabel: 'agent_loop',
  });

  // --- Phase: classic Analyze+Decide ---
  const decidePromptParts = buildDecideUserPromptParts({
    goalsText,
    rules,
    humanGuidance,
    operatorBriefs: operatorBriefsPrompt,
    intelligenceContext,
    observationReport,
    reportContext: prepared.reportContext,
    actionRegistry: cfg.actionRegistry,
    includeMachineContext: true,
    observationReportFraming: 'host_assembled',
  });
  const decideMessages = [
    ...reportMessages,
    { role: 'assistant', content: reportMarkdown },
    { role: 'user', content: decidePromptParts.content },
  ];
  const decidePromptCache = buildPromptCacheMetadata({
    profile: 'agent_loop_decide',
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
    scope: 'agent_loop_decide',
    metadata: decidePromptCache,
    logger,
  });

  logger?.info?.('[agent_loop] phase decide (JSON)');
  let analysis = null;
  let analysisParseError = null;
  let decideUsageSummary = null;
  try {
    const decideResult = await chatMessagesDetailed(aiClient, decideMessages, {
      thinking: 'medium',
      timeout: 600,
      phase: 'decide',
    });
    const rawDecision = decideResult?.text;
    decideUsageSummary = summarizeLlmUsage(decideResult?.usage);
    const decideUsageLog = formatLlmUsageSummary(decideUsageSummary, 'prompt-cache agent_loop_decide');
    if (decideUsageLog) logger?.info?.(decideUsageLog);
    const parsedDecision = await parseAnalyzeDecisionWithRepair(aiClient, rawDecision, { logger });
    analysis = parsedDecision.analysis;
    analysisParseError = parsedDecision.parseError;
    if (!analysis) {
      analysis = normalizeAnalyzeDecision({
        decision: 'defer',
        rationale: `Analyze+Decide JSON was invalid; no actions were queued. ${analysisParseError}`,
        actions: [],
        deferred: [{
          action: 'retry_analyze_decide',
          reason: analysisParseError,
          revisit_after: 'next cycle',
        }],
        error_code: 'invalid_ai_json',
        parse_error: analysisParseError,
        repair_error: parsedDecision.repairError,
      });
    } else if (parsedDecision.repairUsed) {
      analysis.json_repair_used = true;
      analysis.original_parse_error = analysisParseError;
    }
  } catch (e) {
    analysisParseError = e?.message || String(e);
    analysis = normalizeAnalyzeDecision({
      decision: 'defer',
      rationale: `Analyze+Decide failed: ${analysisParseError}`,
      actions: [],
      deferred: [{
        action: 'retry_analyze_decide',
        reason: analysisParseError,
        revisit_after: 'next cycle',
      }],
      error_code: 'decide_failed',
      parse_error: analysisParseError,
    });
  }

  const conversationPath = join(
    runtime.runtimeRoot,
    'data',
    'evolution',
    'records',
    resolvedCycleId,
    'conversation_context.json',
  );
  mkdirSync(dirname(conversationPath), { recursive: true });

  const queuedResult = await queueAnalyzeDecideActions({
    projectRoot: runtime.runtimeRoot,
    host: cfg.host,
    runtime,
    decisionQueue,
    cycleId: resolvedCycleId,
    timestamp: isoBeijing(),
    goalId: 'bootstrap',
    analysis,
    actions: Array.isArray(analysis?.actions) ? analysis.actions : [],
    reportPath: persistedReport.mdPath,
    conversationContextPath: conversationPath,
    reportMarkdown,
    operatorBriefs,
    maxActions: execLimit,
    pipeline: 'agent_loop',
  });

  const queuedActions = queuedResult.actions;
  const queuedIds = queuedResult.decisions_queued;
  const finishCarryover = [
    ...(Array.isArray(investigation.open_gaps) ? investigation.open_gaps.map(String) : []),
    ...(Array.isArray(analysis?.deferred)
      ? analysis.deferred.map((d) => (typeof d === 'string' ? d : `${d.action || 'deferred'}: ${d.reason || d.description || ''}`.trim()))
      : []),
    ...(Array.isArray(analysis?.goal_suggestions)
      ? analysis.goal_suggestions.map((s) => formatCarryoverSuggestion(s)).slice(0, 5)
      : []),
  ].filter(Boolean).slice(0, 10);

  try {
    writeCarryoverItems(runtime.runtimeRoot, {
      cycleId: resolvedCycleId,
      items: finishCarryover,
    });
  } catch (e) {
    logger?.warning?.(`[agent_loop] failed to write carryover: ${e?.message || e}`);
  }

  const restoredConversation = buildRestoredConversationForVerify({
    systemPrompt: systemPromptParts.content,
    initialUserPrompt: reportPromptParts.content,
    reportMarkdown,
    executed: queuedActions.map((action, idx) => ({
      id: queuedIds[idx] || null,
      action,
    })),
  });
  const investigateUsageLog = formatLlmUsageSummary(
    investigateResult.usage_totals,
    'prompt-cache agent_loop_investigate',
  );
  if (investigateUsageLog) logger?.info?.(investigateUsageLog);
  const promptCacheWithUsage = {
    investigate: {
      ...investigatePromptCache,
      invariant: investigatePromptCacheInvariant,
      usage: investigateResult.usage_totals ?? null,
    },
    report: {
      ...reportPromptCache,
      invariant: reportPromptCacheInvariant,
      usage: accumulateLlmUsage([reportUsageSummary, ...reportRepairUsageSummaries]),
    },
    decide: {
      ...decidePromptCache,
      invariant: decidePromptCacheInvariant,
      usage: decideUsageSummary,
    },
  };
  writeFileSync(conversationPath, JSON.stringify({
    schema_version: 1,
    kind: 'agent_loop_conversation_context',
    cycle_id: resolvedCycleId,
    timestamp: isoBeijing(),
    goal_id: 'bootstrap',
    runtime: {
      subject: runtime.subject,
      dataNamespace: runtime.dataNamespace,
    },
    files: {
      self: conversationPath,
      report: persistedReport.mdPath,
      report_raw: rawReportPath,
      report_repaired: repairedReportPath,
      turns: turnsPath,
    },
    operator_intent_briefs: operatorBriefsSummary,
    prompt_cache: promptCacheWithUsage,
    phases: {
      investigate: {
        status: investigateResult.status,
        turns: investigateResult.turns,
        readonly_calls: investigateResult.readonlyCalls ?? 0,
        forced: Boolean(investigation.forced),
        forced_reason: investigation.forced_reason || null,
        duration_ms: investigateResult.duration_ms,
        fact_retry_used: Boolean(investigation.fact_retry_used),
      },
      report: {
        source: persistedReport.source,
        reason: reportReason,
        raw_path: rawReportPath,
        repaired_path: repairedReportPath,
        host_seen_spliced: true,
        repair: {
          rounds: reportRepair.rounds,
          repaired: reportRepair.repaired,
          gave_up: reportRepair.gave_up,
        },
      },
      decide: {
        decision: analysis?.decision ?? null,
        actions_count: queuedActions.length,
        parse_error: analysisParseError,
      },
    },
    investigation,
    decide_messages_digest: serializeMessages(decideMessages).slice(0, 4000),
    restored_conversation: restoredConversation,
  }, null, 2), 'utf-8');

  let memoryUpdate = { status: 'skipped', reason: 'disabled' };
  try {
    memoryUpdate = await updateStandingMemoryWithAi({
      aiClient,
      store,
      language,
      reportContext: prepared.reportContext,
      reportMarkdown,
      cycleId: resolvedCycleId,
      generatedAt: isoBeijing(),
      logger,
      runtimeRoot: runtime.runtimeRoot,
      extraContext: buildStandingMemoryExtraContext({
        analysis,
        actions: queuedActions,
        reportPath: persistedReport.mdPath,
        conversationContextPath: conversationPath,
      }),
    });
  } catch (e) {
    memoryUpdate = { status: 'failed', reason: e?.message || String(e) };
  }

  const durationMs = Date.now() - stepStartedAt;
  const intelResult = {
    cycle_id: resolvedCycleId,
    timestamp: isoBeijing(),
    success: true,
    actions: queuedActions,
    decisions_queued: queuedIds,
    decisions_skipped: queuedResult.decisions_skipped,
    analysis,
    report: {
      mdPath: persistedReport.mdPath,
      source: persistedReport.source,
      indexRecord: persistedReport.indexRecord,
      markdown: reportMarkdown,
      forced: reportSource !== 'ai',
      forced_reason: reportReason,
      raw_md_path: rawReportPath,
      repaired_md_path: repairedReportPath,
      repair: persistedReport.repair,
    },
    conversation_context_path: conversationPath,
    standing_memory_update: memoryUpdate,
  };

  store.recordEvolutionEvent({
    type: 'agent_loop_pipeline',
    status: investigation.forced || reportSource !== 'ai' ? 'forced' : 'ok',
    cycle_id: resolvedCycleId,
    turns: investigateResult.turns,
    readonly_calls: investigateResult.readonlyCalls ?? 0,
    decisions_queued: queuedIds.length,
    report_source: persistedReport.source,
    duration_ms: durationMs,
  });

  if (recordState) {
    await persistCheckpoint(recordState, resolvedCycleId, 'intel', {
      cycle_id: resolvedCycleId,
      success: true,
      decisions_queued: queuedIds.length,
      report: {
        mdPath: persistedReport.mdPath,
        source: persistedReport.source,
        indexRecord: persistedReport.indexRecord,
        forced: reportSource !== 'ai',
        forced_reason: reportReason,
        raw_md_path: rawReportPath,
      },
    });
    await persistCheckpoint(recordState, resolvedCycleId, 'agent_loop', {
      cycle_id: resolvedCycleId,
      success: true,
      status: investigation.forced ? 'forced' : 'done',
      turns: investigateResult.turns,
      decisions_queued: queuedIds,
      queued_count: queuedIds.length,
      report_path: persistedReport.mdPath,
      report_raw_path: rawReportPath,
      conversation_context_path: conversationPath,
      turns_path: turnsPath,
      carryover: finishCarryover,
      phases: {
        investigate: {
          turns: investigateResult.turns,
          readonly_calls: investigateResult.readonlyCalls ?? 0,
          forced: Boolean(investigation.forced),
          forced_reason: investigation.forced_reason || null,
        },
        report: {
          source: persistedReport.source,
          reason: reportReason,
          raw_path: rawReportPath,
          repaired_path: repairedReportPath,
          host_seen_spliced: true,
          repair: {
            rounds: reportRepair.rounds,
            repaired: reportRepair.repaired,
            gave_up: reportRepair.gave_up,
          },
        },
        decide: { decision: analysis?.decision ?? null, actions_count: queuedActions.length },
      },
      prompt_cache: promptCacheWithUsage,
    }, { required: true });
    await recordStepSidecar(recordState.root, recordState.subject, resolvedCycleId, 'agent_loop', 'done', {
      decisions_queued: queuedIds.length,
      intel_report_ready: true,
    });
  }

  return {
    cycleId: resolvedCycleId,
    intelResult,
    loopResult: {
      status: investigation.forced ? 'forced' : 'done',
      turns: investigateResult.turns,
      decisions_queued: queuedIds.length,
      report_path: persistedReport.mdPath,
      conversation_context_path: conversationPath,
      phases: {
        investigate: investigateResult,
        report: { source: persistedReport.source },
        decide: { actions: queuedActions.length },
      },
    },
    eventPayload: {
      decisions_queued: queuedIds.length,
      intel_report_ready: true,
    },
  };
}

export async function runIntelStep(ctx, { cycleId = null, recordState = null } = {}) {
  const { cfg, engine, runtime, store } = ctx;
  const forcedCycleId = cycleId || process.env.JEA_CYCLE_ID;
  if (forcedCycleId) {
    engine.setCycleId(forcedCycleId);
  }
  const intel = new ConversationalIntelligencePipeline({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    goalId: 'bootstrap',
    mode: 'local',
    engine,
    agentContextDocs: cfg.agentContextDocs,
    actionRegistry: cfg.actionRegistry,
    runtime,
  });
  const intelResult = await intel.run();
  const resolvedCycleId = intelResult.cycle_id;
  store.recordEvolutionEvent({
    type: 'intel_pipeline',
    status: intelResult.success ? 'ok' : 'failed',
    cycle_id: resolvedCycleId,
    actions_count: intelResult.actions.length,
    error: intelResult.error,
  });
  if (!intelResult.success) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, resolvedCycleId, 'intel', 'failed', {
        error: intelResult.error,
      });
    }
    throw new Error(intelResult.error || 'intel pipeline failed');
  }
  const metaPatch = { decisions_queued: intelResult.decisions_queued?.length ?? 0 };
  if (recordState) {
    await persistCheckpoint(recordState, resolvedCycleId, 'intel', {
      cycle_id: resolvedCycleId,
      success: true,
      decisions_queued: metaPatch.decisions_queued,
      report: intelResult.report ? {
        mdPath: intelResult.report.mdPath,
        source: intelResult.report.source,
        indexRecord: intelResult.report.indexRecord,
      } : null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, resolvedCycleId, 'intel', 'done', metaPatch);
  }
  return {
    cycleId: resolvedCycleId,
    intelResult,
    eventPayload: { decisions_queued: metaPatch.decisions_queued },
  };
}

export async function runIntelReportStep(ctx, { intelResult, recordState = null } = {}) {
  const { store } = ctx;
  let intelReportReady = false;
  try {
    const report = intelResult.report;
    if (!report) throw new Error('conversational intel pipeline did not return a report');
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'ok',
      cycle_id: intelResult.cycle_id,
      report_path: report.mdPath,
      source: report.source,
      language: report.indexRecord.language,
    });
    intelReportReady = Boolean(report.mdPath && existsSync(report.mdPath));
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'intel_report',
      status: 'failed',
      cycle_id: intelResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'intel_report', 'failed', { error: msg });
    }
    return { intelReportReady: false, failed: true };
  }
  if (recordState) {
    await persistCheckpoint(recordState, intelResult.cycle_id, 'intel_report', {
      cycle_id: intelResult.cycle_id,
      intel_report_ready: intelReportReady,
      report_path: intelResult.report?.mdPath ?? null,
      source: intelResult.report?.source ?? null,
      indexRecord: intelResult.report?.indexRecord ?? null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'intel_report', 'done', {
      intel_report_ready: intelReportReady,
    });
  }
  return { intelReportReady, eventPayload: { intel_report_ready: intelReportReady } };
}

export async function runExecStep(ctx, { recordState = null, intelResult = null, stateCycleId: stateCycleIdOpt = null } = {}) {
  const { cfg, runtime, store } = ctx;
  const logger = cfg.host?.logger || null;
  const resolvedCycleId = stateCycleId(intelResult, stateCycleIdOpt, null)
    || process.env.JEA_CYCLE_ID
    || null;

  const decisionQueue = createHostDecisionQueue({
    dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
    logFn: (msg) => logger?.info?.(`[exec] ${msg}`),
  });
  const executor = new ActionExecutor({
    projectRoot: runtime.runtimeRoot,
    cycleId: resolvedCycleId,
    aiClient: cfg.aiClient,
    host: cfg.host,
    logFn: (msg, level = 'info') => logger?.[level]?.(`[exec] ${msg}`),
  });
  const guardExecuted = [];
  const guardCtx = {
    host: cfg.host,
    runtime,
    store,
    cycleId: resolvedCycleId,
    decisionQueue,
    executor,
    dedup: new Set(),
    executed: guardExecuted,
    emitEvent: (event) => store.recordEvolutionEvent({
      ...event,
      cycle_id: resolvedCycleId,
      subject: runtime.subject,
    }),
    logger,
  };
  const guardResult = await runMechanicalGuards({ root: ctx.projectRoot, loopCtx: guardCtx });
  if (guardResult.ran?.length) {
    logger?.info?.(`[exec] mechanical guards ran: ${guardResult.ran.length}`);
  }

  const exec = new ExecutionPipeline({
    host: cfg.host,
    projectRoot: runtime.runtimeRoot,
    aiClient: cfg.aiClient,
    source: 'queue',
    cycleId: resolvedCycleId || undefined,
  });
  const execResult = await exec.run({
    limit: parseExecLimitFromEnv(),
    cycleId: resolvedCycleId || undefined,
  });
  // Prepend guard executions so verify can see them.
  if (guardExecuted.length) {
    execResult.executed = [...guardExecuted, ...(execResult.executed || [])];
  }
  const artifactCycleId = stateCycleId(intelResult, stateCycleIdOpt, execResult);
  store.recordEvolutionEvent({
    type: 'exec_pipeline',
    status: execResult.success ? 'ok' : 'failed',
    cycle_id: execResult.cycle_id,
    executed_count: execResult.executed.length,
    guards_ran: guardResult.ran?.length ?? 0,
    error: execResult.error,
  });
  if (!execResult.success) {
    if (recordState && artifactCycleId) {
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'exec', 'failed', {
        error: execResult.error,
      });
    }
    throw new Error(execResult.error || 'exec pipeline failed');
  }
  if (recordState && artifactCycleId) {
    await persistCheckpoint(recordState, artifactCycleId, 'exec', {
      cycle_id: execResult.cycle_id,
      intel_cycle_id: intelResult?.cycle_id ?? artifactCycleId,
      success: execResult.success,
      executed: execResult.executed ?? [],
      error: execResult.error ?? null,
    });
    await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'exec', 'done');
  }
  return { execResult };
}

export async function runVerifyStep(ctx, { intelResult, execResult, recordState = null } = {}) {
  const { cfg, runtime, store } = ctx;
  const verification = verifyActions(
    execResult,
    runtime.runtimeRoot,
    cfg.host,
    (msg, level = 'info') => cfg.host.logger?.[level]?.(`[verify] ${msg}`),
  );
  const semanticVerification = await verifyWithRestoredConversation({
    aiClient: cfg.aiClient,
    runtimeRoot: runtime.runtimeRoot,
    cycleId: intelResult.cycle_id,
    execResult,
    mechanicalVerification: verification,
    logger: cfg.host.logger,
  });
  verification.semantic = semanticVerification;
  try {
    verification.evidence_audit = runEvidenceAuditQuick({ dataRoot: runtime.dataRoot });
  } catch (e) {
    verification.evidence_audit = { status: 'failed', error: e?.message ?? String(e) };
  }
  const reportDir = join(runtime.runtimeRoot, 'data', 'evolution', 'verify_reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${execResult.cycle_id}.json`);
  writeFileSync(reportPath, JSON.stringify(verification, null, 2), 'utf-8');
  store.recordEvolutionEvent({
    type: 'verify_pipeline',
    status: 'ok',
    cycle_id: execResult.cycle_id,
    verified_count: verification.verified.length,
    pending_count: verification.pending.length,
    semantic_status: semanticVerification.status,
    report_path: reportPath,
  });
  if (recordState) {
    const artifactCycleId = stateCycleId(intelResult);
    await persistCheckpoint(recordState, artifactCycleId, 'verify', {
      cycle_id: execResult.cycle_id,
      report_path: reportPath,
      verified_count: verification.verified?.length ?? 0,
      semantic_status: semanticVerification.status,
    });
    await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'verify', 'done');
  }
  return { verification, reportPath, semanticVerification };
}

export async function runBeliefUpdateStep(ctx, {
  intelResult, execResult, verification, reportPath, recordState = null,
} = {}) {
  const { cfg, store } = ctx;
  if (skipBeliefUpdateFromEnv()) {
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'skipped');
      await persistCheckpoint(recordState, artifactCycleId, 'belief_update', {
        cycle_id: execResult.cycle_id,
        skipped: true,
        beliefUpdateResult: null,
      });
    }
    return { skipped: true, beliefUpdateResult: null };
  }
  try {
    const beliefUpdateResult = await updateActiveBeliefs(ctx.projectRoot, {
      cycleId: execResult.cycle_id,
      intelResult,
      execResult,
      verification,
      verificationReportPath: reportPath,
      store,
      aiClient: cfg.aiClient,
      agentContextDocs: cfg.agentContextDocs,
      logger: cfg.host.logger,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'done');
      await persistCheckpoint(recordState, artifactCycleId, 'belief_update', {
        cycle_id: execResult.cycle_id,
        skipped: false,
        beliefUpdateResult: {
          source: beliefUpdateResult.source,
          result: beliefUpdateResult.result,
          eventsWritten: beliefUpdateResult.eventsWritten ?? 0,
        },
      });
    }
    return { beliefUpdateResult };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'belief_update',
      status: 'failed',
      cycle_id: execResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'belief_update', 'failed', { error: msg });
    }
    return { failed: true, error: msg, beliefUpdateResult: null };
  }
}

export async function runGoalsAssessStep(ctx, {
  intelResult, reportPath, intelReportReady, recordState = null,
} = {}) {
  const { store } = ctx;
  if (skipGoalsAssessFromEnv() || !intelReportReady) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'skipped');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_assess', {
        cycle_id: intelResult.cycle_id,
        skipped: true,
        goalsAssessResult: null,
      });
    }
    return { skipped: true, goalsAssessResult: null };
  }
  try {
    const assessResult = await assessActiveGoals(ctx.projectRoot, { cycle: intelResult.cycle_id }, {
      verificationReportPath: reportPath,
    });
    store.recordEvolutionEvent({
      type: 'goals_assess',
      status: 'ok',
      cycle_id: intelResult.cycle_id,
      assessment_status: assessResult.assessment.status,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'done');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_assess', {
        cycle_id: intelResult.cycle_id,
        skipped: false,
        goalsAssessResult: assessResult,
      });
    }
    return { goalsAssessResult: assessResult };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'goals_assess',
      status: 'failed',
      cycle_id: intelResult.cycle_id,
      error: msg,
    });
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_assess', 'failed', { error: msg });
    }
    return { failed: true, goalsAssessResult: null };
  }
}

export async function runGoalsCalibrateStep(ctx, { intelResult, goalsAssessResult, store, recordState = null } = {}) {
  if (!goalsAssessResult) {
    if (recordState) {
      await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_calibrate', 'skipped');
      await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_calibrate', {
        cycle_id: intelResult.cycle_id,
        skipped: true,
        goalsCalibrateResult: null,
      });
    }
    return { skipped: true, goalsCalibrateResult: null };
  }
  const goalsCalibrateResult = autoCalibrateGoals(ctx.projectRoot, goalsAssessResult, { store });
  store.recordEvolutionEvent({
    type: 'goals_calibrate',
    status: goalsCalibrateResult.status,
    cycle_id: intelResult.cycle_id,
    reason: goalsCalibrateResult.reason,
    mode: goalsCalibrateResult.mode ?? null,
    calibrate_mode: goalsCalibrateResult.calibrate_mode ?? null,
    detail: goalsCalibrateResult.detail ?? null,
    warnings: goalsCalibrateResult.warnings ?? [],
    previous_goal_id: goalsCalibrateResult.previous_goal_id,
    next_goal_id: goalsCalibrateResult.next_goal_id,
    written: goalsCalibrateResult.written,
    active_goals_path: goalsCalibrateResult.active_goals_path,
    applied_patches: goalsCalibrateResult.applied_patches ?? [],
    skipped_patches: goalsCalibrateResult.skipped_patches ?? [],
    belief_retirements: goalsCalibrateResult.belief_retirements ?? [],
  });
  if (recordState) {
    await recordStepSidecar(recordState.root, recordState.subject, intelResult.cycle_id, 'goals_calibrate', 'done');
    await persistCheckpoint(recordState, intelResult.cycle_id, 'goals_calibrate', {
      cycle_id: intelResult.cycle_id,
      skipped: false,
      goalsCalibrateResult,
    });
  }
  return { goalsCalibrateResult };
}

export async function runDiaryStep(ctx, {
  intelResult, execResult, verification, beliefUpdateResult,
  goalsAssessResult, goalsCalibrateResult, reportPath, recordState = null,
} = {}) {
  const { cfg, runtime, store } = ctx;
  try {
    const diary = await buildEvolutionDiary({
      aiClient: cfg.aiClient,
      intelResult,
      execResult,
      verification,
      beliefUpdateResult,
      goalsAssessResult,
      goalsCalibrateResult,
      runtime,
      store,
      agentContextDocs: cfg.agentContextDocs,
      reportPath: intelResult.report?.mdPath,
      verifyReportPath: reportPath,
      logger: cfg.host.logger,
      carryoverItems: readCarryoverItems(runtime.runtimeRoot),
    });
    // Diary is the only LLM that saw the full cycle; let it finalize carryover for next loop.
    try {
      const diaryMarkdown = diary?.markdown
        ?? (diary?.mdPath && existsSync(diary.mdPath) ? readFileSync(diary.mdPath, 'utf-8') : '');
      const carryoverItems = extractCarryoverFromDiaryMarkdown(diaryMarkdown);
      if (carryoverItems.length) {
        writeCarryoverItems(runtime.runtimeRoot, {
          cycleId: execResult?.cycle_id || intelResult?.cycle_id,
          items: carryoverItems,
        });
      }
    } catch (carryErr) {
      cfg.host?.logger?.warning?.(
        `[diary] failed to finalize carryover from diary: ${carryErr?.message || carryErr}`,
      );
    }
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'diary', 'done');
      await persistCheckpoint(recordState, artifactCycleId, 'diary', {
        cycle_id: execResult?.cycle_id || intelResult.cycle_id,
        mdPath: diary.mdPath ?? null,
        source: diary.source ?? null,
        tldr: diary.tldr ?? null,
      });
    }
    return { diary };
  } catch (e) {
    const msg = e?.message || String(e);
    store.recordEvolutionEvent({
      type: 'evolution_diary',
      status: 'failed',
      cycle_id: execResult?.cycle_id || intelResult?.cycle_id,
      subject: runtime.subject,
      namespace: runtime.dataNamespace,
      error: msg,
    });
    if (recordState) {
      const artifactCycleId = stateCycleId(intelResult, null, execResult);
      await recordStepSidecar(recordState.root, recordState.subject, artifactCycleId, 'diary', 'failed', { error: msg });
    }
    return { failed: true, error: msg };
  }
}

const REQUIRED_CHECKPOINT_STEPS = new Set(['agent_loop', 'intel', 'intel_report', 'exec', 'verify']);

async function persistCheckpoint(recordState, cycleId, step, payload, { required } = {}) {
  if (!recordState?.root || !recordState?.subject || !cycleId) return;
  const mustPersist = required ?? REQUIRED_CHECKPOINT_STEPS.has(step);
  try {
    writeStepArtifact(recordState.root, recordState.subject, cycleId, step, payload);
  } catch (err) {
    if (mustPersist) {
      throw new Error(`checkpoint write failed for ${step} (cycle=${cycleId}): ${err?.message || err}`);
    }
  }
}

function loadVerifyReport(runtimeRoot, cycleId) {
  return loadVerifyReportForCycle(runtimeRoot, cycleId);
}

/**
 * @deprecated use loadCycleStepContext
 */
export function loadStepArtifacts(runtimeRoot, cycleId) {
  const { verification, reportPath } = loadVerifyReport(runtimeRoot, cycleId);
  return { verification, reportPath };
}

export const CYCLE_STEP_RUNNERS = Object.freeze([
  'agent_loop',
  'intel',
  'intel_report',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);
