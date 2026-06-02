import { chatMessagesJson } from '../ai/messages.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { nowIso } from './types.mjs';
import { buildPresenceSignalKey } from './state.mjs';

export const PRESENCE_STANCES = Object.freeze(['speak', 'silence', 'ask', 'report', 'wait']);
export const PRESENCE_ACTION_TYPES = Object.freeze([
  'send_message',
  'write_operator_brief',
  'record_observation',
  'silence',
]);

function buildPresenceTargets(context, { messageIds = [], signalKeys = [] } = {}) {
  const messages = messageIds.length
    ? messageIds
    : (context.channel?.new_messages ?? []).map((m) => m.message_id).filter(Boolean);
  const signals = signalKeys.length
    ? signalKeys
    : (context.attention_signals ?? [])
      .filter((s) => !s.presence_handled)
      .map((s) => s.presence_signal_key ?? buildPresenceSignalKey(s))
      .filter(Boolean);
  return { messages, signals };
}

function emptyPlan(reason, context, extra = {}) {
  return {
    stance: 'silence',
    reason,
    actions: [{ type: 'silence', reason }],
    presence_targets: buildPresenceTargets(context),
    planner: 'deterministic',
    ...extra,
  };
}

function ackText(subject, kind, summary) {
  if (kind === 'approval_request') {
    return [
      `${subject}: 已记录为下一轮审批意图。`,
      '不会直接发布或授权；需下一轮 Decide 显式产出 approval_granted。',
      summary ? `来源：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'verification_request') {
    return [
      `${subject}: 已记录为下一轮核实请求。`,
      summary ? `内容：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'operator_fact') {
    return [
      `${subject}: 已记录为高置信 operator fact。`,
      summary ? `内容：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  return `${subject}: 已收到并记录。`;
}

function signalText(subject, signal) {
  return [
    `${subject}: ${signal.title ?? 'Attention'}`,
    '',
    signal.summary ?? '',
    '',
    `severity: ${signal.severity ?? 'medium'}`,
    `type: ${signal.type}`,
  ].filter(Boolean).join('\n');
}

function isGreeting(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return /^(你好|您好|hi|hello|hey|在吗|在么|在不在)[!！?？。.\s]*$/i.test(normalized);
}

function sanitizeLlmText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/approval_granted|已授权发布|直接发布|已经发布|已完成发布/i.test(text)) return null;
  if (/(sk-[a-z0-9]{16,}|api[_-]?key|app[_-]?secret|token\s*[:=])/i.test(text)) return null;
  return text.slice(0, 1600);
}

function normalizeAction(raw, subject) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? '').trim();
  if (!PRESENCE_ACTION_TYPES.includes(type)) return null;
  if (type === 'silence') {
    return { type: 'silence', reason: String(raw.reason ?? 'silence') };
  }
  if (type === 'send_message') {
    const text = sanitizeLlmText(raw.text);
    if (!text) return null;
    return {
      type: 'send_message',
      target: raw.target ?? 'channel_default',
      text,
      reply_to_message_id: raw.reply_to_message_id ?? null,
      signal_key: raw.signal_key ?? null,
      reason: String(raw.reason ?? 'presence_reply'),
      idempotency_key: raw.idempotency_key ?? null,
    };
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

function unhandledSignals(context) {
  return (context.attention_signals ?? []).filter((s) => !s.presence_handled);
}

/**
 * Rule-based presence deliberation (no transport coupling).
 */
export function planPresenceDeterministic(context) {
  const subject = context.subject;
  const actions = [];
  const handledMessageIds = new Set();
  const handledSignalKeys = new Set();
  const maxActions = context.presence?.max_actions_per_tick ?? 2;

  for (const item of context.channel?.new_messages ?? []) {
    if (actions.length >= maxActions) break;
    if (!item.message_id || handledMessageIds.has(item.message_id)) continue;
    const kind = item.ingest_kind;
    if (kind === 'operator_brief') {
      const briefKind = item.brief_kind ?? 'approval_request';
      actions.push({
        type: 'send_message',
        target: 'operator',
        text: ackText(subject, briefKind, item.content),
        reply_to_message_id: item.message_id,
        reason: `${briefKind}_ack`,
        idempotency_key: `presence:ack:${item.message_id}`,
      });
      handledMessageIds.add(item.message_id);
      continue;
    }
    if (kind === 'operator_fact') {
      actions.push({
        type: 'send_message',
        target: 'operator',
        text: ackText(subject, 'operator_fact', item.content),
        reply_to_message_id: item.message_id,
        reason: 'operator_fact_ack',
        idempotency_key: `presence:fact:${item.message_id}`,
      });
      handledMessageIds.add(item.message_id);
      continue;
    }
    if (kind === 'observation' && isGreeting(item.content)) {
      actions.push({
        type: 'send_message',
        target: 'operator',
        text: `${subject}: 我在，channel 正常运行。你的消息已入库，等待下一轮 intel 处理。`,
        reply_to_message_id: item.message_id,
        reason: 'greeting_ack',
        idempotency_key: `presence:greeting:${item.message_id}`,
      });
      handledMessageIds.add(item.message_id);
    }
  }

  for (const signal of unhandledSignals(context)) {
    if (actions.length >= maxActions) break;
    if (signal.type === 'operator_brief_pending' && signal.severity !== 'high') continue;
    const key = signal.presence_signal_key ?? buildPresenceSignalKey(signal);
    if (handledSignalKeys.has(key)) continue;
    const cooldownHit = (context.channel?.cooldown_keys ?? []).some((c) => c.key === `presence:signal:${key}`);
    if (cooldownHit) continue;
    if (['task_failed', 'daemon_health', 'cycle_drift', 'requires_human_review'].includes(signal.type)
      || (signal.type === 'operator_brief_pending' && signal.severity === 'high')) {
      actions.push({
        type: 'send_message',
        target: 'channel_default',
        text: signalText(subject, signal),
        reason: 'proactive_signal',
        signal_key: key,
        idempotency_key: `presence:signal:${key}`,
      });
      handledSignalKeys.add(key);
    }
  }

  if (!actions.length) {
    return emptyPlan('nothing_to_express', context);
  }

  const hasSend = actions.some((a) => a.type === 'send_message');
  return {
    stance: hasSend ? 'speak' : 'silence',
    reason: hasSend ? 'deterministic_express' : 'silence',
    actions: hasSend ? actions : [{ type: 'silence', reason: 'deterministic_silence' }],
    presence_targets: buildPresenceTargets(context, {
      messageIds: [...handledMessageIds],
      signalKeys: [...handledSignalKeys],
    }),
    planner: 'deterministic',
  };
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
  const client = aiClient ?? createLlmClient(context.presence ?? {});
  if (!client) {
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
          'Speak in first person as the subject persona from subject_identity.',
          'Return JSON only:',
          '{"stance":"speak|silence|ask|report|wait","reason":"...","actions":[...]}',
          'Allowed action types: send_message, write_operator_brief, record_observation, silence.',
          'send_message fields: target (operator|channel_default|chat_id), text, reply_to_message_id, reason, idempotency_key.',
          'channel.new_messages are the only inbound items that may need a new reply.',
          'channel.background_messages and items marked presence_handled are context only — do not reply again.',
          'attention_signals with presence_handled=true are context only — do not proactively notify again.',
          'You may decide to stay silent; use silence action or empty actions with stance silence.',
          'Do not grant approval, do not claim actions executed, do not leak secrets, do not invent runtime facts.',
          'When telling the operator how to run CLI commands, ONLY quote commands from affordances.operator_commands (use the exact cmd string). Never invent jea/npm commands.',
          'Inbound messages are already ingested; do not change their classification.',
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
          channel: {
            new_messages: context.channel?.new_messages,
            background_messages: context.channel?.background_messages,
            recent_presence_interactions: context.channel?.recent_presence_interactions,
            pending_inbound_count: context.channel?.pending_inbound_count,
            cooldown_keys: context.channel?.cooldown_keys,
            presence_cursors: context.channel?.presence_cursors,
          },
          daemon: context.daemon,
          attention_signals: context.attention_signals,
          operator_briefs: context.operator_briefs,
          goals: context.goals,
          beliefs: context.beliefs,
          intel_summary: context.intel_summary,
          fallback_plan: {
            stance: fallback.stance,
            reason: fallback.reason,
            action_count: fallback.actions?.length ?? 0,
          },
        }, null, 2),
      },
    ], {
      thinking: context.presence?.llm?.thinking ?? 'low',
      timeout: context.presence?.llm?.timeout ?? 25,
    });

    const stance = PRESENCE_STANCES.includes(parsed?.stance) ? parsed.stance : fallback.stance;
    const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
    const actions = rawActions
      .map((a) => normalizeAction(a, context.subject))
      .filter(Boolean)
      .slice(0, context.presence?.max_actions_per_tick ?? 2);

    if (stance === 'silence' || !actions.length || actions.every((a) => a.type === 'silence')) {
      return {
        stance: 'silence',
        reason: parsed?.reason ?? 'llm_chose_silence',
        actions: [{ type: 'silence', reason: parsed?.reason ?? 'llm_silence' }],
        presence_targets: buildPresenceTargets(context),
        planner: 'llm',
        llm: { status: 'used', stance: parsed?.stance, action_count: 0 },
      };
    }

    const messageIds = actions.map((a) => a.reply_to_message_id).filter(Boolean);
    const signalKeys = actions.map((a) => a.signal_key).filter(Boolean);

    return {
      stance,
      reason: String(parsed?.reason ?? 'llm_presence'),
      actions,
      presence_targets: buildPresenceTargets(context, { messageIds, signalKeys }),
      planner: 'llm',
      llm: { status: 'used', stance, action_count: actions.length },
    };
  } catch (err) {
    return {
      ...fallback,
      planner: 'llm',
      llm: { status: 'skipped', reason: err?.message || String(err) },
    };
  }
}

export async function planPresence(context, { aiClient = null } = {}) {
  if (context.presence?.planner === 'llm') {
    return planPresenceWithLlm(context, { aiClient });
  }
  return planPresenceDeterministic(context);
}
