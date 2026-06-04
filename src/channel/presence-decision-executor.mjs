import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { writePendingOperatorBrief } from '../intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { enqueueCycleStartRequestWithEvent } from '../cli/utils/cycle-dispatch.mjs';
import { recordChannelEvent, readChannelEvents } from './audit.mjs';
import { enqueueChannelTask } from './task-queue.mjs';
import {
  cooldownActive,
  writePresenceState,
  markExpressionCandidatesHandled,
} from './state.mjs';
import { CHANNEL_TASK_DEFAULT_PRIORITY, nowIso } from './types.mjs';
import { PRESENCE_ACTION_TYPES } from './presence-planner.mjs';
import {
  recordPresenceInteraction,
  shouldRecordSilenceObservation,
  formatPresenceInteractionContent,
} from './presence-memory.mjs';
import { appendChannelEvent } from './event-queue.mjs';
import { deliveredAgentRunCandidateIds } from './expression-candidates.mjs';
import { buildSpeechGenerationEventPayload, speechIntentFromDeterministic } from './speech-intent.mjs';
import { enqueueSpeechGenerationIfPending } from './wake.mjs';

export function createIntelligenceStoreForSubject(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

function recentSpeechIntentCount(root, subject, { windowMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  return readChannelEvents(root, subject, { limit: 500 }).filter((event) => {
    if (event.type !== 'channel_speech_generated') return false;
    const recorded = Date.parse(event.recorded_at ?? '');
    return Number.isFinite(recorded) && nowMs - recorded <= windowMs;
  }).length;
}

function validateStartAgentAsync(action) {
  if (!String(action.objective ?? '').trim()) return { ok: false, reason: 'missing_objective' };
  if (!['observe', 'propose'].includes(action.mode)) return { ok: false, reason: 'unsupported_agent_mode' };
  if ((action.permission_profile ?? 'read_only') !== 'read_only') {
    return { ok: false, reason: 'unsupported_permission_profile' };
  }
  if (action.approval_granted || action.approved || action.boundary?.approval_granted) {
    return { ok: false, reason: 'approval_granted_not_allowed' };
  }
  return { ok: true };
}

function validateAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, reason: 'invalid_action' };
  if (!PRESENCE_ACTION_TYPES.includes(action.type)) return { ok: false, reason: 'unsupported_action_type' };
  if (action.type === 'speech_intent') {
    if (!action.content_requirements) return { ok: false, reason: 'missing_content_requirements' };
  }
  if (action.type === 'start_agent_async') {
    return validateStartAgentAsync(action);
  }
  return { ok: true };
}

function interactionContentForAction(action, plan) {
  if (action.type === 'speech_intent') {
    return formatPresenceInteractionContent('speech_intent', {
      why: action.reason,
      reason_summary: action.reason_summary ?? action.reason,
      summary: action.content_requirements?.summary ?? action.content_requirements?.kind,
      candidate_id: action.candidate_id,
      planner: plan?.planner,
    });
  }
  if (action.type === 'start_agent_async') {
    return formatPresenceInteractionContent('start_agent_async', {
      why: action.reason,
      reason_summary: action.reason_summary ?? action.reason,
      summary: action.objective,
      candidate_id: action.candidate_id,
      planner: plan?.planner,
    });
  }
  if (action.type === 'write_operator_brief') {
    return formatPresenceInteractionContent('write_operator_brief', {
      why: 'follow_up_needs_cycle_loop',
      brief_kind: action.kind ?? 'verification_request',
      summary: action.summary,
      planner: plan?.planner,
    });
  }
  if (plan?.kind === 'silence') {
    return formatPresenceInteractionContent('silence', {
      why: plan.reason ?? 'silence',
      candidate_id: (plan.candidate_ids ?? [])[0] ?? null,
      planner: plan?.planner,
    });
  }
  return null;
}

function applyExpressionCursors(root, subject, plan, outcome, extra = {}) {
  const candidateIds = [...new Set(plan?.candidate_ids ?? [])].filter(Boolean);
  const meta = { outcome, reason: plan.reason, planner: plan.planner };
  if (candidateIds.length) markExpressionCandidatesHandled(root, subject, candidateIds, { ...meta, ...extra });
  const patch = { last_presence_tick_at: nowIso() };
  if (outcome === 'speech_queued' || outcome === 'speak' || outcome === 'sent') {
    patch.last_spoken_at = nowIso();
  }
  patch.last_plan = {
    kind: plan.kind,
    candidate_ids: candidateIds,
    reason: plan.reason,
    planner: plan.planner,
    at: nowIso(),
  };
  return writePresenceState(root, subject, patch);
}

function queueSpeechIntent(root, subject, store, plan, action, { dryRun = false, rateLimited = false } = {}) {
  const idempotencyKey = action.idempotency_key ?? `presence:speech:${action.intent_id}`;
  if (rateLimited) {
    return { queued: false, result: { action, skipped: true, reason: 'rate_limited' } };
  }
  if (cooldownActive(root, subject, idempotencyKey)) {
    return { queued: false, result: { action, skipped: true, reason: 'cooldown' } };
  }
  if (dryRun) {
    return { queued: false, result: { action, applied: false, dry_run: true } };
  }
  const payload = buildSpeechGenerationEventPayload(action, {
    contextSummary: {
      kind: plan.kind,
      planner: plan.planner,
    },
    planReason: plan.reason,
  });
  appendChannelEvent(root, subject, {
    type: 'speech_generation_requested',
    reason: action.reason,
    event_ref: action.intent_id,
    payload,
    payload_summary: {
      intent_id: action.intent_id,
      candidate_id: action.candidate_id ?? null,
      reason: action.reason,
      target: action.target,
    },
  });
  recordPresenceInteraction(store, {
    interaction_kind: 'speech_intent',
    content: interactionContentForAction(action, plan),
    confidence: 'medium',
    evidence_refs: [
      action.candidate_id ? `expression:${action.candidate_id}` : null,
    ].filter(Boolean),
  });
  return { queued: true, result: { action, applied: true, queued: true, intent_id: action.intent_id } };
}

function agentStartKey(action = {}) {
  return action.candidate_id ?? action.idempotency_key ?? action.channel_agent_run_id ?? action.objective ?? null;
}

function contentText(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? '');
  }
}

function speechClaimsAgentState(action = {}) {
  const req = action.content_requirements ?? {};
  const kind = String(req.kind ?? req.summary?.kind ?? '').trim();
  if (kind === 'agent_started_ack' || kind === 'agent_not_started_ack' || kind === 'agent_run_result') return true;
  const text = [
    kind,
    action.reason,
    action.reason_summary,
    action.tone_hint,
    contentText(req),
  ].join('\n');
  return /(已|已经|重新|重启|启动|开始|后台).{0,20}(agent|调研|任务)|cursor_sdk|provider.{0,12}(deferred|限制)|deferred|限制未能执行/i.test(text);
}

function speechHasAgentResultEvidence(action = {}) {
  const req = action.content_requirements ?? {};
  if (req.kind !== 'agent_run_result') return false;
  const result = req.summary?.agent_result ?? req.summary ?? null;
  return Boolean(result && typeof result === 'object' && result.channel_agent_run_id);
}

function agentNotStartedAckIntent(subject, action) {
  return speechIntentFromDeterministic({
    subject,
    candidate_id: action.candidate_id ?? null,
    target: action.target ?? 'channel_default',
    reason: 'agent_not_started_ack',
    reply_to_message_id: action.reply_to_message_id ?? null,
    signal_key: action.signal_key ?? null,
    idempotency_key: action.candidate_id
      ? `presence:agent_not_started_ack:${action.candidate_id}`
      : `presence:agent_not_started_ack:${action.idempotency_key ?? action.intent_id ?? action.reason}`,
    kind: 'agent_not_started_ack',
    summary: {
      kind: 'agent_not_started_ack',
      summary: '已收到调研请求，但尚未启动异步 agent。',
      requested_summary: action.content_requirements?.summary ?? null,
    },
    reason_summary: 'acknowledge agent request without claiming execution',
    tone_hint: 'brief, clear, no execution claim',
    source_refs: action.source_refs ?? [],
    memory_effect: 'record_agent_not_started_ack',
  });
}

function bindSpeechToAgentStart(subject, action, agentStarts) {
  if (!speechClaimsAgentState(action)) return action;
  if (speechHasAgentResultEvidence(action)) return action;
  const key = agentStartKey(action);
  const start = key ? agentStarts.get(key) : null;
  if (!start) return agentNotStartedAckIntent(subject, action);
  return speechIntentFromDeterministic({
    subject,
    candidate_id: action.candidate_id ?? null,
    target: action.target ?? 'channel_default',
    reason: 'agent_started_ack',
    reply_to_message_id: action.reply_to_message_id ?? null,
    signal_key: action.signal_key ?? null,
    idempotency_key: action.idempotency_key ?? (action.candidate_id
      ? `presence:agent_started_ack:${action.candidate_id}`
      : `presence:agent_started_ack:${start.channel_agent_run_id}`),
    kind: 'agent_started_ack',
    summary: {
      kind: 'agent_started_ack',
      summary: '已启动一个异步 agent 处理该请求；完成后会再通知结果。',
      objective: start.objective ?? action.content_requirements?.summary?.objective ?? null,
      channel_agent_run_id: start.channel_agent_run_id,
      task_id: start.task_id ?? null,
      queued: true,
      created: start.created ?? false,
    },
    reason_summary: action.reason_summary ?? 'acknowledge asynchronous agent start',
    tone_hint: 'brief, clear, no execution result claim',
    source_refs: [
      ...(action.source_refs ?? []),
      `channel_agent_run:${start.channel_agent_run_id}`,
    ],
    memory_effect: 'record_agent_started_ack',
  });
}

function agentStartedAckIntent(subject, action, start = {}) {
  return speechIntentFromDeterministic({
    subject,
    candidate_id: action.candidate_id ?? null,
    target: action.target ?? 'channel_default',
    reason: 'agent_started_ack',
    reply_to_message_id: action.reply_to_message_id ?? null,
    signal_key: action.signal_key ?? null,
    idempotency_key: action.candidate_id
      ? `presence:agent_started_ack:${action.candidate_id}`
      : `presence:agent_started_ack:${action.idempotency_key ?? action.objective}`,
    kind: 'agent_started_ack',
    summary: {
      kind: 'agent_started_ack',
      summary: '已启动一个异步 agent 处理该请求；完成后会再通知结果。',
      objective: action.objective,
      channel_agent_run_id: start.channel_agent_run_id ?? action.channel_agent_run_id ?? null,
      task_id: start.task_id ?? null,
      queued: true,
      created: start.created ?? false,
    },
    reason_summary: action.reason_summary ?? 'acknowledge asynchronous agent start',
    tone_hint: 'brief, clear, no execution result claim',
    source_refs: [
      ...(action.source_refs ?? []),
      start.channel_agent_run_id ? `channel_agent_run:${start.channel_agent_run_id}` : null,
    ].filter(Boolean),
    memory_effect: 'record_agent_started_ack',
  });
}

/**
 * Apply presence decision plan: queue speech intents, apply briefs/observations/silence.
 * Does NOT write outbox directly.
 */
export async function executePresenceDecisionPlan(root, subject, plan, {
  presenceConfig = null,
  dryRun = false,
  context = null,
} = {}) {
  const cfg = presenceConfig ?? plan.presence ?? context?.presence ?? {};
  const maxPerHour = cfg.max_messages_per_hour ?? 0;
  const results = [];
  const store = createIntelligenceStoreForSubject(root, subject);
  const runtime = runtimeForSubject(root, subject);

  recordChannelEvent(root, subject, {
    type: 'channel_expression_planned',
    status: 'ok',
    plan_kind: plan.kind,
    reason: plan.reason,
    planner: plan.planner ?? 'deterministic',
    candidate_count: plan.candidate_ids?.length ?? 0,
    intent_count: plan.intents?.length ?? 0,
    llm: plan.llm ?? null,
  });

  // Agent-run deliverables are dispatched to outbox by the agent runner.
  // Mark their candidates handled so the cursor advances without re-speaking.
  if (!dryRun && context) {
    const deliveredIds = deliveredAgentRunCandidateIds(context);
    if (deliveredIds.length) {
      markExpressionCandidatesHandled(root, subject, deliveredIds, {
        outcome: 'delivered',
        reason: 'channel_deliverable_dispatched',
      });
      recordChannelEvent(root, subject, {
        type: 'channel_deliverable_candidates_handled',
        status: 'ok',
        candidate_ids: deliveredIds,
      });
    }
  }

  if (plan.kind === 'no_op') {
    recordChannelEvent(root, subject, {
      type: 'channel_expression_noop',
      status: 'ok',
      reason: plan.reason,
    });
    if (!dryRun) applyExpressionCursors(root, subject, plan, 'no_op');
    return { applied: 0, skipped: 0, speech_queued: 0, results, plan };
  }

  if (plan.kind === 'silence') {
    recordChannelEvent(root, subject, {
      type: 'channel_expression_silenced',
      status: 'ok',
      reason: plan.reason,
      candidate_ids: plan.candidate_ids ?? [],
    });
    if (!dryRun && shouldRecordSilenceObservation(context, plan)) {
      recordPresenceInteraction(store, {
        interaction_kind: 'silence',
        content: interactionContentForAction({ type: 'silence' }, plan),
        confidence: 'medium',
        evidence_refs: (plan.candidate_ids ?? []).map((id) => `expression:${id}`),
        tags: ['silence'],
      });
    }
    if (!dryRun) {
      applyExpressionCursors(root, subject, plan, 'silenced');
    }
    return { applied: 0, skipped: 1, speech_queued: 0, results, plan };
  }

  const speechRateLimited = maxPerHour > 0 && recentSpeechIntentCount(root, subject) >= maxPerHour;
  if (speechRateLimited) {
    recordChannelEvent(root, subject, {
      type: 'channel_presence_skipped',
      status: 'ok',
      skip_reason: 'rate_limited',
      limit: maxPerHour,
    });
  }

  let speechQueued = 0;

  const plannedActions = plan.actions ?? plan.intents ?? [];
  const pendingSpeechActions = [];
  const successfulAgentStarts = new Map();
  const speechCandidateIds = new Set(plannedActions
    .filter((action) => action?.type === 'speech_intent' && action.candidate_id)
    .map((action) => action.candidate_id));

  for (const action of plannedActions) {
    const check = validateAction(action);
    if (!check.ok) {
      results.push({ action, skipped: true, reason: check.reason });
      continue;
    }

    if (action.type === 'silence') {
      results.push({ action, applied: false, reason: 'silence_action' });
      continue;
    }

    if (action.type === 'speech_intent') {
      pendingSpeechActions.push(action);
      continue;
    }

    if (action.type === 'start_agent_async') {
      const channelAgentRunId = action.channel_agent_run_id ?? `channel-agent-run-${randomUUID()}`;
      const idempotencyKey = action.idempotency_key
        ?? (action.candidate_id
          ? `channel-agent:${subject}:${action.candidate_id}`
          : `channel-agent:${subject}:${channelAgentRunId}`);
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true, channel_agent_run_id: channelAgentRunId });
        continue;
      }
      const queued = enqueueChannelTask(root, subject, {
        type: 'channel_agent_run',
        priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_agent_run,
        idempotencyKey,
        input: {
          request: {
            ...action,
            subject,
            channel_agent_run_id: channelAgentRunId,
            idempotency_key: idempotencyKey,
            source: 'channel_presence',
            planner: plan.planner ?? 'deterministic',
            plan_reason: plan.reason ?? null,
          },
        },
      });
      recordChannelEvent(root, subject, {
        type: 'channel_agent_run_requested',
        status: 'ok',
        channel_agent_run_id: channelAgentRunId,
        task_id: queued.task?.task_id ?? null,
        created: queued.created ?? false,
        candidate_id: action.candidate_id ?? null,
        reason: action.reason,
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'start_agent_async',
        channel_agent_run_id: channelAgentRunId,
        task_id: queued.task?.task_id ?? null,
        queued: true,
        created: queued.created ?? false,
      });
      recordPresenceInteraction(store, {
        interaction_kind: 'start_agent_async',
        content: interactionContentForAction(action, plan),
        confidence: 'medium',
        evidence_refs: [
          action.candidate_id ? `expression:${action.candidate_id}` : null,
          `channel_agent_run:${channelAgentRunId}`,
        ].filter(Boolean),
      });
      const startRecord = {
        channel_agent_run_id: channelAgentRunId,
        task_id: queued.task?.task_id ?? null,
        created: queued.created ?? false,
        candidate_id: action.candidate_id ?? null,
        idempotency_key: idempotencyKey,
        objective: action.objective,
      };
      for (const key of [
        action.candidate_id,
        action.idempotency_key,
        idempotencyKey,
        channelAgentRunId,
        action.objective,
      ].filter(Boolean)) {
        successfulAgentStarts.set(key, startRecord);
      }
      results.push({
        action,
        applied: true,
        queued: true,
        channel_agent_run_id: channelAgentRunId,
        task_id: queued.task?.task_id ?? null,
        created: queued.created ?? false,
      });
      if (!action.candidate_id || !speechCandidateIds.has(action.candidate_id)) {
        const ack = agentStartedAckIntent(subject, action, startRecord);
        const ackQueued = queueSpeechIntent(root, subject, store, plan, ack, { dryRun, rateLimited: speechRateLimited });
        if (ackQueued.queued) speechQueued += 1;
        results.push({
          ...ackQueued.result,
          generated_for_action: 'start_agent_async',
        });
      }
      continue;
    }

    if (action.type === 'write_operator_brief') {
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const { brief } = writePendingOperatorBrief(runtime.runtimeRoot, {
        kind: action.kind,
        scope: action.scope ?? 'next_cycle',
        summary: action.summary,
        priority: action.priority ?? 'medium',
        created_by: `channel:presence:${subject}`,
      });
      const cycleRequest = enqueueCycleStartRequestWithEvent(root, subject, {
        reason: 'channel_presence_operator_brief',
        meta: { brief_ids: [brief.id] },
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'write_operator_brief',
        brief_id: brief.id,
        cycle_request_id: cycleRequest.request?.request_id ?? null,
      });
      recordPresenceInteraction(store, {
        interaction_kind: 'write_operator_brief',
        content: interactionContentForAction(action, plan),
        confidence: 'medium',
        evidence_refs: [`brief:${brief.id}`],
      });
      results.push({ action, applied: true, brief_id: brief.id, cycle_start_request: cycleRequest.request });
      continue;
    }

    if (action.type === 'record_observation') {
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const written = recordPresenceInteraction(store, {
        interaction_kind: 'record_observation',
        content: action.content,
        confidence: action.confidence ?? 'medium',
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'record_observation',
        written: written.written,
      });
      results.push({ action, applied: true, written });
    }
  }

  for (const action of pendingSpeechActions) {
    const guardedAction = bindSpeechToAgentStart(subject, action, successfulAgentStarts);
    const queued = queueSpeechIntent(root, subject, store, plan, guardedAction, { dryRun, rateLimited: speechRateLimited });
    if (queued.queued) speechQueued += 1;
    results.push({
      ...queued.result,
      guarded_from_action: guardedAction === action ? null : action,
      guard_reason: guardedAction === action ? null : 'agent_state_claim_requires_audit_event',
    });
  }

  if (!dryRun) {
    const hadSpeech = results.some((r) => r.applied && r.action?.type === 'speech_intent');
    applyExpressionCursors(root, subject, plan, hadSpeech ? 'speech_queued' : 'acted');
    if (speechQueued) {
      enqueueSpeechGenerationIfPending(root, subject);
    }
  }

  return {
    applied: results.filter((r) => r.applied).length,
    skipped: results.filter((r) => r.skipped).length,
    speech_queued: speechQueued,
    results,
    plan,
  };
}
