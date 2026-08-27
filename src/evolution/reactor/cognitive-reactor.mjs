/**
 * Cognitive reactor (Phase 2 shadow + Phase 3 live gray).
 * claim → assemble reaction candidate → investigate → report(Seen splice) → decide.
 * A candidate is a bounded decision-relevant semantic delta, not a raw 16-record batch.
 * Empty-delta candidates complete as handled without report/Decide LLM calls.
 * Shadow: artifacts under data/evolution/reactor/ only.
 * Live: real pending_decisions, reports index, evolution-events.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionRegistry as hostActionRegistry } from '../../actions/registry.mjs';
import { chatMessagesDetailed } from '../../ai/messages.mjs';
import {
  accumulateLlmUsage,
  buildPromptCacheMetadata,
  formatLlmUsageSummary,
  markPromptCacheInvariant,
  summarizeLlmUsage,
} from '../../ai/prompt-cache-metadata.mjs';
import { extractBeliefContext } from '../../contracts/belief-context.mjs';
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
import { readPendingOperatorFacts } from '../../intelligence/operator-facts.mjs';
import { buildTemporalDecisionBrief } from '../../intelligence/decision-brief.mjs';
import {
  queueAnalyzeDecideActions,
  validateQueuedAction,
} from '../../intelligence/phase1-shared.mjs';
import {
  buildSeenSection,
  persistIntelReport,
  prepareIntelReport,
} from '../../intelligence/report-builder.mjs';
import { buildInvestigationTools } from '../investigation/tool-registry.mjs';
import { runInvestigationLoop } from '../investigation/loop-runner.mjs';
import {
  checkpointStageReached,
  findResumableCheckpoint,
  patchBatchCheckpoint,
  readBatchCheckpoint,
} from './batch-checkpoint-store.mjs';
import {
  computeRuleFeedbackStats,
  formatRuleFeedbackForPrompt,
} from '../../intelligence/rule-feedback.mjs';
import { formatDecisionBacklogForPrompt, safeBacklogSummary } from '../../intelligence/phase1-shared.mjs';
import { loadEnabledGuards } from '../investigation/guard-runner.mjs';
import { readCarryoverDocument } from '../carryover.mjs';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  isReactorBusy,
  loadClaimedEvents,
  nackBatchFailed,
  reattachBatchClaim,
  reconcileExpiredClaims,
  releaseBatchClaim,
} from './claim-ledger.mjs';
import { getActivationLedgerEntry } from './activation-ledger-store.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';
import {
  assembleReactionCandidates,
  formatCandidateAsMechanicalSeen,
  resolveCognitiveWork,
} from './reaction-candidate.mjs';
import {
  appendShadowDecisions,
  appendShadowRun,
  readShadowRuns,
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

function formatReactionWorkSeen(work, events = []) {
  const candidateSeen = formatCandidateAsMechanicalSeen(work?.candidate);
  if (candidateSeen && candidateSeen !== '- (none)') return candidateSeen;
  return formatBatchAsMechanicalSeen(events);
}

function hasHonestyEvent({
  store,
  dataRoot,
  batchId,
  eventType,
  isLive,
}) {
  if (!batchId) return false;
  if (isLive && typeof store?.readEvolutionEvents === 'function') {
    return (store.readEvolutionEvents({ limit: 400 }) || []).some((event) => (
      event?.type === eventType
      && (event.batch_id === batchId || event.producer_batch_id === batchId)
    ));
  }
  return readShadowRuns(dataRoot, { limit: 400 }).some((row) => (
    row?.type === eventType && row.batch_id === batchId
  ));
}

function formatBatchDigest(events = [], { live = false } = {}) {
  return {
    findings_summary: `${live ? 'Live' : 'Shadow'} batch claimed ${events.length} evidence envelope(s).`,
    enough_for_report: true,
    event_ids: events.map((e) => e.id),
    kinds: [...new Set(events.map((e) => e.kind))],
  };
}

function recordPromptCache({ profile, messages, stablePrefix, dynamicPayload, logger }) {
  const metadata = buildPromptCacheMetadata({
    profile,
    messages,
    stablePrefix,
    dynamicPayload,
  });
  const invariant = markPromptCacheInvariant({
    scope: profile,
    metadata,
    logger,
  });
  return { metadata, invariant };
}

function buildReportPrompt({
  batchId,
  hostSeenBody,
  investigationDigest,
  language,
  live = false,
  candidate = null,
}) {
  const langNote = language === 'zh'
    ? '用中文撰写判断章节。'
    : 'Write judgement sections in English.';
  const stablePrefix = [
    live ? 'Cognitive Reactor Report Task' : 'Shadow Cognitive Reactor Report Task',
    langNote,
    'Host owns the Seen section; write Inferred / Cyber-Taoist analysis / Next suggestions only.',
    'Return a Markdown intelligence report with ## Seen, ## Inferred, ## Cyber-Taoist analysis, ## Next cycle suggestions.',
  ].join('\n');
  const dynamicPayload = [
    `batch_id: ${batchId}`,
    candidate?.candidate_id ? `candidate_id: ${candidate.candidate_id}` : '',
    '',
    '## Host Seen (do not invent refs)',
    hostSeenBody || '- (none)',
    '',
    '## Investigation digest',
    JSON.stringify(investigationDigest, null, 2),
  ].filter((line, index, rows) => !(line === '' && rows[index - 1] === '')).join('\n');
  return {
    stablePrefix,
    dynamicPayload,
    content: `${stablePrefix}\n\n## Dynamic Batch Payload\n\n${dynamicPayload}`,
  };
}

export function buildDecidePrompt({
  batchId,
  reportMarkdown,
  live = false,
  actionRegistry = null,
  ruleFeedbackText = '',
  decisionBacklogText = '',
  decisionConstraints = null,
  candidate = null,
} = {}) {
  const registry = actionRegistry && typeof actionRegistry.toPromptSection === 'function'
    ? actionRegistry
    : hostActionRegistry;
  const actionTypes = typeof registry.toPromptSection === 'function'
    ? registry.toPromptSection()
    : '(no registered actions)';
  const stablePrefix = [
    live ? 'Strategic Analysis & Decision (cognitive reactor)' : 'Strategic Analysis & Decision (shadow reactor)',
    'Return JSON only with fields: decision, actions[], goal_coverage, deferred, risk_mitigation, confidence_score.',
    'actions MUST be an array of objects, never strings. Each action needs type, description, serves_goal, and params.',
    'params MUST include the Required params for the chosen type (see Available Action Types). Empty params objects are invalid.',
    'Belief-bound action types (agent_run, agent_execute, run_probe, propose_probe) MUST declare belief_id, belief_relation, and expected_belief_update in params.run_spec.context (agent_run) or params.context (other types).',
    'belief_id MUST name an active or validated belief from Decision Constraints. A refuted belief may only use belief_relation="recover_blocker"; unknown ids are invalid except a fresh-subject agent_run bootstrap.',
    'When no active/validated/refuted belief exists, one agent_run may bootstrap belief_relation="create_belief" with a new belief_id, expected_belief_claim, expected_belief_update, and a non-empty run_spec.expected_output. Later actions in the same actions array may reference that id. Bootstrap never grants or bypasses approval.',
    'Every other mechanical/housekeeping action MUST either carry the same valid belief binding or params.context.no_belief_reason as a machine-readable snake_case code.',
    'Prefer record_observation / propose_probe / write_retrospective when uncertain.',
    'Example shape:',
    '{',
    '  "decision": "execute",',
    '  "actions": [{',
    '    "type": "record_observation",',
    '    "description": "...",',
    '    "serves_goal": "<goal_id>",',
    '    "params": { "content": "...", "context": { "no_belief_reason": "record_only" } }',
    '  }],',
    '  "goal_coverage": { "covered": [], "not_covered": {} },',
    '  "deferred": [],',
    '  "risk_mitigation": [],',
    '  "confidence_score": 0.5',
    '}',
    '',
    '## Available Action Types',
    actionTypes,
  ].join('\n');
  const dynamicPayload = [
    `batch_id: ${batchId}`,
    candidate?.candidate_id ? `candidate_id: ${candidate.candidate_id}` : '',
    '',
    '## Report',
    String(reportMarkdown || '').slice(0, 12000),
    decisionConstraints ? `\n## Decision Constraints\n\n${JSON.stringify(decisionConstraints, null, 2)}` : '',
    ruleFeedbackText ? `\n${ruleFeedbackText}` : '',
    decisionBacklogText ? `\n## Decision Backlog\n\n${decisionBacklogText}` : '',
  ].filter(Boolean).join('\n');
  return {
    stablePrefix,
    dynamicPayload,
    content: `${stablePrefix}\n\n## Dynamic Batch Payload\n\n${dynamicPayload}`,
  };
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
  canCommit = null,
  identity_key = null,
} = {}) {
  const isLive = mode === 'live';
  const logLabel = isLive ? 'reactor:live' : 'reactor:shadow';
  const { cfg, runtime, store } = ctx;
  const dataRoot = runtime.dataRoot || join(runtime.runtimeRoot, 'data');
  const subject = runtime.subject;
  const logger = cfg.host?.logger || null;
  const aiClient = cfg.aiClient;
  const assertCommitLease = () => {
    if (typeof canCommit === 'function' && !canCommit()) {
      const error = new Error('reactor_task_lease_lost');
      error.code = 'lease_lost';
      throw error;
    }
  };

  if (!aiClient) {
    throw new Error(`cognitive ${mode} reactor requires cfg.aiClient`);
  }
  if (isLive && !cycleId) {
    cycleId = `reaction-${Date.now()}`;
  }

  reconcileExpiredClaims(dataRoot);
  let resumable = findResumableCheckpoint(dataRoot, { reactor: 'cognitive' });
  if (identity_key && resumable?.evidence_keys?.length) {
    const targeted = getActivationLedgerEntry(dataRoot, identity_key);
    const wanted = targeted?.identity?.evidence_key ?? targeted?.evidence_key;
    if (wanted && !resumable.evidence_keys.includes(wanted)) {
      resumable = null;
    }
  }
  let claimed;
  let resumed = false;
  if (resumable?.batch_id) {
    const claim = reattachBatchClaim(dataRoot, resumable.batch_id, {
      timeoutMs,
      reactor: 'cognitive',
      subject,
      eventIds: resumable.event_ids,
      evidenceKeys: resumable.evidence_keys,
    });
    const events = loadClaimedEvents(dataRoot, claim || resumable, { reactor: 'cognitive' });
    claimed = {
      batch_id: resumable.batch_id,
      claim,
      events,
      checkpoint: resumable,
    };
    resumed = true;
  } else if (identity_key) {
    const entry = getActivationLedgerEntry(dataRoot, identity_key);
    const evidenceKey = entry?.identity?.evidence_key ?? entry?.evidence_key;
    if (!evidenceKey) {
      return {
        skipped: true,
        ok: true,
        reason: 'activation_identity_unresolved',
        activation_effect: 'release',
        mode,
      };
    }
    if (isReactorBusy(dataRoot, 'cognitive')) {
      return {
        skipped: true,
        ok: true,
        reason: 'reactor_busy',
        activation_effect: 'release',
        mode,
      };
    }
    claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      subject,
      limit: 1,
      kinds,
      timeoutMs,
      evidenceKeys: [evidenceKey],
    });
  } else {
    if (isReactorBusy(dataRoot, 'cognitive')) {
      return { skipped: true, reason: 'reactor_busy', mode };
    }
    claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      subject,
      limit: batchLimit,
      kinds,
      timeoutMs,
    });
  }
  if (claimed.skipped) {
    return {
      skipped: true,
      ok: true,
      reason: claimed.skipped,
      activation_effect: identity_key ? 'defer' : undefined,
      hold_reason: identity_key
        ? { class: 'policy', code: claimed.skipped === 'no_pending_evidence' ? 'no_op' : String(claimed.skipped) }
        : undefined,
      mode,
    };
  }

  const { batch_id: batchId, events } = claimed;
  const existingCheckpoint = claimed.checkpoint || readBatchCheckpoint(dataRoot, batchId);
  patchBatchCheckpoint(dataRoot, batchId, {
    reactor: 'cognitive',
    subject,
    stage: existingCheckpoint?.stage || 'claimed',
    event_ids: events.map((item) => item.id),
    evidence_keys: events.map((item) => envelopeEvidenceKey(item)),
    cycle_id: isLive ? (existingCheckpoint?.cycle_id || cycleId) : null,
    attempt: claimed.claim?.attempt ?? existingCheckpoint?.attempt ?? 1,
    resumed,
  });
  const deadlineAt = claimed.claim.deadline_at;
  const startedAt = Date.now();
  const reactionCycleId = isLive ? (existingCheckpoint?.cycle_id || cycleId) : batchId;

  const emitReaction = (event) => {
    if (isLive) {
      store.recordEvolutionEvent({
        ...event,
        cycle_id: reactionCycleId,
        subject,
        batch_id: batchId,
        producer: 'cognitive',
        activation_targets: [],
        producer_batch_id: batchId,
        reaction_id: reactionCycleId,
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
    const promptCache = {};
    if (Date.parse(deadlineAt) <= Date.now()) {
      throw new Error('reactor_deadline_expired');
    }

    const operatorBriefRead = readPendingOperatorBriefs(runtime.runtimeRoot);
    const operatorBriefs = operatorBriefRead.briefs || [];
    const operatorBriefsSummary = summarizeOperatorBriefsForContext(operatorBriefs);
    const pendingFacts = readPendingOperatorFacts(runtime.runtimeRoot, { limit: 50 }).facts || [];

    const pastAssembly = Boolean(existingCheckpoint?.assembly_completed)
      && existingCheckpoint?.candidate;
    const pastInvestigate = checkpointStageReached(existingCheckpoint, 'investigate');
    let reactionWork = pastAssembly
      ? {
        invoke_llm: existingCheckpoint.candidate.decision_relevant !== false
          && existingCheckpoint.skip_reason !== 'no_decision_relevant_delta',
        skip_reason: existingCheckpoint.skip_reason || existingCheckpoint.candidate.skip_reason || null,
        mechanical_reason: existingCheckpoint.mechanical_reason || null,
        candidate: existingCheckpoint.candidate,
      }
      : null;
    if (!reactionWork) {
      const assembly = assembleReactionCandidates(events, {
        reactor: 'cognitive',
        pendingBriefs: operatorBriefs,
        pendingFacts,
      });
      reactionWork = resolveCognitiveWork(assembly);
      patchBatchCheckpoint(dataRoot, batchId, {
        stage: existingCheckpoint?.stage || 'claimed',
        assembly_completed: true,
        candidate: reactionWork.candidate,
        skip_reason: reactionWork.skip_reason,
        mechanical_reason: reactionWork.mechanical_reason,
        llm_skipped: !reactionWork.invoke_llm,
      });
      emitReaction({
        type: isLive ? 'reactor_candidate_assembled' : 'shadow_candidate_assembled',
        status: 'ok',
        candidate_id: reactionWork.candidate?.candidate_id || null,
        decision_relevant: Boolean(reactionWork.invoke_llm),
        skip_reason: reactionWork.skip_reason,
        included_count: reactionWork.candidate?.included?.length || 0,
        coalesced_count: reactionWork.candidate?.estimated_cost?.coalesced_count || 0,
        excluded_count: reactionWork.candidate?.estimated_cost?.excluded_count || 0,
        estimated_prompt_tokens: reactionWork.candidate?.estimated_cost?.estimated_prompt_tokens || 0,
      });
    }

    if (!pastInvestigate && !reactionWork.invoke_llm) {
      assertCommitLease();
      patchBatchCheckpoint(dataRoot, batchId, {
        stage: 'committed',
        assembly_completed: true,
        candidate: reactionWork.candidate,
        skip_reason: reactionWork.skip_reason,
        mechanical_reason: reactionWork.mechanical_reason,
        llm_skipped: true,
        queued_decision_ids: [],
        honesty: { status: 'skipped', findings_count: 0, reason: 'no_report' },
      });
      releaseBatchClaim(dataRoot, batchId, { reason: reactionWork.skip_reason || 'no_op' });
      const elapsedMs = Date.now() - startedAt;
      emitReaction({
        type: isLive ? 'reactor_reaction_completed' : 'shadow_reaction_completed',
        status: 'handled',
        llm_skipped: true,
        skip_reason: reactionWork.skip_reason,
        mechanical_reason: reactionWork.mechanical_reason,
        candidate_id: reactionWork.candidate?.candidate_id || null,
        decisions: 0,
        decisions_skipped: 0,
        investigate_turns: 0,
        elapsed_ms: elapsedMs,
      });
      if (isLive) {
        store.recordEvolutionEvent({
          type: 'reactor_pipeline',
          status: 'handled',
          cycle_id: reactionCycleId,
          subject,
          batch_id: batchId,
          producer: 'cognitive',
          activation_targets: [],
          producer_batch_id: batchId,
          reaction_id: reactionCycleId,
          claimed_events: events.length,
          decisions_queued: 0,
          decisions_skipped: 0,
          investigate_turns: 0,
          llm_skipped: true,
          skip_reason: reactionWork.skip_reason,
          candidate_id: reactionWork.candidate?.candidate_id || null,
          duration_ms: elapsedMs,
        });
      }
      return {
        skipped: true,
        handled: false,
        ok: true,
        llm_skipped: true,
        skip_reason: reactionWork.skip_reason,
        reason: reactionWork.skip_reason || 'no_op',
        activation_effect: 'defer',
        hold_reason: {
          class: 'policy',
          code: reactionWork.skip_reason || 'no_op',
        },
        mechanical_reason: reactionWork.mechanical_reason,
        mode,
        batch_id: batchId,
        cycle_id: reactionCycleId,
        reaction_id: reactionCycleId,
        candidate: reactionWork.candidate,
        event_ids: events.map((item) => item.id),
        evidence_keys: events.map((item) => envelopeEvidenceKey(item)),
        claimed_events: events.length,
        report_path: null,
        report: null,
        decisions: [],
        decisions_queued: [],
        decisions_skipped: 0,
        honesty: { status: 'skipped', findings_count: 0, reason: 'no_report' },
        investigation: null,
        analysis: null,
        duration_ms: elapsedMs,
        prompt_cache: promptCache,
      };
    }
    const candidate = reactionWork.candidate;

    const decisionQueue = createHostDecisionQueue({
      dataDir: join(runtime.runtimeRoot, 'data', 'evolution'),
      logFn: (msg) => logger?.info?.(`[${logLabel}] ${msg}`),
    });
    let queueSummary = null;
    let decisionBacklog = null;
    try {
      queueSummary = decisionQueue.summarize();
      decisionBacklog = safeBacklogSummary(decisionQueue, { limit: 15 });
    } catch {
      queueSummary = null;
      decisionBacklog = null;
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
    let humanGuidance = null;
    try {
      humanGuidance = ctx.engine?.guidanceReader?.readGuidance?.() ?? null;
    } catch {
      humanGuidance = null;
    }
    prepared.reportContext.human_guidance = humanGuidance;
    prepared.reportContext.decision_backlog = decisionBacklog;
    prepared.temporalDecisionBrief = buildTemporalDecisionBrief(prepared.reportContext);
    prepared.reportContext.temporal_decision_brief = prepared.temporalDecisionBrief;
    const beliefDecisionContext = prepared.temporalDecisionBrief.decision_constraints;
    const language = prepared.language || 'zh';
    const mechanicalSeenFromStore = buildSeenSection(prepared.reportContext) || '(none)';
    const batchSeen = formatReactionWorkSeen(reactionWork, events);
    const mechanicalSeen = [mechanicalSeenFromStore, '## Reaction candidate', batchSeen]
      .filter(Boolean)
      .join('\n\n');

    let investigation = existingCheckpoint?.investigation || formatBatchDigest(events, { live: isLive });
    let investigateResult = existingCheckpoint?.investigation_result || { turns: 0, readonlyCalls: 0 };
    const skipInvestigateStage = skipInvestigate
      || checkpointStageReached(existingCheckpoint, 'investigate');

    if (!skipInvestigateStage && typeof aiClient.chatMessagesWithTools === 'function') {
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
      const investigateSystem = isLive
        ? 'You are a cognitive reactor investigator. Use read-only tools then finish_investigation.'
        : 'You are a shadow cognitive reactor investigator. Use read-only tools then finish_investigation.';
      const investigateUser = [
        `${isLive ? 'Live' : 'Shadow'} batch ${batchId}`,
        candidate?.candidate_id ? `candidate ${candidate.candidate_id}` : '',
        'Decision-relevant reaction candidate:',
        batchSeen,
        'Finish when enough for a short report.',
      ].filter(Boolean).join('\n');
      promptCache.investigate = recordPromptCache({
        profile: isLive ? 'reactor_investigate' : 'reactor_shadow_investigate',
        messages: [
          { role: 'system', content: investigateSystem },
          { role: 'user', content: investigateUser },
        ],
        stablePrefix: investigateSystem,
        dynamicPayload: investigateUser,
        logger,
      });
      investigateResult = await runInvestigationLoop({
        aiClient,
        tools,
        systemPrompt: investigateSystem,
        initialUserPrompt: investigateUser,
        budget,
        logger,
        emitEvent: emitReaction,
      });
      patchBatchCheckpoint(dataRoot, batchId, {
        stage: 'investigate',
        investigation,
        investigation_result: {
          turns: investigateResult.turns ?? 0,
          readonlyCalls: investigateResult.readonlyCalls ?? 0,
        },
      });
      promptCache.investigate.usage = investigateResult?.usage_totals ?? null;
      const investigateUsageLog = formatLlmUsageSummary(
        promptCache.investigate.usage,
        'prompt-cache reactor_investigate',
      );
      if (investigateUsageLog) logger?.info?.(investigateUsageLog);
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

    let reportPath = existingCheckpoint?.report_path || null;
    let reportMarkdown = existingCheckpoint?.report_markdown || null;
    let persistedReport = existingCheckpoint?.report_index ? { indexRecord: existingCheckpoint.report_index, mdPath: reportPath, source: existingCheckpoint.report_source } : null;
    let reportSource = existingCheckpoint?.report_source || 'fallback';
    let reportReason = existingCheckpoint?.report_reason || null;
    const reuseReport = Boolean(reportPath && existsSync(reportPath));

    if (reuseReport) {
      try {
        reportMarkdown = readFileSync(reportPath, 'utf-8');
      } catch {
        reportMarkdown = existingCheckpoint?.report_markdown || reportMarkdown;
      }
      logger?.info?.(`[${logLabel}] resume report batch=${batchId} path=${reportPath}`);
    } else {
      logger?.info?.(`[${logLabel}] report batch=${batchId}`);
      const reportPrompt = buildReportPrompt({
        batchId,
        hostSeenBody,
        investigationDigest: investigation,
        language,
        live: isLive,
        candidate,
      });
      const reportSystem = 'You draft intelligence reports. Host owns Seen.';
      const reportMessages = [
        { role: 'system', content: reportSystem },
        { role: 'user', content: reportPrompt.content },
      ];
      promptCache.report = recordPromptCache({
        profile: isLive ? 'reactor_report' : 'reactor_shadow_report',
        messages: reportMessages,
        stablePrefix: `${reportSystem}\n\n--- stable turn ---\n\n${reportPrompt.stablePrefix}`,
        dynamicPayload: reportPrompt.dynamicPayload,
        logger,
      });
      let rawReportMarkdown = null;
      try {
        const reportResult = await chatMessagesDetailed(aiClient, reportMessages, {
          thinking: 'off',
          timeout: 180,
          phase: 'report',
        });
        promptCache.report.usage = summarizeLlmUsage(reportResult?.usage);
        const reportUsageLog = formatLlmUsageSummary(promptCache.report.usage, 'prompt-cache reactor_report');
        if (reportUsageLog) logger?.info?.(reportUsageLog);
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

      if (isLive) {
        assertCommitLease();
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
          producer: 'cognitive',
          activation_targets: [],
          producer_batch_id: batchId,
          reaction_id: reactionCycleId,
        });
        reportPath = persistedReport.mdPath;
        reportMarkdown = persistedReport.markdown;
        patchBatchCheckpoint(dataRoot, batchId, {
          report_path: reportPath,
          report_source: reportSource,
          report_reason: reportReason,
          report_index: persistedReport?.indexRecord ?? null,
        });
      } else {
        reportMarkdown = splicedMarkdown;
        reportPath = writeShadowReport(dataRoot, batchId, reportMarkdown);
        patchBatchCheckpoint(dataRoot, batchId, {
          report_path: reportPath,
          report_source: reportSource,
          report_reason: reportReason,
        });
      }
    }

    let honestyStatus = existingCheckpoint?.honesty?.status || 'ok';
    let honestyFindingsCount = existingCheckpoint?.honesty?.findings_count || 0;
    const honestyEventType = isLive ? 'reactor_report_honesty' : 'shadow_report_honesty';
    const honestyAlreadyRecorded = Boolean(existingCheckpoint?.honesty)
      || hasHonestyEvent({
        store,
        dataRoot,
        batchId,
        eventType: honestyEventType,
        isLive,
      });
    if (!honestyAlreadyRecorded) {
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
    }

    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'report',
      report_path: reportPath,
      report_source: reportSource,
      report_reason: reportReason,
      report_index: persistedReport?.indexRecord ?? existingCheckpoint?.report_index ?? null,
      honesty: { status: honestyStatus, findings_count: honestyFindingsCount },
    });
    const reuseDecide = checkpointStageReached(existingCheckpoint, 'decide')
      && Array.isArray(existingCheckpoint?.queued_decision_ids);
    let rawDecision = null;
    if (!reuseDecide) {
    logger?.info?.(`[${logLabel}] decide batch=${batchId}`);
    let ruleFeedbackText = '';
    let decisionBacklogText = '';
    try {
      decisionBacklogText = formatDecisionBacklogForPrompt(
        decisionBacklog,
      );
      const goalsPath = join(runtime.runtimeRoot, 'data', 'goals', 'active_goals.json');
      const activeGoals = existsSync(goalsPath)
        ? JSON.parse(readFileSync(goalsPath, 'utf-8'))
        : null;
      if (activeGoals) {
        const ruleFeedbackStats = computeRuleFeedbackStats({
          store,
          activeGoals,
          carryoverDoc: readCarryoverDocument(runtime.runtimeRoot),
          mechanicalGuards: loadEnabledGuards(ctx.projectRoot, subject),
        });
        ruleFeedbackText = formatRuleFeedbackForPrompt(ruleFeedbackStats);
      }
    } catch {
      // Rule-feedback injection is best-effort.
    }
    const decidePrompt = buildDecidePrompt({
      batchId,
      reportMarkdown,
      live: isLive,
      actionRegistry: cfg.actionRegistry,
      ruleFeedbackText,
      decisionBacklogText,
      decisionConstraints: beliefDecisionContext,
      candidate,
    });
    const decideSystem = 'Return JSON decisions only.';
    const decideMessages = [
      { role: 'system', content: decideSystem },
      { role: 'user', content: decidePrompt.content },
    ];
    promptCache.decide = recordPromptCache({
      profile: isLive ? 'reactor_decide' : 'reactor_shadow_decide',
      messages: decideMessages,
      stablePrefix: `${decideSystem}\n\n--- stable turn ---\n\n${decidePrompt.stablePrefix}`,
      dynamicPayload: decidePrompt.dynamicPayload,
      logger,
    });
    try {
      const decideResult = await chatMessagesDetailed(aiClient, decideMessages, {
        thinking: 'off',
        timeout: 180,
        phase: 'decide',
      });
      rawDecision = decideResult?.text ?? null;
      promptCache.decide.usage = summarizeLlmUsage(decideResult?.usage);
      const decideUsageLog = formatLlmUsageSummary(promptCache.decide.usage, 'prompt-cache reactor_decide');
      if (decideUsageLog) logger?.info?.(decideUsageLog);
    } catch (e) {
      logger?.warning?.(`[${logLabel}] decide failed: ${e?.message || e}`);
    }
    }
    let parsed = { analysis: existingCheckpoint?.analysis || { actions: [] } };
    let queuedActions = existingCheckpoint?.queued_actions || [];
    let queuedIds = existingCheckpoint?.queued_decision_ids || [];
    let skippedCount = existingCheckpoint?.decisions_skipped ?? 0;

    if (reuseDecide) {
      logger?.info?.(`[${logLabel}] resume decide batch=${batchId} queued=${queuedIds.length}`);
    } else {
      parsed = await parseAnalyzeDecisionWithRepair(aiClient, rawDecision || '{}', { logger });
      const actions = parsed.analysis?.actions || [];
      queuedActions = actions;
      queuedIds = [];
      skippedCount = 0;

      if (isLive) {
        assertCommitLease();
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
          batchId,
          beliefDecisionContext,
        });
        queuedActions = queuedResult.actions;
        queuedIds = queuedResult.decisions_queued;
        skippedCount = queuedResult.decisions_skipped?.length ?? 0;
        logger?.info?.(`[${logLabel}] queued=${queuedIds.length} skipped=${skippedCount}`);
      } else {
        const validActions = [];
        let beliefSkipped = 0;
        const bootstrapBeliefIds = new Set();
        for (const action of actions) {
          const validation = validateQueuedAction(action, {
            beliefDecisionContext: {
              ...beliefDecisionContext,
              bootstrap_belief_ids: bootstrapBeliefIds,
            },
          });
          if (validation.valid) {
            validActions.push(action);
            const beliefContext = extractBeliefContext(action);
            if (
              beliefContext.belief_relation === 'create_belief'
              && beliefContext.belief_id
            ) {
              bootstrapBeliefIds.add(beliefContext.belief_id);
            }
          } else {
            beliefSkipped += 1;
          }
        }
        const shadowResult = appendShadowDecisions(dataRoot, {
          batchId,
          subject,
          actions: validActions,
          analysis: parsed.analysis,
          reactionId: reactionCycleId,
          producerBatchId: batchId,
        });
        queuedActions = shadowResult.decisions;
        skippedCount = beliefSkipped + (shadowResult.skipped?.length ?? 0);
        logger?.info?.(`[${logLabel}] shadow queued=${queuedActions.length} skipped=${skippedCount}`);
      }
      patchBatchCheckpoint(dataRoot, batchId, {
        stage: 'decide',
        queued_decision_ids: queuedIds,
        analysis: parsed.analysis,
        decisions_skipped: skippedCount,
      });
    }

    assertCommitLease();
    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'committed',
      queued_decision_ids: queuedIds,
      analysis: parsed.analysis,
      honesty: { status: honestyStatus, findings_count: honestyFindingsCount },
    });
    ackBatchHandled(dataRoot, batchId);
    const elapsedMs = Date.now() - startedAt;
    promptCache.totals = accumulateLlmUsage([
      promptCache.investigate?.usage,
      promptCache.report?.usage,
      promptCache.decide?.usage,
    ]);
    const totalsLog = formatLlmUsageSummary(promptCache.totals, 'prompt-cache reactor');
    if (totalsLog) logger?.info?.(totalsLog);
    if (isLive) {
      store.recordEvolutionEvent({
        type: 'reactor_pipeline',
        status: reportSource === 'ai' ? 'ok' : 'forced',
        cycle_id: reactionCycleId,
        subject,
        batch_id: batchId,
        producer: 'cognitive',
        activation_targets: [],
        producer_batch_id: batchId,
        reaction_id: reactionCycleId,
        claimed_events: events.length,
        decisions_queued: queuedIds.length,
        decisions_skipped: skippedCount,
        investigate_turns: investigateResult.turns ?? 0,
        honesty_status: honestyStatus,
        report_source: persistedReport?.source ?? reportSource,
        duration_ms: elapsedMs,
        prompt_cache: promptCache.totals,
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
      handled: true,
      ok: true,
      llm_skipped: false,
      activation_effect: 'handle',
      mode,
      batch_id: batchId,
      cycle_id: reactionCycleId,
      reaction_id: reactionCycleId,
      candidate,
      event_ids: events.map((item) => item.id),
      evidence_keys: events.map((item) => envelopeEvidenceKey(item)),
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
      prompt_cache: promptCache,
    };
  } catch (err) {
    const message = err?.message || String(err);
    nackBatchFailed(dataRoot, batchId, { error: message });
    patchBatchCheckpoint(dataRoot, batchId, {
      stage: 'failed',
      last_error: message,
    });
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
