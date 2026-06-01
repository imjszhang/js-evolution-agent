import { resolveFeishuConfig } from './adapters/feishu/config.mjs';
import { recordChannelEvent, readChannelEvents } from './audit.mjs';
import { cooldownActive, setCooldown, writeOutboxMessage } from './state.mjs';
import { normalizeOutboundMessage, nowIso } from './types.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { chatMessagesJson } from '../ai/messages.mjs';

export const REPLY_MODES = Object.freeze(['off', 'audit_only', 'guarded', 'autonomous', 'llm_autonomous']);

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_LLM_DRAFT_REASONS = ['proactive_signal', 'greeting_ack'];

const DEFAULT_TEMPLATES = Object.freeze({
  approval_request: [
    'JEA {{subject}}: 已记录为下一轮审批意图。',
    '说明：不会直接发布或授权；需下一轮 Decide 显式产出 approval_granted action。',
    '来源消息：{{summary}}',
  ].join('\n'),
  verification_request: [
    'JEA {{subject}}: 已记录为下一轮核实请求。',
    '内容：{{summary}}',
  ].join('\n'),
  operator_fact: [
    'JEA {{subject}}: 已记录为高置信 operator fact。',
    '内容：{{summary}}',
  ].join('\n'),
  greeting: 'JEA {{subject}}: 我在，channel 正常运行。你的消息已入库，等待下一轮 intel 处理。',
});

function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

function readReplyBlock(feishuConfig) {
  return feishuConfig?.reply ?? {};
}

export function resolveReplyConfig(root, subject, overrides = {}) {
  const feishu = resolveFeishuConfig(root, subject, overrides);
  const block = readReplyBlock(feishu);
  const mode = REPLY_MODES.includes(block.mode) ? block.mode : 'guarded';
  const proactiveDefault = mode !== 'off' && mode !== 'audit_only';
  return {
    mode,
    on_inbound: block.on_inbound ?? block.onInbound ?? true,
    proactive: block.proactive ?? proactiveDefault,
    reply_observations: block.reply_observations ?? block.replyObservations ?? false,
    cooldown_ms: Number(block.cooldown_ms ?? block.cooldownMs) || DEFAULT_COOLDOWN_MS,
    max_messages_per_hour: Number(block.max_messages_per_hour ?? block.maxMessagesPerHour) || 0,
    llm_draft: {
      enabled: Boolean(block.llm_draft?.enabled ?? block.llmDraft?.enabled ?? false),
      timeout: Number(block.llm_draft?.timeout ?? block.llmDraft?.timeout) || 20,
      allowed_reasons: Array.isArray(block.llm_draft?.allowed_reasons)
        ? block.llm_draft.allowed_reasons
        : (Array.isArray(block.llmDraft?.allowedReasons)
          ? block.llmDraft.allowedReasons
          : DEFAULT_LLM_DRAFT_REASONS),
    },
    llm_decision: {
      enabled: Boolean(block.llm_decision?.enabled ?? block.llmDecision?.enabled ?? mode === 'llm_autonomous'),
      timeout: Number(block.llm_decision?.timeout ?? block.llmDecision?.timeout) || 20,
      thinking: block.llm_decision?.thinking ?? block.llmDecision?.thinking ?? 'low',
    },
    templates: {
      ...DEFAULT_TEMPLATES,
      ...(block.templates ?? {}),
    },
    feishu,
  };
}

export function replyConfigForApi(config) {
  if (!config) return null;
  return {
    mode: config.mode,
    on_inbound: config.on_inbound,
    proactive: config.proactive,
    reply_observations: config.reply_observations,
    cooldown_ms: config.cooldown_ms,
    max_messages_per_hour: config.max_messages_per_hour,
    llm_draft: {
      enabled: Boolean(config.llm_draft?.enabled),
      timeout: config.llm_draft?.timeout ?? 20,
      allowed_reasons: config.llm_draft?.allowed_reasons ?? DEFAULT_LLM_DRAFT_REASONS,
    },
    llm_decision: {
      enabled: Boolean(config.llm_decision?.enabled),
      timeout: config.llm_decision?.timeout ?? 20,
      thinking: config.llm_decision?.thinking ?? 'low',
    },
  };
}

function resolveInboundTarget(envelope, feishuConfig) {
  if (envelope?.sender_id) return envelope.sender_id;
  if (envelope?.chat_id) return envelope.chat_id;
  return feishuConfig?.defaultChatId ?? null;
}

function resolveProactiveTarget(feishuConfig) {
  return feishuConfig?.defaultChatId ?? feishuConfig?.operatorBinding?.open_id ?? null;
}

function isGreeting(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return /^(你好|您好|hi|hello|hey|在吗|在么|在不在)[!！?？。.\s]*$/i.test(normalized);
}

function isReplyableFeishuMessageId(messageId) {
  return /^om_[a-zA-Z0-9_-]+$/.test(String(messageId || '').trim());
}

function replyToMessageId(envelope) {
  const messageId = envelope?.message_id ?? null;
  if (envelope?.channel === 'feishu' && !isReplyableFeishuMessageId(messageId)) {
    return null;
  }
  return messageId;
}

function baseDecision(action, reason, extra = {}) {
  return {
    action,
    reason,
    text: null,
    target: null,
    reply_to_message_id: null,
    idempotency_key: null,
    metadata: {},
    ...extra,
  };
}

function templateFor(config, key, vars) {
  return renderTemplate(config.templates?.[key] ?? DEFAULT_TEMPLATES[key] ?? '', vars);
}

function recentReplyCount(root, subject, { windowMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  return readChannelEvents(root, subject, { limit: 500 }).filter((event) => {
    if (event.type !== 'channel_reply_enqueued') return false;
    const recorded = Date.parse(event.recorded_at ?? '');
    return Number.isFinite(recorded) && nowMs - recorded <= windowMs;
  }).length;
}

export function decideInboundReply(root, subject, {
  envelope,
  ingestResult,
  config = null,
  recentState = {},
} = {}) {
  const replyConfig = config ?? resolveReplyConfig(root, subject);
  const { mode, on_inbound, reply_observations } = replyConfig;

  if (mode === 'off' || !on_inbound) {
    return baseDecision('none', mode === 'off' ? 'reply_mode_off' : 'inbound_reply_disabled');
  }

  if (ingestResult?.kind === 'feishu_bind') {
    return baseDecision('none', 'bind_handled_separately');
  }

  if (recentState?.skipped === 'duplicate') {
    return baseDecision('none', 'duplicate_message');
  }

  const messageId = envelope?.message_id ?? null;
  const replyTo = replyToMessageId(envelope);
  const text = String(envelope?.content ?? '').trim();
  const target = resolveInboundTarget(envelope, replyConfig.feishu);
  if (!target) {
    return baseDecision('none', 'missing_target');
  }

  if (ingestResult?.kind === 'operator_brief') {
    const brief = ingestResult.brief ?? {};
    if (mode === 'audit_only') {
      return baseDecision('none', 'audit_only_mode', {
        metadata: { brief_id: brief.id, brief_kind: brief.kind },
      });
    }
    if (brief.kind === 'approval_request') {
      return baseDecision('send', 'approval_brief_ack', {
        text: templateFor(replyConfig, 'approval_request', {
          subject,
          summary: brief.summary ?? text,
        }),
        target,
        reply_to_message_id: replyTo,
        idempotency_key: `reply:inbound:approval:${messageId ?? brief.id}`,
        metadata: { brief_id: brief.id, brief_kind: brief.kind, source_message_id: messageId },
      });
    }
    if (brief.kind === 'verification_request') {
      return baseDecision('send', 'verification_brief_ack', {
        text: templateFor(replyConfig, 'verification_request', {
          subject,
          summary: brief.summary ?? text,
        }),
        target,
        reply_to_message_id: replyTo,
        idempotency_key: `reply:inbound:verification:${messageId ?? brief.id}`,
        metadata: { brief_id: brief.id, brief_kind: brief.kind, source_message_id: messageId },
      });
    }
    return baseDecision('none', 'unsupported_brief_kind', {
      metadata: { brief_id: brief.id, brief_kind: brief.kind },
    });
  }

  if (ingestResult?.kind === 'operator_fact') {
    if (mode === 'audit_only') {
      return baseDecision('none', 'audit_only_mode', { metadata: { ingest_kind: 'operator_fact' } });
    }
    return baseDecision('send', 'operator_fact_ack', {
      text: templateFor(replyConfig, 'operator_fact', { subject, summary: text }),
      target,
      reply_to_message_id: replyTo,
      idempotency_key: `reply:inbound:fact:${messageId ?? hashFallback(text)}`,
      metadata: { ingest_kind: 'operator_fact', source_message_id: messageId },
    });
  }

  if (ingestResult?.kind === 'observation') {
    if (reply_observations || mode === 'autonomous') {
      if (isGreeting(text)) {
        return baseDecision('send', 'greeting_ack', {
          text: templateFor(replyConfig, 'greeting', { subject }),
          target,
          reply_to_message_id: replyTo,
          idempotency_key: `reply:inbound:greeting:${messageId ?? hashFallback(text)}`,
          metadata: { ingest_kind: 'observation', source_message_id: messageId },
        });
      }
    }
    return baseDecision('none', 'observation_no_reply', {
      metadata: { ingest_kind: 'observation' },
    });
  }

  return baseDecision('none', 'unsupported_ingest_kind', {
    metadata: { ingest_kind: ingestResult?.kind ?? null },
  });
}

function hashFallback(value) {
  return String(value || 'unknown').slice(0, 32);
}

function summarizeIngestResult(ingestResult) {
  if (!ingestResult) return { kind: null };
  if (ingestResult.kind === 'operator_brief') {
    return {
      kind: ingestResult.kind,
      brief_kind: ingestResult.brief?.kind ?? null,
      summary: ingestResult.brief?.summary ?? null,
      priority: ingestResult.brief?.priority ?? null,
    };
  }
  if (ingestResult.kind === 'operator_fact') {
    return {
      kind: ingestResult.kind,
      content: ingestResult.record?.content ?? null,
      confidence: ingestResult.record?.confidence ?? null,
    };
  }
  return {
    kind: ingestResult.kind,
    content: ingestResult.record?.content ?? null,
    confidence: ingestResult.record?.confidence ?? null,
  };
}

function llmDecisionMetadata(status, extra = {}) {
  return { llm_decision: { status, ...extra } };
}

function withLlmDecisionMetadata(decision, status, extra = {}) {
  return {
    ...decision,
    metadata: {
      ...(decision.metadata ?? {}),
      ...llmDecisionMetadata(status, extra),
    },
  };
}

function sanitizeAutonomousText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/approval_granted|已授权发布|直接发布|已经发布|已执行发布|已完成发布/i.test(text)) return null;
  if (/(sk-[a-z0-9]{16,}|api[_-]?key|app[_-]?secret|token\s*[:=])/i.test(text)) return null;
  return text.slice(0, 1600);
}

function metadataForInboundDecision(ingestResult, messageId) {
  if (ingestResult?.kind === 'operator_brief') {
    return {
      brief_id: ingestResult.brief?.id ?? null,
      brief_kind: ingestResult.brief?.kind ?? null,
      source_message_id: messageId,
    };
  }
  return {
    ingest_kind: ingestResult?.kind ?? null,
    source_message_id: messageId,
  };
}

export async function decideInboundReplyWithLlm(root, subject, {
  envelope,
  ingestResult,
  config = null,
  recentState = {},
  aiClient = null,
} = {}) {
  const replyConfig = config ?? resolveReplyConfig(root, subject);
  const fallback = decideInboundReply(root, subject, {
    envelope,
    ingestResult,
    config: replyConfig,
    recentState,
  });
  if (replyConfig.mode !== 'llm_autonomous' || !replyConfig.llm_decision?.enabled) {
    return fallback;
  }
  if (fallback.reason === 'reply_mode_off'
    || fallback.reason === 'inbound_reply_disabled'
    || fallback.reason === 'bind_handled_separately'
    || fallback.reason === 'duplicate_message'
    || fallback.reason === 'missing_target') {
    return fallback;
  }

  const messageId = envelope?.message_id ?? null;
  const target = resolveInboundTarget(envelope, replyConfig.feishu);
  const replyTo = replyToMessageId(envelope);
  const client = aiClient ?? createDraftClient();
  if (!client) {
    return withLlmDecisionMetadata(fallback, 'skipped', { reason: 'missing_ai_client' });
  }

  try {
    const parsed = await chatMessagesJson(client, [
      {
        role: 'system',
        content: [
          'You are the autonomous Chinese channel reply planner for js-evolution-agent.',
          'Decide whether to reply and draft the reply. Casual conversation is allowed.',
          'Return JSON only: {"action":"send|none","text":"...","reason":"...","confidence":"low|medium|high","risk":"low|medium|high"}.',
          'The inbound message has already been stored by ingest; do not change its classification.',
          'You may explain what the agent is and discuss status based only on provided context.',
          'Do not grant approval, do not claim actions have executed, do not leak secrets, and do not invent runtime facts.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          subject,
          message: {
            id: messageId,
            channel: envelope?.channel ?? null,
            chat_type: envelope?.chat_type ?? null,
            content: envelope?.content ?? '',
          },
          ingest_result: summarizeIngestResult(ingestResult),
          fallback_decision: {
            action: fallback.action,
            reason: fallback.reason,
            text: fallback.text,
          },
        }, null, 2),
      },
    ], {
      thinking: replyConfig.llm_decision.thinking,
      timeout: replyConfig.llm_decision.timeout,
    });

    if (parsed?.action !== 'send') {
      return baseDecision('none', 'llm_autonomous_none', {
        metadata: {
          ...metadataForInboundDecision(ingestResult, messageId),
          ...llmDecisionMetadata('used', {
            action: parsed?.action ?? 'none',
            reason: parsed?.reason ?? null,
            confidence: parsed?.confidence ?? null,
            risk: parsed?.risk ?? null,
          }),
        },
      });
    }

    const text = sanitizeAutonomousText(parsed?.text);
    if (!text) {
      return withLlmDecisionMetadata(fallback, 'skipped', { reason: 'guardrail_rejected_text' });
    }

    return baseDecision('send', 'llm_autonomous_reply', {
      text,
      target,
      reply_to_message_id: replyTo,
      idempotency_key: `reply:inbound:llm:${messageId ?? hashFallback(text)}`,
      metadata: {
        ...metadataForInboundDecision(ingestResult, messageId),
        ...llmDecisionMetadata('used', {
          action: 'send',
          reason: parsed?.reason ?? null,
          confidence: parsed?.confidence ?? null,
          risk: parsed?.risk ?? null,
        }),
      },
    });
  } catch (err) {
    return withLlmDecisionMetadata(fallback, 'skipped', { reason: err?.message || String(err) });
  }
}

export function decideProactiveReply(root, subject, {
  signal,
  config = null,
} = {}) {
  const replyConfig = config ?? resolveReplyConfig(root, subject);
  const { mode, proactive } = replyConfig;

  if (mode === 'off' || !proactive) {
    return baseDecision('none', mode === 'off' ? 'reply_mode_off' : 'proactive_disabled');
  }

  if (mode === 'audit_only') {
    return baseDecision('none', 'audit_only_mode', {
      metadata: { signal_type: signal?.type ?? null },
    });
  }

  const target = resolveProactiveTarget(replyConfig.feishu);
  if (!target) {
    return baseDecision('none', 'missing_target', {
      metadata: { signal_type: signal?.type ?? null },
    });
  }

  const signalType = signal?.type ?? 'unknown';
  if (signalType === 'operator_brief_pending' && signal?.severity !== 'high') {
    return baseDecision('none', 'low_priority_brief_signal', {
      metadata: { signal_type: signalType },
    });
  }
  if (signalType === 'operator_brief_pending' && signal?.refs?.brief_id) {
    const ackCooldownKey = `reply:brief_ack:${signal.refs.brief_id}`;
    if (cooldownActive(root, subject, ackCooldownKey)) {
      return baseDecision('none', 'recent_inbound_ack', {
        metadata: { signal_type: signalType, signal_key: signal?.key ?? null, brief_id: signal.refs.brief_id },
      });
    }
  }

  const text = [
    `JEA ${subject}: ${signal?.title ?? 'Attention signal'}`,
    '',
    signal?.summary ?? '',
    '',
    `severity: ${signal?.severity ?? 'medium'}`,
    `type: ${signalType}`,
  ].filter(Boolean).join('\n');

  return baseDecision('send', 'proactive_signal', {
    text,
    target,
    idempotency_key: `reply:proactive:${signal?.key ?? signalType}`,
    metadata: {
      signal_type: signalType,
      signal_key: signal?.key ?? null,
      proactive: true,
    },
  });
}

export function applyReplyDecision(root, subject, decision, {
  config = null,
  dryRun = false,
  channel = 'feishu',
  reason = null,
  subjectLabel = subject,
} = {}) {
  const replyConfig = config ?? resolveReplyConfig(root, subject);
  const baseEvent = {
    action: decision.action,
    reason: decision.reason,
    message_id: decision.reply_to_message_id ?? null,
    ingest_kind: decision.metadata?.ingest_kind ?? decision.metadata?.brief_kind ?? null,
    signal_type: decision.metadata?.signal_type ?? null,
  };

  recordChannelEvent(root, subject, {
    type: 'channel_reply_decided',
    status: 'ok',
    ...baseEvent,
  });

  if (decision.action === 'none') {
    recordChannelEvent(root, subject, {
      type: 'channel_reply_skipped',
      status: 'ok',
      skip_reason: decision.reason,
      ...baseEvent,
    });
    return { applied: false, skipped: true, reason: decision.reason, decision };
  }

  if (decision.action === 'defer') {
    return { applied: false, deferred: true, reason: decision.reason, decision };
  }

  if (!decision.text || !decision.target) {
    recordChannelEvent(root, subject, {
      type: 'channel_reply_skipped',
      status: 'ok',
      skip_reason: 'missing_text_or_target',
      ...baseEvent,
    });
    return { applied: false, skipped: true, reason: 'missing_text_or_target', decision };
  }

  const idempotencyKey = decision.idempotency_key ?? `reply:${Date.now()}`;
  if (cooldownActive(root, subject, idempotencyKey)) {
    recordChannelEvent(root, subject, {
      type: 'channel_reply_skipped',
      status: 'ok',
      skip_reason: 'cooldown',
      idempotency_key: idempotencyKey,
      ...baseEvent,
    });
    return { applied: false, skipped: true, reason: 'cooldown', decision };
  }
  if (replyConfig.max_messages_per_hour > 0
    && recentReplyCount(root, subject) >= replyConfig.max_messages_per_hour) {
    recordChannelEvent(root, subject, {
      type: 'channel_reply_skipped',
      status: 'ok',
      skip_reason: 'rate_limited',
      idempotency_key: idempotencyKey,
      limit: replyConfig.max_messages_per_hour,
      ...baseEvent,
    });
    return { applied: false, skipped: true, reason: 'rate_limited', decision };
  }

  const outbound = normalizeOutboundMessage({
    channel,
    target: decision.target,
    text: decision.text,
    subject: subjectLabel,
    reason: reason ?? (decision.metadata?.proactive ? 'proactive_reply' : 'inbound_reply'),
    priority: decision.metadata?.proactive ? 'medium' : 'low',
    reply_to_message_id: decision.reply_to_message_id,
    idempotency_key: idempotencyKey,
    metadata: {
      reply_decision: decision,
      generated_at: nowIso(),
      mock: dryRun
        || process.env.JEA_CHANNEL_FEISHU_MOCK === '1'
        || process.env.JEA_CHANNEL_LARK_MOCK === '1',
      ...(decision.metadata ?? {}),
    },
  });

  if (dryRun) {
    return { applied: false, dry_run: true, outbound, decision };
  }

  const written = writeOutboxMessage(root, subject, outbound);
  setCooldown(root, subject, idempotencyKey, replyConfig.cooldown_ms, {
    reply_reason: decision.reason,
    signal_type: decision.metadata?.signal_type ?? null,
  });
  if (decision.metadata?.brief_id && !decision.metadata?.proactive) {
    setCooldown(root, subject, `reply:brief_ack:${decision.metadata.brief_id}`, replyConfig.cooldown_ms, {
      reply_reason: decision.reason,
      source_message_id: decision.metadata.source_message_id ?? null,
    });
  }
  recordChannelEvent(root, subject, {
    type: 'channel_reply_enqueued',
    status: 'ok',
    idempotency_key: idempotencyKey,
    target: decision.target,
    ...baseEvent,
  });
  return { applied: true, outbound: written.message, file: written.file, decision };
}

function canUseLlmDraft(config, decision) {
  if (!config?.llm_draft?.enabled) return false;
  if (decision?.action !== 'send' || !decision?.text) return false;
  const allowed = config.llm_draft.allowed_reasons ?? DEFAULT_LLM_DRAFT_REASONS;
  return allowed.includes(decision.reason);
}

function sanitizeDraftText(value, fallback) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (/approval_granted|已授权发布|直接发布|已经发布/i.test(text)) return fallback;
  return text.slice(0, 1200);
}

function createDraftClient() {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return null;
  try {
    return new DeepSeekOpenAIClient({ timeout: 20 });
  } catch {
    return null;
  }
}

export async function refineReplyDecisionWithDraft(root, subject, decision, {
  config = null,
  aiClient = null,
} = {}) {
  const replyConfig = config ?? resolveReplyConfig(root, subject);
  if (!canUseLlmDraft(replyConfig, decision)) return decision;
  const client = aiClient ?? createDraftClient();
  if (!client) {
    return {
      ...decision,
      metadata: { ...(decision.metadata ?? {}), llm_draft: { skipped: true, reason: 'missing_ai_client' } },
    };
  }
  try {
    const parsed = await chatMessagesJson(client, [
      {
        role: 'system',
        content: [
          'You draft short Chinese channel replies for js-evolution-agent.',
          'Return JSON only: {"text":"..."}',
          'Do not grant approval, do not claim an action has executed, and do not invent facts.',
          'Keep the reply concise and preserve the original safety boundary.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          subject,
          reason: decision.reason,
          original_text: decision.text,
          metadata: decision.metadata ?? {},
        }, null, 2),
      },
    ], { thinking: 'low', timeout: replyConfig.llm_draft.timeout });
    return {
      ...decision,
      text: sanitizeDraftText(parsed?.text, decision.text),
      metadata: {
        ...(decision.metadata ?? {}),
        llm_draft: { used: true, reason: decision.reason },
      },
    };
  } catch (err) {
    return {
      ...decision,
      metadata: {
        ...(decision.metadata ?? {}),
        llm_draft: { skipped: true, reason: err?.message || String(err) },
      },
    };
  }
}

export function decideAndApplyInboundReply(root, subject, context, options = {}) {
  const decision = decideInboundReply(root, subject, context);
  return { decision, result: applyReplyDecision(root, subject, decision, options) };
}

export function decideAndApplyProactiveReply(root, subject, context, options = {}) {
  const decision = decideProactiveReply(root, subject, context);
  return { decision, result: applyReplyDecision(root, subject, decision, options) };
}
