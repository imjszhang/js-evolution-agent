import { chatMessagesJson } from '../ai/messages.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { runWithTimeout } from './async-utils.mjs';
import { recordChannelEvent } from './audit.mjs';
import { resolveSubjectReplyIdentity } from './subject-identity.mjs';
import { normalizeOutboundMessage } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';
import {
  cooldownActive,
  setCooldown,
  writeOutboxMessage,
  markExpressionCandidateHandled,
  clearPendingSpeechGeneration,
  trackPendingSpeechGeneration,
} from './state.mjs';
import { recordPresenceInteraction, formatPresenceInteractionContent } from './presence-memory.mjs';
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
  if (kind === 'control_action_ack') {
    const result = summary?.control_result ?? summary;
    if (result && typeof result === 'object') {
      if (result.ok === false) {
        return [
          `${subject}: 控制请求未能执行。`,
          result.reason ? `原因：${result.reason}` : '',
          result.action_id ? `动作：${result.action_id}` : '',
        ].filter(Boolean).join('\n');
      }
      return [
        `${subject}: 控制请求已执行。`,
        result.summary ?? result.mode ?? result.action_id ?? '',
      ].filter(Boolean).join('\n');
    }
  }
  if (kind === 'agent_run_result') {
    const result = summary?.agent_result ?? summary;
    if (result && typeof result === 'object') {
      if (result.ok === false) {
        return [
          `${subject}: 异步 agent 已结束，但未成功完成。`,
          result.reason ? `原因：${result.reason}` : '',
          result.error ? `错误：${result.error}` : '',
          result.summary ? `摘要：${result.summary}` : '',
        ].filter(Boolean).join('\n');
      }
      return [
        `${subject}: 异步 agent 已完成。`,
        result.summary ? `摘要：${result.summary}` : '',
        result.status ? `状态：${result.status}` : '',
      ].filter(Boolean).join('\n');
    }
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
        'cycle_memory holds long-term continuity; channel_memory holds current perception. SOUL controls voice only — not facts or permissions.',
        'Speak in first person as the subject persona.',
        'Return JSON only: {"text":"..."}',
        'Use speech_intent.reason_summary and tone_hint for why/how to sound; do not invent facts beyond cycle_memory.',
        'Do not grant approval, do not claim actions executed, do not leak secrets.',
        'Only reference CLI commands from affordances.operator_commands when needed.',
        'Follow content_requirements and risk_constraints in the user payload.',
        'For custom ordinary-message replies, follow subject_identity.soul and cycle_memory.recent_channel_presence instead of a generic acknowledgement.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        subject,
        subject_identity: identity,
        speech_intent: {
          reason: intent.reason,
          reason_summary: intent.reason_summary,
          tone_hint: intent.tone_hint,
          source_refs: intent.source_refs,
          memory_effect: intent.memory_effect,
          content_requirements: intent.content_requirements,
          risk_constraints: intent.risk_constraints,
          candidate_id: intent.candidate_id,
        },
        affordances: context?.affordances,
        cycle_memory: context?.cycle_memory,
        channel_memory: context?.channel_memory,
        expression: {
          candidates: context?.expression?.candidates,
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
    text = await runWithTimeout(
      () => renderLlmSpeech(root, subject, intent, context, { aiClient, presenceConfig: cfg }),
      cfg.speech_generation_timeout_ms ?? 30_000,
      'speech_generation',
    );
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
      candidate_id: intent.candidate_id ?? null,
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
    content: formatPresenceInteractionContent('send_message', {
      why: intent.reason_summary ?? intent.reason,
      content_summary: text.slice(0, 400),
      candidate_id: intent.candidate_id,
      outbox_ref: written.file ? `outbox:${written.file}` : null,
    }),
    confidence: 'medium',
    evidence_refs: [
      intent.candidate_id ? `expression:${intent.candidate_id}` : null,
      written.file ? `outbox:${written.file}` : null,
      ...(intent.source_refs ?? []),
    ].filter(Boolean),
  });

  if (intent.candidate_id) {
    markExpressionCandidateHandled(root, subject, intent.candidate_id, {
      outcome: 'sent',
      reason: intent.reason,
      intent_id: intent.intent_id,
    });
  }

  clearPendingSpeechGeneration(root, subject, intent.intent_id);

  recordChannelEvent(root, subject, {
    type: 'channel_speech_generated',
    status: 'ok',
    intent_id: intent.intent_id,
    candidate_id: intent.candidate_id ?? null,
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
    candidate_id: payload.candidate_id ?? null,
    target: payload.target ?? 'channel_default',
    reason: payload.reason ?? 'presence_reply',
    reason_summary: payload.reason_summary ?? payload.reason ?? null,
    tone_hint: payload.tone_hint ?? null,
    source_refs: payload.source_refs ?? [],
    memory_effect: payload.memory_effect ?? 'record_said',
    reply_to_message_id: payload.reply_to_message_id ?? null,
    signal_key: payload.signal_key ?? null,
    idempotency_key: payload.idempotency_key ?? null,
    content_requirements: payload.content_requirements ?? { kind: 'custom' },
    risk_constraints: payload.risk_constraints ?? {},
  };

  trackPendingSpeechGeneration(root, subject, {
    intent_id: intent.intent_id,
    candidate_id: intent.candidate_id,
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
