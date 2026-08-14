/**
 * Cognitive reactor (Phase 2 shadow + Phase 3 live gray).
 * claim → investigate → report(Seen splice) → decide.
 * Shadow: artifacts under data/evolution/reactor/ only.
 * Live: real pending_decisions, reports index, evolution-events.
 */
import { join } from 'node:path';
import { actionRegistry as hostActionRegistry } from '../../actions/registry.mjs';
import { chatMessagesDetailed } from '../../ai/messages.mjs';
import { isoBeijing } from '../../engine/index.mjs';
import { createHostDecisionQueue } from '../../intelligence/decision-queue.mjs';
import { parseAnalyzeDecisionWithRepair } from '../../intelligence/decide-json.mjs';
import {
  assembleHostSeenBody,
  auditHostSeenReport,
  spliceHostSeen,
} from '../../intelligence/host-seen.mjs';
import {
  readPendingOperatorBriefs,
  summarizeOperatorBriefsForContext,
} from '../../intelligence/operator-briefs.mjs';
import { queueAnalyzeDecideActions } from '../../intelligence/phase1-shared.mjs';
import {
  buildSeenSection,
  persistIntelReport,
  prepareIntelReport,
} from '../../intelligence/report-builder.mjs';
import { buildInvestigationTools } from '../agent-loop/tool-registry.mjs';
import { runInvestigationLoop } from '../agent-loop/loop-runner.mjs';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  isReactorBusy,
  nackBatchFailed,
  reconcileExpiredClaims,
} from './claim-ledger.mjs';
import {
  appendShadowDecisions,
  appendShadowRun,
  writeShadowReport,
} from './shadow-store.mjs';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function formatBatchAsMechanicalSeen(events = []) {
  if (!events.length) return '- (none)';
  return events.slice(0, 40).map((envelope) => {
    const type = envelope.type || envelope.kind;
    const cycle = envelope.cycle_id ? ` cycle=${envelope.cycle_id}` : '';
    return `- [${envelope.kind}:${envelope.id}] ${type} @ ${envelope.occurred_at}${cycle}`;
  }).join('\n');
}

function formatBatchDigest(events = [], { live = false } = {}) {
  return {
    findings_summary: `${live ? 'Live' : 'Shadow'} batch claimed ${events.length} evidence envelope(s).`,
    enough_for_report: true,
    event_ids: events.map((e) => e.id),
    kinds: [...new Set(events.map((e) => e.kind))],
  };
}

function buildReportPrompt({ batchId, hostSeenBody, investigationDigest, language, live = false }) {
  const langNote = language === 'zh'
    ? '用中文撰写判断章节。'
    : 'Write judgement sections in English.';
  return [
    live ? 'Cognitive Reactor Report Task' : 'Shadow Cognitive Reactor Report Task',
    `batch_id: ${batchId}`,
    langNote,
    'Host owns the Seen section; write Inferred / Cyber-Taoist analysis / Next suggestions only.',
    '',
    '## Host Seen (do not invent refs)',
    hostSeenBody || '- (none)',
    '',
    '## Investigation digest',
    JSON.stringify(investigationDigest, null, 2),
    '',
    'Return a Markdown intelligence report with ## Seen, ## Inferred, ## Cyber-Taoist analysis, ## Next cycle suggestions.',
  ].join('\n');
}

export function buildDecidePrompt({
  batchId,
  reportMarkdown,
  live = false,
  actionRegistry = null,
} = {}) {
  const registry = actionRegistry && typeof actionRegistry.toPromptSection === 'function'
    ? actionRegistry
    : hostActionRegistry;
  const actionTypes = typeof registry.toPromptSection === 'function'
    ? registry.toPromptSection()
    : '(no registered actions)';
  return [
    live ? 'Strategic Analysis & Decision (cognitive reactor)' : 'Strategic Analysis & Decision (shadow reactor)',
    `batch_id: ${batchId}`,
    'Return JSON only with fields: decision, actions[], goal_coverage, deferred, risk_mitigation, confidence_score.',
    'actions MUST be an array of objects, never strings. Each action needs type, description, serves_goal, and params.',
    'params MUST include the Required params for the chosen type (see Available Action Types). Empty params objects are invalid.',
    'Prefer record_observation / propose_probe / write_retrospective when uncertain.',
    'Example shape:',
    '{',
    '  "decision": "execute",',
    '  "actions": [{',
    '    "type": "record_observation",',
    '    "description": "...",',
    '    "serves_goal": "<goal_id>",',
    '    "params": { "content": "..." }',
    '  }],',
    '  "goal_coverage": { "covered": [], "not_covered": {} },',
    '  "deferred": [],',
    '  "risk_mitigation": [],',
    '  "confidence_score": 0.5',
    '}',
    '',
    '## Available Action Types',
    actionTypes,
    '',
    '## Report',
    String(reportMarkdown || '').slice(0, 12000),
  ].join('\n');
}

/**
 * @param {{ cfg: object, engine: object, runtime: object, store: object, projectRoot?: string }} ctx
 * @param {object} opts
 * @param {'shadow'|'live'} [opts.mode]
 * @param {string|null} [opts.cycleId] required for live
 */
export async function runCognitiveReaction(ctx, {
  mode = 'shadow',
  cycleId = null,
  batchLimit = 16,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  kinds = null,
  skipInvestigate = false,
} = {}) {
  const isLive = mode === 'live';
  const logLabel = isLive ? 'reactor:live' : 'reactor:shadow';
  const { cfg, runtime, store } = ctx;
  const dataRoot = runtime.dataRoot || join(runtime.runtimeRoot, 'data');
  const subject = runtime.subject;
  const logger = cfg.host?.logger || null;
  const aiClient = cfg.aiClient;

  if (!aiClient) {
    throw new Error(`cognitive ${mode} reactor requires cfg.aiClient`);
  }
  if (isLive && !cycleId) {
    throw new Error('cognitive live reactor requires cycleId');
  }

  reconcileExpiredClaims(dataRoot);
  if (isReactorBusy(dataRoot, 'cognitive')) {
    return { skipped: true, reason: 'reactor_busy', mode };
  }

  const claimed = claimEvidenceBatch(dataRoot, {
    reactor: 'cognitive',
    subject,
    limit: batchLimit,
    kinds,
    timeoutMs,
  });
  if (claimed.skipped) {
    return { skipped: true, reason: claimed.skipped, mode };
  }

  const { batch_id: batchId, events } = claimed;
  const deadlineAt = claimed.claim.deadline_at;
  const startedAt = Date.now();
  const reactionCycleId = isLive ? cycleId : batchId;

  const emitReaction = (event) => {
    if (isLive) {
      store.recordEvolutionEvent({
        ...event,
        cycle_id: reactionCycleId,
        subject,
        batch_id: batchId,
      });
      return;
    }
    appendShadowRun(dataRoot, {
      batch_id: batchId,
      subject,
      ...event,
    });
  };

  try {
    if (Date.parse(deadlineAt) <= Date.now()) {
      throw new Error('reactor_deadline_expired');
    }

    const operatorBriefRead = readPendingOperatorBriefs(runtime.runtimeRoot);
    const operatorBriefs = operatorBriefRead.briefs || [];
    const operatorBriefsSummary = summarizeOperatorBriefsForContext(operatorBriefs);

    const decisionQueue = createHostDecisionQueue({
      dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
      logFn: (msg) => logger?.info?.(`[${logLabel}] ${msg}`),
    });
    let queueSummary = null;
    try {
      queueSummary = decisionQueue.summarize();
    } catch {
      queueSummary = null;
    }

    const prepared = prepareIntelReport({
      intelResult: {
        cycle_id: reactionCycleId,
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
    const mechanicalSeenFromStore = buildSeenSection(prepared.reportContext) || '(none)';
    const batchSeen = formatBatchAsMechanicalSeen(events);
    const mechanicalSeen = [mechanicalSeenFromStore, '## Claimed evidence batch', batchSeen]
      .filter(Boolean)
      .join('\n\n');

    let investigation = formatBatchDigest(events, { live: isLive });
    let investigateResult = { turns: 0, readonlyCalls: 0 };

    if (!skipInvestigate && typeof aiClient.chatMessagesWithTools === 'function') {
      const budget = {
        maxTurns: 4,
        maxActions: 0,
        maxWallClockMs: Math.min(timeoutMs, 120_000),
        toolResultMaxChars: 4000,
        finishReserveMs: 15_000,
        reportDecideReserveMs: 15_000,
        closingTimeoutSec: 60,
        actionsUsed: 0,
      };
      const loopCtx = {
        cfg,
        host: cfg.host,
        runtime,
        store,
        cycleId: reactionCycleId,
        decisionQueue,
        actionRegistry: cfg.actionRegistry,
        budget,
        dedup: new Set(),
        queued: [],
        executed: [],
        investigation: null,
        queryLog: [],
        emitEvent: emitReaction,
        logger,
      };
      loopCtx.executed = loopCtx.queued;
      const tools = buildInvestigationTools(loopCtx);
      logger?.info?.(`[${logLabel}] investigate batch=${batchId} events=${events.length}`);
      investigateResult = await runInvestigationLoop({
        aiClient,
        tools,
        systemPrompt: isLive
          ? 'You are a cognitive reactor investigator. Use read-only tools then finish_investigation.'
          : 'You are a shadow cognitive reactor investigator. Use read-only tools then finish_investigation.',
        initialUserPrompt: [
          `${isLive ? 'Live' : 'Shadow'} batch ${batchId}`,
          'Claimed evidence:',
          batchSeen,
          'Finish when enough for a short report.',
        ].join('\n'),
        budget,
        logger,
        emitEvent: emitReaction,
      });
      if (investigateResult?.investigation) {
        investigation = {
          ...investigation,
          ...investigateResult.investigation,
        };
      }
    }

    const hostSeenBody = assembleHostSeenBody({
      reportContext: prepared.reportContext,
      queueSummary,
      operatorBriefs: operatorBriefsSummary,
      mechanicalSeen,
      verifiedFacts: investigation.verified_facts || [],
    });

    logger?.info?.(`[${logLabel}] report batch=${batchId}`);
    const reportPrompt = buildReportPrompt({
      batchId,
      hostSeenBody,
      investigationDigest: investigation,
      language,
      live: isLive,
    });
    let rawReportMarkdown = null;
    let reportSource = 'fallback';
    let reportReason = null;
    try {
      const reportResult = await chatMessagesDetailed(aiClient, [
        { role: 'system', content: 'You draft intelligence reports. Host owns Seen.' },
        { role: 'user', content: reportPrompt },
      ], { thinking: 'off', timeout: 180, phase: 'report' });
      if (typeof reportResult?.text === 'string' && reportResult.text.trim()) {
        rawReportMarkdown = `${reportResult.text.trim()}\n`;
        reportSource = 'ai';
      } else {
        reportReason = 'empty-output';
      }
    } catch (e) {
      reportReason = e?.message || String(e);
      logger?.warning?.(`[${logLabel}] report failed: ${reportReason}`);
    }

    if (!rawReportMarkdown) {
      rawReportMarkdown = [
        isLive ? '# Cognitive Reactor Report' : '# Shadow Cognitive Reactor Report',
        '',
        '## Seen',
        hostSeenBody,
        '',
        '## Inferred',
        `- ${isLive ? 'Live' : 'Shadow'} reactor fallback report (model output empty).`,
        '',
        '## Cyber-Taoist analysis',
        '- Batch claimed; awaiting richer model output.',
        '',
        '## Next cycle suggestions',
        isLive ? '- Continue reactor gray validation.' : '- Continue dual-run comparison against the train Decide.',
        '',
      ].join('\n');
    }

    const splicedMarkdown = spliceHostSeen(rawReportMarkdown, hostSeenBody);
    let reportPath;
    let reportMarkdown;
    let persistedReport = null;

    if (isLive) {
      persistedReport = await persistIntelReport({
        intelResult: {
          cycle_id: reactionCycleId,
          timestamp: isoBeijing(),
          actions: [],
          decisions_queued: [],
        },
        runtime,
        store,
        agentContextDocs: cfg.agentContextDocs,
        aiClient: reportSource === 'ai' ? aiClient : null,
        logger,
        md: splicedMarkdown,
        source: 'reactor',
        fallbackReason: reportReason,
        updateStandingMemory: false,
        transformMd: (md) => md,
        ...prepared,
      });
      reportPath = persistedReport.mdPath;
      reportMarkdown = persistedReport.markdown;
    } else {
      reportMarkdown = splicedMarkdown;
      reportPath = writeShadowReport(dataRoot, batchId, reportMarkdown);
    }

    let honestyStatus = 'ok';
    let honestyFindingsCount = 0;
    const honestyEventType = isLive ? 'reactor_report_honesty' : 'shadow_report_honesty';
    auditHostSeenReport({
      markdown: reportMarkdown,
      store,
      operatorBriefs,
      emitEvent: (event) => {
        honestyStatus = event.status || 'ok';
        honestyFindingsCount = event.findings_count ?? 0;
        emitReaction({
          type: honestyEventType,
          ...event,
        });
      },
      logger,
      eventType: honestyEventType,
      logLabel,
      runtimeRoot: runtime.runtimeRoot,
    });

    logger?.info?.(`[${logLabel}] decide batch=${batchId}`);
    const decidePrompt = buildDecidePrompt({
      batchId,
      reportMarkdown,
      live: isLive,
      actionRegistry: cfg.actionRegistry,
    });
    let rawDecision = null;
    try {
      const decideResult = await chatMessagesDetailed(aiClient, [
        { role: 'system', content: 'Return JSON decisions only.' },
        { role: 'user', content: decidePrompt },
      ], { thinking: 'off', timeout: 180, phase: 'decide' });
      rawDecision = decideResult?.text ?? null;
    } catch (e) {
      logger?.warning?.(`[${logLabel}] decide failed: ${e?.message || e}`);
    }

    const parsed = await parseAnalyzeDecisionWithRepair(aiClient, rawDecision || '{}', { logger });
    const actions = parsed.analysis?.actions || [];
    let queuedActions = actions;
    let queuedIds = [];
    let skippedCount = 0;

    if (isLive) {
      const queuedResult = await queueAnalyzeDecideActions({
        projectRoot: runtime.runtimeRoot,
        host: cfg.host,
        runtime,
        decisionQueue,
        cycleId: reactionCycleId,
        timestamp: isoBeijing(),
        goalId: 'bootstrap',
        analysis: parsed.analysis,
        actions,
        reportPath,
        reportMarkdown,
        operatorBriefs,
        pipeline: 'reactor',
      });
      queuedActions = queuedResult.actions;
      queuedIds = queuedResult.decisions_queued;
      skippedCount = queuedResult.decisions_skipped?.length ?? 0;
      logger?.info?.(`[${logLabel}] queued=${queuedIds.length} skipped=${skippedCount}`);
    } else {
      const shadowResult = appendShadowDecisions(dataRoot, {
        batchId,
        subject,
        actions,
        analysis: parsed.analysis,
      });
      queuedActions = shadowResult.decisions;
      skippedCount = shadowResult.skipped?.length ?? 0;
      logger?.info?.(`[${logLabel}] shadow queued=${queuedActions.length} skipped=${skippedCount}`);
    }

    ackBatchHandled(dataRoot, batchId);
    const elapsedMs = Date.now() - startedAt;
    if (isLive) {
      store.recordEvolutionEvent({
        type: 'reactor_pipeline',
        status: reportSource === 'ai' ? 'ok' : 'forced',
        cycle_id: reactionCycleId,
        subject,
        batch_id: batchId,
        claimed_events: events.length,
        decisions_queued: queuedIds.length,
        decisions_skipped: skippedCount,
        investigate_turns: investigateResult.turns ?? 0,
        honesty_status: honestyStatus,
        report_source: persistedReport?.source ?? reportSource,
        duration_ms: elapsedMs,
      });
    }
    emitReaction({
      type: isLive ? 'reactor_reaction_completed' : 'shadow_reaction_completed',
      status: 'ok',
      decisions: isLive ? queuedIds.length : queuedActions.length,
      decisions_skipped: skippedCount,
      investigate_turns: investigateResult.turns ?? 0,
      honesty_status: honestyStatus,
      honesty_findings_count: honestyFindingsCount,
      elapsed_ms: elapsedMs,
    });

    return {
      skipped: false,
      mode,
      batch_id: batchId,
      cycle_id: reactionCycleId,
      claimed_events: events.length,
      report_path: reportPath,
      report: isLive ? {
        mdPath: reportPath,
        source: persistedReport?.source ?? reportSource,
        indexRecord: persistedReport?.indexRecord ?? null,
        markdown: reportMarkdown,
      } : null,
      decisions: queuedActions,
      decisions_queued: queuedIds,
      decisions_skipped: skippedCount,
      honesty: {
        status: honestyStatus,
        findings_count: honestyFindingsCount,
      },
      investigation,
      analysis: parsed.analysis,
      duration_ms: elapsedMs,
    };
  } catch (err) {
    const message = err?.message || String(err);
    nackBatchFailed(dataRoot, batchId, { error: message });
    emitReaction({
      type: isLive ? 'reactor_reaction_failed' : 'shadow_reaction_failed',
      status: 'failed',
      error: message,
      elapsed_ms: Date.now() - startedAt,
    });
    throw err;
  }
}

/** @deprecated alias — use runCognitiveReaction({ mode: 'shadow' }) */
export async function runCognitiveShadowReaction(ctx, opts = {}) {
  return runCognitiveReaction(ctx, { ...opts, mode: 'shadow' });
}

export async function runCognitiveLiveReaction(ctx, opts = {}) {
  return runCognitiveReaction(ctx, { ...opts, mode: 'live' });
}
