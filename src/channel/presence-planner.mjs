import { chatMessagesJson } from '../ai/messages.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { nowIso } from './types.mjs';

export const PRESENCE_STANCES = Object.freeze(['speak', 'silence', 'ask', 'report', 'wait']);
export const PRESENCE_ACTION_TYPES = Object.freeze([
  'send_message',
  'write_operator_brief',
  'record_observation',
  'silence',
]);

function emptyPlan(reason, extra = {}) {
  return {
    stance: 'silence',
    reason,
    actions: [{ type: 'silence', reason }],
    memory: { summary: reason, at: nowIso() },
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

/**
 * Rule-based presence deliberation (no transport coupling).
 */
export function planPresenceDeterministic(context) {
  const subject = context.subject;
  const actions = [];
  const handledMessageIds = new Set();
  const maxActions = context.presence?.max_actions_per_tick ?? 2;

  for (const item of context.channel?.recent_ingested ?? []) {
    if (actions.length >= maxActions) break;
    if (handledMessageIds.has(item.message_id)) continue;
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

  for (const signal of context.attention_signals ?? []) {
    if (actions.length >= maxActions) break;
    if (signal.type === 'operator_brief_pending' && signal.severity !== 'high') continue;
    const key = signal.key ?? signal.type;
    const cooldownHit = (context.channel?.cooldown_keys ?? []).some((c) => c.key === `presence:signal:${key}`);
    if (cooldownHit) continue;
    if (['task_failed', 'daemon_health', 'cycle_drift', 'requires_human_review'].includes(signal.type)
      || (signal.type === 'operator_brief_pending' && signal.severity === 'high')) {
      actions.push({
        type: 'send_message',
        target: 'channel_default',
        text: signalText(subject, signal),
        reason: 'proactive_signal',
        idempotency_key: `presence:signal:${key}`,
      });
    }
  }

  if (!actions.length) {
    return emptyPlan('nothing_to_express');
  }

  const hasSend = actions.some((a) => a.type === 'send_message');
  return {
    stance: hasSend ? 'speak' : 'silence',
    reason: hasSend ? 'deterministic_express' : 'silence',
    actions: hasSend ? actions : [{ type: 'silence', reason: 'deterministic_silence' }],
    memory: {
      summary: `presence tick expressed ${actions.filter((a) => a.type === 'send_message').length} message(s)`,
      at: nowIso(),
    },
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
          '{"stance":"speak|silence|ask|report|wait","reason":"...","actions":[...],"memory":{"summary":"..."}}',
          'Allowed action types: send_message, write_operator_brief, record_observation, silence.',
          'send_message fields: target (operator|channel_default|chat_id), text, reply_to_message_id, reason, idempotency_key.',
          'You may decide to stay silent; use silence action or empty actions with stance silence.',
          'Do not grant approval, do not claim actions executed, do not leak secrets, do not invent runtime facts.',
          'Inbound messages are already ingested; do not change their classification.',
          'Respect constraints in the user payload.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          subject: context.subject,
          subject_identity: context.identity,
          constraints: context.constraints,
          channel: context.channel,
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
        memory: {
          summary: parsed?.memory?.summary ?? parsed?.reason ?? 'llm silence',
          at: nowIso(),
        },
        planner: 'llm',
        llm: { status: 'used', stance: parsed?.stance, action_count: 0 },
      };
    }

    return {
      stance,
      reason: String(parsed?.reason ?? 'llm_presence'),
      actions,
      memory: {
        summary: parsed?.memory?.summary ?? parsed?.reason ?? 'llm presence',
        at: nowIso(),
      },
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
