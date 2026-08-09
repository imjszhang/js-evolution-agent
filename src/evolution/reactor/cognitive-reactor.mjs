/**
 * Cognitive shadow reactor (Phase 2).
 * claim → investigate → report(Seen splice) → decide → shadow artifacts only.
 * Never writes pending_decisions.json / reports index / evolution-events.
 */
import { join } from 'node:path';
import { chatMessagesDetailed } from '../../ai/messages.mjs';
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
import {
  buildSeenSection,
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

function formatBatchDigest(events = []) {
  return {
    findings_summary: `Shadow batch claimed ${events.length} evidence envelope(s).`,
    enough_for_report: true,
    event_ids: events.map((e) => e.id),
    kinds: [...new Set(events.map((e) => e.kind))],
  };
}

function buildShadowReportPrompt({ batchId, hostSeenBody, investigationDigest, language }) {
  const langNote = language === 'zh'
    ? '用中文撰写判断章节。'
    : 'Write judgement sections in English.';
  return [
    'Shadow Cognitive Reactor Report Task',
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

function buildShadowDecidePrompt({ batchId, reportMarkdown }) {
  return [
    'Strategic Analysis & Decision (shadow reactor)',
    `batch_id: ${batchId}`,
    'Return JSON only with fields: decision, actions[], goal_coverage, deferred, risk_mitigation, confidence_score.',
    'Prefer record_observation / propose_probe / write_retrospective when uncertain.',
    '',
    '## Report',
    String(reportMarkdown || '').slice(0, 12000),
  ].join('\n');
}

/**
 * @param {{ cfg: object, engine: object, runtime: object, store: object, projectRoot?: string }} ctx
 */
export async function runCognitiveShadowReaction(ctx, {
  batchLimit = 16,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  kinds = null,
  skipInvestigate = false,
} = {}) {
  const { cfg, engine, runtime, store } = ctx;
  const dataRoot = runtime.dataRoot || join(runtime.runtimeRoot, 'data');
  const subject = runtime.subject;
  const logger = cfg.host?.logger || null;
  const aiClient = cfg.aiClient;

  if (!aiClient) {
    throw new Error('cognitive shadow reactor requires cfg.aiClient');
  }

  reconcileExpiredClaims(dataRoot);
  if (isReactorBusy(dataRoot, 'cognitive')) {
    return { skipped: true, reason: 'reactor_busy' };
  }

  const claimed = claimEvidenceBatch(dataRoot, {
    reactor: 'cognitive',
    subject,
    limit: batchLimit,
    kinds,
    timeoutMs,
  });
  if (claimed.skipped) {
    return { skipped: true, reason: claimed.skipped };
  }

  const { batch_id: batchId, events } = claimed;
  const deadlineAt = claimed.claim.deadline_at;
  const startedAt = Date.now();

  const emitShadow = (event) => {
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
      logFn: (msg) => logger?.info?.(`[reactor:shadow] ${msg}`),
    });
    let queueSummary = null;
    try {
      queueSummary = decisionQueue.summarize();
    } catch {
      queueSummary = null;
    }

    const prepared = prepareIntelReport({
      intelResult: {
        cycle_id: batchId,
        timestamp: new Date().toISOString(),
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

    let investigation = formatBatchDigest(events);
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
        cycleId: batchId,
        decisionQueue,
        actionRegistry: cfg.actionRegistry,
        budget,
        dedup: new Set(),
        queued: [],
        executed: [],
        investigation: null,
        queryLog: [],
        emitEvent: emitShadow,
        logger,
      };
      loopCtx.executed = loopCtx.queued;
      const tools = buildInvestigationTools(loopCtx);
      logger?.info?.(`[reactor:shadow] investigate batch=${batchId} events=${events.length}`);
      investigateResult = await runInvestigationLoop({
        aiClient,
        tools,
        systemPrompt: 'You are a shadow cognitive reactor investigator. Use read-only tools then finish_investigation.',
        initialUserPrompt: [
          `Shadow batch ${batchId}`,
          'Claimed evidence:',
          batchSeen,
          'Finish when enough for a short report.',
        ].join('\n'),
        budget,
        logger,
        emitEvent: emitShadow,
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

    logger?.info?.(`[reactor:shadow] report batch=${batchId}`);
    const reportPrompt = buildShadowReportPrompt({
      batchId,
      hostSeenBody,
      investigationDigest: investigation,
      language,
    });
    let rawReportMarkdown = null;
    try {
      const reportResult = await chatMessagesDetailed(aiClient, [
        { role: 'system', content: 'You draft intelligence reports. Host owns Seen.' },
        { role: 'user', content: reportPrompt },
      ], { thinking: 'low', timeout: 180, phase: 'report' });
      if (typeof reportResult?.text === 'string' && reportResult.text.trim()) {
        rawReportMarkdown = `${reportResult.text.trim()}\n`;
      }
    } catch (e) {
      logger?.warning?.(`[reactor:shadow] report failed: ${e?.message || e}`);
    }

    if (!rawReportMarkdown) {
      rawReportMarkdown = [
        '# Shadow Cognitive Reactor Report',
        '',
        '## Seen',
        hostSeenBody,
        '',
        '## Inferred',
        '- Shadow reactor fallback report (model output empty).',
        '',
        '## Cyber-Taoist analysis',
        '- Batch claimed; awaiting richer model output.',
        '',
        '## Next cycle suggestions',
        '- Continue dual-run comparison against the train Decide.',
        '',
      ].join('\n');
    }

    const reportMarkdown = spliceHostSeen(rawReportMarkdown, hostSeenBody);
    const reportPath = writeShadowReport(dataRoot, batchId, reportMarkdown);

    let honestyStatus = 'ok';
    let honestyFindingsCount = 0;
    auditHostSeenReport({
      markdown: reportMarkdown,
      store,
      operatorBriefs,
      emitEvent: (event) => {
        honestyStatus = event.status || 'ok';
        honestyFindingsCount = event.findings_count ?? 0;
        emitShadow({
          type: 'shadow_report_honesty',
          ...event,
        });
      },
      logger,
      eventType: 'shadow_report_honesty',
      logLabel: 'reactor:shadow',
      runtimeRoot: runtime.runtimeRoot,
    });

    logger?.info?.(`[reactor:shadow] decide batch=${batchId}`);
    const decidePrompt = buildShadowDecidePrompt({ batchId, reportMarkdown });
    let rawDecision = null;
    try {
      const decideResult = await chatMessagesDetailed(aiClient, [
        { role: 'system', content: 'Return JSON decisions only.' },
        { role: 'user', content: decidePrompt },
      ], { thinking: 'low', timeout: 180, phase: 'decide' });
      rawDecision = decideResult?.text ?? null;
    } catch (e) {
      logger?.warning?.(`[reactor:shadow] decide failed: ${e?.message || e}`);
    }

    const parsed = await parseAnalyzeDecisionWithRepair(aiClient, rawDecision || '{}', { logger });
    const actions = parsed.analysis?.actions || [];
    const shadowDecisions = appendShadowDecisions(dataRoot, {
      batchId,
      subject,
      actions,
      analysis: parsed.analysis,
    });

    ackBatchHandled(dataRoot, batchId);
    emitShadow({
      type: 'shadow_reaction_completed',
      status: 'ok',
      decisions: shadowDecisions.length,
      investigate_turns: investigateResult.turns ?? 0,
      honesty_status: honestyStatus,
      honesty_findings_count: honestyFindingsCount,
      elapsed_ms: Date.now() - startedAt,
    });

    return {
      skipped: false,
      batch_id: batchId,
      claimed_events: events.length,
      report_path: reportPath,
      decisions: shadowDecisions,
      honesty: {
        status: honestyStatus,
        findings_count: honestyFindingsCount,
      },
      investigation,
      analysis: parsed.analysis,
    };
  } catch (err) {
    const message = err?.message || String(err);
    nackBatchFailed(dataRoot, batchId, { error: message });
    emitShadow({
      type: 'shadow_reaction_failed',
      status: 'failed',
      error: message,
      elapsed_ms: Date.now() - startedAt,
    });
    throw err;
  }
}
