import { chatMessagesJson } from '../ai/messages.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { normalizeSpeechIntent, speechIntentFromDeterministic } from './speech-intent.mjs';
import {
  candidateEligibleForDeterministicAgent,
  candidateNeedsImmediateAction,
} from './classifier-understanding.mjs';

export const PRESENCE_PLAN_KINDS = Object.freeze(['no_op', 'speak', 'silence', 'act']);
export const PRESENCE_ACTION_TYPES = Object.freeze([
  'speech_intent',
  'start_agent_async',
  'write_operator_brief',
  'record_observation',
  'silence',
]);

function noOpPlan(reason, extra = {}) {
  return {
    kind: 'no_op',
    reason,
    candidate_ids: [],
    intents: [],
    actions: [],
    planner: 'deterministic',
    ...extra,
  };
}

function sanitizeLlmText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/approval_granted|已授权发布|直接发布|已经发布|已完成发布/i.test(text)) return null;
  if (/(sk-[a-z0-9]{16,}|api[_-]?key|app[_-]?secret|token\s*[:=])/i.test(text)) return null;
  return text.slice(0, 1600);
}

function normalizeStartAgentAsync(raw) {
  const objective = sanitizeLlmText(raw.objective ?? raw.summary);
  if (!objective) return null;
  const mode = ['observe', 'propose'].includes(raw.mode) ? raw.mode : 'observe';
  const permissionProfile = ['read_only'].includes(raw.permission_profile) ? raw.permission_profile : 'read_only';
  const boundary = raw.boundary && typeof raw.boundary === 'object' && !Array.isArray(raw.boundary)
    ? raw.boundary
    : {};
  const cwd = raw.cwd ?? raw.execution_root ?? raw.executionRoot ?? boundary.cwd ?? null;
  return {
    type: 'start_agent_async',
    objective,
    mode,
    permission_profile: permissionProfile,
    boundary: {
      ...boundary,
      write_allowed: false,
      approval_granted: false,
    },
    cwd: cwd ? String(cwd).trim() : null,
    acceptance: sanitizeLlmText(raw.acceptance)
      ?? 'Return a concise JSON receipt with status, summary, evidence, verification_hints, and next_actions. Do not mutate files or perform remote writes.',
    candidate_id: raw.candidate_id ?? null,
    target: raw.target ?? 'channel_default',
    reply_to_message_id: raw.reply_to_message_id ?? null,
    signal_key: raw.signal_key ?? null,
    reason: String(raw.reason ?? 'presence_agent_requested'),
    reason_summary: String(raw.reason_summary ?? raw.reason ?? 'agent requested from channel presence').slice(0, 500),
    idempotency_key: raw.idempotency_key ?? null,
    source_refs: Array.isArray(raw.source_refs) ? raw.source_refs.filter(Boolean).map(String) : [],
  };
}

function normalizeAction(raw, subject) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? '').trim();
  if (type === 'silence') {
    return { type: 'silence', reason: String(raw.reason ?? 'silence') };
  }
  if (type === 'speech_intent') {
    return normalizeSpeechIntent(raw, subject);
  }
  if (type === 'send_message') {
    const text = sanitizeLlmText(raw.text);
    if (!text) return null;
    return normalizeSpeechIntent({
      type: 'speech_intent',
      candidate_id: raw.candidate_id ?? null,
      target: raw.target ?? 'channel_default',
      reason: String(raw.reason ?? 'presence_reply'),
      reply_to_message_id: raw.reply_to_message_id ?? null,
      signal_key: raw.signal_key ?? null,
      idempotency_key: raw.idempotency_key ?? null,
      content_requirements: { kind: 'custom', text_hint: text },
    }, subject);
  }
  if (!PRESENCE_ACTION_TYPES.includes(type)) return null;
  if (type === 'start_agent_async') {
    return normalizeStartAgentAsync(raw);
  }
  if (type === 'write_operator_brief') {
    const summary = String(raw.summary ?? '').trim();
    if (!summary) return null;
    const kind = ['approval_request', 'verification_request'].includes(raw.kind) ? raw.kind : 'verification_request';
    return {
      type: 'write_operator_brief',
      kind,
      scope: raw.scope ?? 'next_cycle',
      summary,
      priority: raw.priority ?? 'medium',
      reply_to_message_id: raw.reply_to_message_id ?? null,
    };
  }
  if (type === 'record_observation') {
    const content = String(raw.content ?? raw.summary ?? '').trim();
    if (!content) return null;
    return {
      type: 'record_observation',
      content,
      confidence: raw.confidence ?? 'medium',
    };
  }
  return null;
}

function candidates(context) {
  return context.expression?.candidates ?? [];
}

function isOpenMessageCandidate(candidate) {
  return candidate?.kind === 'reply.message';
}

function openMessageCandidates(context) {
  return candidates(context).filter(isOpenMessageCandidate);
}

function silencePlanForOpenMessages(context, reason, { planner = 'deterministic', extra = {} } = {}) {
  const selected = openMessageCandidates(context).slice(0, context.presence?.max_actions_per_tick ?? 2);
  if (!selected.length) return null;
  return {
    kind: 'silence',
    reason,
    candidate_ids: selected.map((candidate) => candidate.id),
    intents: [],
    actions: [{ type: 'silence', reason }],
    planner,
    ...extra,
  };
}

function intentFromCandidate(context, candidate) {
  const contentRequirements = candidate.kind === 'reply.control_action'
    ? {
      kind: 'control_action_ack',
      summary: candidate.control_result ?? candidate.summary,
      action_id: candidate.control_result?.action_id ?? null,
    }
    : candidate.kind === 'reply.agent_run'
      ? {
        kind: 'agent_run_result',
        summary: {
          agent_result: candidate.agent_result,
          summary: candidate.summary,
        },
      }
    : {
      kind: candidate.recommended_intent,
      summary: candidate.summary,
      signal: candidate.signal ?? null,
    };
  return speechIntentFromDeterministic({
    subject: context.subject,
    candidate_id: candidate.id,
    target: candidate.target,
    reason: candidate.recommended_intent,
    reply_to_message_id: candidate.reply_to_message_id ?? null,
    signal_key: candidate.signal_key ?? null,
    idempotency_key: `expression:${candidate.id}`,
    kind: contentRequirements.kind,
    summary: contentRequirements.summary,
    signal: candidate.signal ?? null,
  });
}

function speakPlan(context, selected, { planner = 'deterministic', reason = 'deterministic_express', extra = {} } = {}) {
  const intents = selected.map((candidate) => intentFromCandidate(context, candidate)).filter(Boolean);
  if (!intents.length) return noOpPlan('no_valid_intents', { planner, ...extra });
  return {
    kind: 'speak',
    reason,
    candidate_ids: selected.map((candidate) => candidate.id),
    intents,
    actions: intents,
    planner,
    ...extra,
  };
}

export function planPresenceControlActionFastAck(context) {
  const selected = candidates(context).filter((candidate) => candidate.kind === 'reply.control_action');
  if (!selected.length) return null;
  return speakPlan(context, selected.slice(0, context.presence?.max_actions_per_tick ?? 2), {
    planner: 'deterministic_control_ack',
    reason: 'control_action_fast_ack',
    extra: { fast_ack: true },
  });
}

/**
 * Fast deterministic ack for approval / verification candidates.
 */
export function planPresenceOperatorBriefFastAck(context) {
  if (context.presence?.fast_ack_operator_brief === false) return null;
  const selected = candidates(context).filter((candidate) =>
    candidate.kind === 'reply.approval_request' || candidate.kind === 'reply.verification_request');
  if (!selected.length) return null;
  if (selected.some((candidate) => candidateNeedsImmediateAction(candidate))) {
    return null;
  }
  return speakPlan(context, selected.slice(0, context.presence?.max_actions_per_tick ?? 2), {
    planner: 'deterministic_fast_ack',
    reason: 'operator_brief_fast_ack',
    extra: { fast_ack: true },
  });
}

function agentAsyncActionFromCandidate(candidate, subject) {
  const u = candidate.understanding;
  const objective = String(u?.action_hint ?? u?.user_intent ?? candidate.summary ?? '').trim();
  if (!objective) return null;
  return normalizeStartAgentAsync({
    type: 'start_agent_async',
    objective,
    mode: 'observe',
    permission_profile: 'read_only',
    candidate_id: candidate.id,
    target: candidate.target ?? 'channel_default',
    reply_to_message_id: candidate.reply_to_message_id ?? null,
    reason: 'deterministic_understanding_agent',
    reason_summary: `Read-only investigation: ${objective.slice(0, 200)}`,
    idempotency_key: `expression:${candidate.id}`,
  });
}

function agentStartedAckIntent(context, candidate) {
  return speechIntentFromDeterministic({
    subject: context.subject,
    candidate_id: candidate.id,
    target: candidate.target ?? 'channel_default',
    reason: 'agent_started_ack',
    reply_to_message_id: candidate.reply_to_message_id ?? null,
    idempotency_key: `expression:${candidate.id}`,
    kind: 'custom',
    summary: '已收到，正在异步调查，完成后会通知你。',
  });
}

/**
 * Rule-based expression deliberation.
 */
export function planPresenceDeterministic(context) {
  const maxActions = context.presence?.max_actions_per_tick ?? 2;
  const all = candidates(context);
  const agentCandidates = all.filter(candidateEligibleForDeterministicAgent).slice(0, maxActions);
  if (agentCandidates.length) {
    const actions = [];
    for (const candidate of agentCandidates) {
      const agentAction = agentAsyncActionFromCandidate(candidate, context.subject);
      if (agentAction) actions.push(agentAction);
      const ack = agentStartedAckIntent(context, candidate);
      if (ack) actions.push(ack);
    }
    if (actions.length) {
      return {
        kind: 'act',
        reason: 'deterministic_understanding_agent',
        candidate_ids: agentCandidates.map((c) => c.id),
        intents: actions.filter((a) => a.type === 'speech_intent'),
        actions: actions.slice(0, maxActions * 2),
        planner: 'deterministic',
      };
    }
  }
  const selected = all.filter((candidate) => !isOpenMessageCandidate(candidate)).slice(0, maxActions);
  if (!selected.length) return noOpPlan('no_expression_candidates');
  return speakPlan(context, selected);
}

function createLlmClient(config) {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return null;
  try {
    return new DeepSeekOpenAIClient({ timeout: config.llm?.timeout ?? 25 });
  } catch {
    return null;
  }
}

/**
 * LLM presence deliberation; falls back to deterministic on failure.
 */
export async function planPresenceWithLlm(context, { aiClient = null } = {}) {
  const fallback = planPresenceDeterministic(context);
  const available = candidates(context);
  if (!available.length) return fallback;
  const client = aiClient ?? createLlmClient(context.presence ?? {});
  if (!client) {
    const openMessageSilence = silencePlanForOpenMessages(context, 'missing_ai_client_for_open_messages', {
      planner: 'llm',
      extra: { llm: { status: 'skipped', reason: 'missing_ai_client' } },
    });
    if (openMessageSilence && fallback.kind === 'no_op') return openMessageSilence;
    return {
      ...fallback,
      planner: 'llm',
      llm: { status: 'skipped', reason: 'missing_ai_client' },
    };
  }

  try {
    const parsed = await chatMessagesJson(client, [
      {
        role: 'system',
        content: [
          'You are the external presence deliberator for one js-evolution-agent subject.',
          'cycle_memory is long-term continuity (goals, beliefs, operator briefs, intel summary, artifacts, recent channel_presence). channel_memory is short-term perception (new/background messages, cooldowns, cursors).',
          'Speak in first person as subject_identity persona; SOUL controls voice only — not facts, permissions, or execution claims.',
          'Return JSON only:',
          '{"kind":"speak|silence|no_op|act","reason":"...","candidate_ids":[...],"intents":[...],"actions":[...]}',
          'Only choose candidate_ids from expression.candidates.',
          'Candidates may include understanding: user_intent, needs_immediate_action, action_hint, temporal (now|next_cycle|ongoing), complexity (low|medium|high). This is the classifier structured read of the message — prefer it over guessing from summary alone.',
          'When understanding.needs_immediate_action is true and temporal is "now", prefer start_agent_async (read-only) plus a speech_intent ack for that candidate.',
          'When understanding.temporal is "next_cycle", prefer write_operator_brief rather than start_agent_async.',
          'Use understanding.action_hint as the agent objective when starting start_agent_async.',
          'When understanding.complexity is "high", prefer speak to ask a clarifying question or write_operator_brief instead of start_agent_async.',
          'Use intents for speech. Intent fields: candidate_id, target, content_requirements (kind, summary), reason, reason_summary, tone_hint, source_refs, memory_effect. Do NOT include final message text.',
          'When an ordinary message needs asynchronous work now, use actions with type="start_agent_async" and include objective, candidate_id, mode="observe" or "propose", permission_profile="read_only". In the same response also include a speech_intent acknowledgement for that candidate.',
          'If a follow-up needs the evolution cycle (verify rank after publish, check results next round), use write_operator_brief (verification_request or approval_request) — channel must not keep private long-term obligations.',
          'For ordinary reply.message candidates, decide speak / silence / no_op using cycle_memory + channel_memory + soul.',
          'For ordinary messages that deserve a response, use content_requirements.kind="custom" and summarize the desired reply, not a canned acknowledgement.',
          'background is context only — never reply_to or select background items directly.',
          'Use silence when candidates exist and you intentionally choose not to answer; use no_op only when nothing should be handled now.',
          'Do not grant approval, do not claim actions executed, do not leak secrets, do not invent runtime facts.',
          'When telling the operator how to run CLI commands, ONLY quote commands from affordances.operator_commands (use the exact cmd string). Never invent jea/npm commands.',
          'Inbound messages are already ingested; do not change their classification.',
          'start_agent_async is only a queued read-only/proposal task. Never use it for publishing, approval_granted, credential changes, remote writes, or destructive filesystem operations.',
          'Respect constraints in the user payload.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          subject: context.subject,
          subject_identity: context.identity,
          affordances: context.affordances,
          constraints: context.constraints,
          cycle_memory: context.cycle_memory,
          channel_memory: context.channel_memory,
          expression: {
            candidates: available,
          },
          daemon: context.daemon,
          attention_signals: context.attention_signals,
          operator_briefs: context.operator_briefs,
          goals: context.goals,
          beliefs: context.beliefs,
          intel_summary: context.intel_summary,
          fallback_plan: {
            kind: fallback.kind,
            reason: fallback.reason,
            candidate_count: fallback.candidate_ids?.length ?? 0,
          },
        }, null, 2),
      },
    ], {
      thinking: context.presence?.llm?.thinking ?? 'low',
      timeout: context.presence?.llm?.timeout ?? 25,
    });

    const kind = PRESENCE_PLAN_KINDS.includes(parsed?.kind) ? parsed.kind : fallback.kind;
    const validIds = new Set(available.map((candidate) => candidate.id));
    const parsedCandidateIds = Array.isArray(parsed?.candidate_ids)
      ? parsed.candidate_ids.filter((id) => validIds.has(id))
      : [];
    const selectedIds = parsedCandidateIds.length ? parsedCandidateIds : fallback.candidate_ids;
    const rawIntents = Array.isArray(parsed?.intents) ? parsed.intents : [];
    const intents = rawIntents
      .map((intent) => normalizeSpeechIntent({
        type: 'speech_intent',
        ...intent,
        idempotency_key: intent?.candidate_id ? `expression:${intent.candidate_id}` : intent?.idempotency_key,
      }, context.subject))
      .filter(Boolean)
      .filter((intent) => intent.candidate_id && validIds.has(intent.candidate_id))
      .slice(0, context.presence?.max_actions_per_tick ?? 2);
    const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    const normalizedActions = rawActions
      .map((action) => normalizeAction(action, context.subject))
      .filter(Boolean);
    const actionIntents = normalizedActions
      .filter((action) => action.type === 'speech_intent')
      .filter((intent) => intent.candidate_id && validIds.has(intent.candidate_id));
    const sideActions = normalizedActions
      .filter((action) => action.type !== 'speech_intent')
      .filter((action) => !action.candidate_id || validIds.has(action.candidate_id));
    const mergedIntents = [...intents, ...actionIntents]
      .filter((intent, index, list) =>
        list.findIndex((other) => other.candidate_id === intent.candidate_id) === index)
      .slice(0, context.presence?.max_actions_per_tick ?? 2);
    const executableActions = [...mergedIntents, ...sideActions]
      .slice(0, context.presence?.max_actions_per_tick ?? 2);

    if (kind === 'no_op') {
      return {
        kind: 'no_op',
        reason: parsed?.reason ?? 'llm_no_op',
        candidate_ids: [],
        intents: [],
        actions: [],
        planner: 'llm',
        llm: { status: 'used', kind, action_count: 0 },
      };
    }

    if (kind === 'silence') {
      return {
        kind: 'silence',
        reason: parsed?.reason ?? 'llm_chose_silence',
        candidate_ids: selectedIds,
        intents: [],
        actions: [{ type: 'silence', reason: parsed?.reason ?? 'llm_silence' }],
        planner: 'llm',
        llm: { status: 'used', kind, action_count: 0 },
      };
    }

    if (!mergedIntents.length && sideActions.length) {
      return {
        kind: 'act',
        reason: String(parsed?.reason ?? 'llm_presence_action'),
        candidate_ids: selectedIds,
        intents: [],
        actions: executableActions,
        planner: 'llm',
        llm: { status: 'used', kind: 'act', action_count: executableActions.length },
      };
    }

    if (!mergedIntents.length) {
      const openMessageSilence = silencePlanForOpenMessages(context, 'no_valid_llm_intents_for_open_messages', {
        planner: 'llm',
        extra: { llm: { status: 'used', reason: 'no_valid_llm_intents' } },
      });
      if (openMessageSilence && fallback.kind === 'no_op') return openMessageSilence;
      return { ...fallback, planner: 'llm', llm: { status: 'used', reason: 'no_valid_llm_intents' } };
    }

    return {
      kind: 'speak',
      reason: String(parsed?.reason ?? 'llm_presence'),
      candidate_ids: mergedIntents.map((intent) => intent.candidate_id),
      intents: mergedIntents,
      actions: executableActions,
      planner: 'llm',
      llm: { status: 'used', kind, action_count: executableActions.length },
    };
  } catch (err) {
    const openMessageSilence = silencePlanForOpenMessages(context, 'llm_error_for_open_messages', {
      planner: 'llm',
      extra: { llm: { status: 'skipped', reason: err?.message || String(err) } },
    });
    if (openMessageSilence && fallback.kind === 'no_op') return openMessageSilence;
    return {
      ...fallback,
      planner: 'llm',
      llm: { status: 'skipped', reason: err?.message || String(err) },
    };
  }
}

export async function planPresence(context, { aiClient = null, skipFastAck = false } = {}) {
  if (context.presence?.planner === 'llm') {
    if (!skipFastAck) {
      const controlAck = planPresenceControlActionFastAck(context);
      if (controlAck) return controlAck;
      const fastAck = planPresenceOperatorBriefFastAck(context);
      if (fastAck) return fastAck;
    }
    return planPresenceWithLlm(context, { aiClient });
  }
  const controlAck = planPresenceControlActionFastAck(context);
  if (controlAck) return controlAck;
  return planPresenceDeterministic(context);
}

/** Deterministic plan used when LLM decision times out or is unavailable. */
export function planPresenceDecisionFallback(context) {
  const openMessageSilence = silencePlanForOpenMessages(context, 'decision_timeout_for_open_messages', {
    planner: 'deterministic_fallback',
    extra: { decision_fallback: true },
  });
  if (openMessageSilence && planPresenceDeterministic(context).kind === 'no_op') return openMessageSilence;
  return {
    ...planPresenceDeterministic(context),
    planner: 'deterministic_fallback',
    decision_fallback: true,
  };
}
