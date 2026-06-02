import { chatMessagesJson } from '../ai/messages.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { recordChannelEvent } from './audit.mjs';
import { resolveSubjectReplyIdentity } from './subject-identity.mjs';
import { normalizeOutboundMessage } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';
import {
  cooldownActive,
  setCooldown,
  writeOutboxMessage,
  markPresenceMessageHandled,
  markPresenceSignalHandled,
  clearPendingSpeechGeneration,
  trackPendingSpeechGeneration,
} from './state.mjs';
import { recordPresenceInteraction } from './presence-memory.mjs';
import { createIntelligenceStoreForSubject } from './presence-decision-executor.mjs';

function ackText(subject, kind, summary) {
  if (kind === 'approval_ack' || kind === 'approval_request') {
    return [
      `${subject}: 已记录为下一轮审批意图。`,
      '不会代为发布或授权；需下一轮 Decide 在 action 上显式批准后才能执行发布。',
      summary ? `来源：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'verification_ack' || kind === 'verification_request') {
    return [
      `${subject}: 已记录为下一轮核实请求。`,
      summary ? `内容：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'operator_fact_ack' || kind === 'operator_fact') {
    return [
      `${subject}: 已记录为高置信 operator fact。`,
      summary ? `内容：${summary}` : '',
    ].filter(Boolean).join('\n');
  }
  if (kind === 'greeting_ack') {
    return `${subject}: 我在，channel 正常运行。你的消息已入库，等待下一轮 intel 处理。`;
  }
  if (kind === 'proactive_signal') {
    const signal = summary?.signal ?? summary;
    if (signal && typeof signal === 'object') {
      return [
        `${subject}: ${signal.title ?? 'Attention'}`,
        '',
        signal.summary ?? '',
        '',
        `severity: ${signal.severity ?? 'medium'}`,
        `type: ${signal.type}`,
      ].filter(Boolean).join('\n');
    }
  }
  return `${subject}: 已收到并记录。`;
}

function sanitizeGeneratedText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/approval_granted|已授权发布|已经发布|已完成发布/i.test(text)) return null;
  if (/直接发布|直接授权/.test(text) && !/不会|不得|不能|无需|不会/i.test(text)) return null;
  if (/(sk-[a-z0-9]{16,}|api[_-]?key|app[_-]?secret|token\s*[:=])/i.test(text)) return null;
  return text.slice(0, 1600);
}

function renderDeterministicSpeech(intent, subject) {
  const req = intent.content_requirements ?? {};
  if (req.text_hint) return sanitizeGeneratedText(req.text_hint);
  return sanitizeGeneratedText(ackText(subject, req.kind, req.summary ?? req));
}

function createLlmClient(config) {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return null;
  try {
    return new DeepSeekOpenAIClient({ timeout: config.llm?.timeout ?? 25 });
  } catch {
    return null;
  }
}

async function renderLlmSpeech(root, subject, intent, context, { aiClient = null, presenceConfig = null } = {}) {
  const cfg = presenceConfig ?? context?.presence ?? {};
  const client = aiClient ?? createLlmClient(cfg);
  if (!client) return renderDeterministicSpeech(intent, subject);

  const identity = context?.identity ?? resolveSubjectReplyIdentity(root, subject);
  const parsed = await chatMessagesJson(client, [
    {
      role: 'system',
      content: [
        'You generate the final outbound channel message text for one js-evolution-agent subject.',
        'Speak in first person as the subject persona.',
        'Return JSON only: {"text":"..."}',
        'Do not grant approval, do not claim actions executed, do not leak secrets.',
        'Only reference CLI commands from affordances.operator_commands when needed.',
        'Follow content_requirements and risk_constraints in the user payload.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        subject,
        subject_identity: identity,
        speech_intent: intent,
        affordances: context?.affordances,
        channel: {
          new_messages: context?.channel?.new_messages,
          background_messages: context?.channel?.background_messages,
          recent_presence_interactions: context?.channel?.recent_presence_interactions,
        },
        attention_signals: context?.attention_signals,
      }, null, 2),
    },
  ], {
    thinking: cfg.llm?.thinking ?? 'low',
    timeout: cfg.llm?.timeout ?? 25,
  });

  return sanitizeGeneratedText(parsed?.text) ?? renderDeterministicSpeech(intent, subject);
}

/**
 * Generate outbound text from a speech intent and write to outbox.
 */
export async function generateSpeechAndWriteOutbox(root, subject, intent, {
  presenceConfig = null,
  context = null,
  aiClient = null,
  dryRun = false,
  planner = null,
} = {}) {
  const cfg = presenceConfig ?? context?.presence ?? {};
  const effectivePlanner = planner ?? cfg.planner ?? 'deterministic';
  let text = null;
  if (effectivePlanner === 'llm') {
    text = await renderLlmSpeech(root, subject, intent, context, { aiClient, presenceConfig: cfg });
  } else {
    text = renderDeterministicSpeech(intent, subject);
  }
  if (!text) {
    return { ok: false, reason: 'empty_or_guarded_text', intent };
  }

  const idempotencyKey = intent.idempotency_key ?? `presence:speech:${intent.intent_id}`;
  if (cooldownActive(root, subject, idempotencyKey)) {
    return { ok: false, reason: 'cooldown', intent };
  }

  const routed = await resolveOutboundTarget(root, subject, intent.target);
  if (!routed.target) {
    return { ok: false, reason: 'missing_target', intent };
  }

  const outbound = normalizeOutboundMessage({
    channel: routed.transport,
    target: routed.target,
    text,
    subject,
    reason: intent.reason ?? 'presence_reply',
    reply_to_message_id: intent.reply_to_message_id ?? null,
    idempotency_key: idempotencyKey,
    metadata: {
      presence: true,
      speech_intent_id: intent.intent_id,
      planner: effectivePlanner,
      dry_run: dryRun,
      signal_key: intent.signal_key ?? null,
    },
  });

  if (dryRun) {
    return { ok: true, dry_run: true, outbound, intent };
  }

  const written = writeOutboxMessage(root, subject, outbound);
  setCooldown(root, subject, idempotencyKey, cfg.cooldown_ms ?? 30 * 60 * 1000, {
    reply_reason: intent.reason,
  });

  const store = createIntelligenceStoreForSubject(root, subject);
  recordPresenceInteraction(store, {
    interaction_kind: 'send_message',
    content: `Subject sent channel message (${intent.reason}). Text: ${text.slice(0, 400)}`,
    confidence: 'medium',
    evidence_refs: [
      intent.reply_to_message_id ? `channel:message:${intent.reply_to_message_id}` : null,
      intent.signal_key ? `channel:signal:${intent.signal_key}` : null,
      written.file ? `outbox:${written.file}` : null,
    ].filter(Boolean),
  });

  if (intent.reply_to_message_id) {
    markPresenceMessageHandled(root, subject, intent.reply_to_message_id, {
      outcome: 'sent',
      reason: intent.reason,
    });
  }
  if (intent.signal_key) {
    markPresenceSignalHandled(root, subject, intent.signal_key, {
      outcome: 'sent',
      reason: intent.reason,
    });
  }

  clearPendingSpeechGeneration(root, subject, intent.intent_id);

  recordChannelEvent(root, subject, {
    type: 'channel_speech_generated',
    status: 'ok',
    intent_id: intent.intent_id,
    idempotency_key: idempotencyKey,
    target: routed.target,
    reason: intent.reason,
  });

  recordChannelEvent(root, subject, {
    type: 'channel_presence_action_applied',
    status: 'ok',
    action_type: 'speech_intent',
    idempotency_key: idempotencyKey,
    target: routed.target,
    reason: intent.reason,
  });

  return { ok: true, outbound: written.message, file: written.file, intent, text };
}

export async function runSpeechGenerationForEvent(root, subject, event, options = {}) {
  const payload = event.payload ?? event.payload_summary ?? {};
  const intent = {
    intent_id: payload.intent_id ?? event.id,
    target: payload.target ?? 'channel_default',
    reason: payload.reason ?? 'presence_reply',
    reply_to_message_id: payload.reply_to_message_id ?? null,
    signal_key: payload.signal_key ?? null,
    idempotency_key: payload.idempotency_key ?? null,
    content_requirements: payload.content_requirements ?? { kind: 'custom' },
    risk_constraints: payload.risk_constraints ?? {},
  };

  trackPendingSpeechGeneration(root, subject, {
    intent_id: intent.intent_id,
    event_id: event.id,
    requested_at: event.created_at,
  });

  try {
    return await generateSpeechAndWriteOutbox(root, subject, intent, options);
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'channel_speech_generation_failed',
      status: 'error',
      intent_id: intent.intent_id,
      error: err?.message || String(err),
    });
    throw err;
  }
}
