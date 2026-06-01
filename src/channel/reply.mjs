import { resolveFeishuConfig } from './adapters/feishu/config.mjs';
import { recordChannelEvent } from './audit.mjs';
import { cooldownActive, setCooldown, writeOutboxMessage } from './state.mjs';
import { normalizeOutboundMessage, nowIso } from './types.mjs';

export const REPLY_MODES = Object.freeze(['off', 'audit_only', 'guarded', 'autonomous']);

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

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
        reply_to_message_id: messageId,
        idempotency_key: `reply:inbound:approval:${messageId ?? brief.id}`,
        metadata: { brief_id: brief.id, brief_kind: brief.kind },
      });
    }
    if (brief.kind === 'verification_request') {
      return baseDecision('send', 'verification_brief_ack', {
        text: templateFor(replyConfig, 'verification_request', {
          subject,
          summary: brief.summary ?? text,
        }),
        target,
        reply_to_message_id: messageId,
        idempotency_key: `reply:inbound:verification:${messageId ?? brief.id}`,
        metadata: { brief_id: brief.id, brief_kind: brief.kind },
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
      reply_to_message_id: messageId,
      idempotency_key: `reply:inbound:fact:${messageId ?? hashFallback(text)}`,
      metadata: { ingest_kind: 'operator_fact' },
    });
  }

  if (ingestResult?.kind === 'observation') {
    if (reply_observations || mode === 'autonomous') {
      if (isGreeting(text)) {
        return baseDecision('send', 'greeting_ack', {
          text: templateFor(replyConfig, 'greeting', { subject }),
          target,
          reply_to_message_id: messageId,
          idempotency_key: `reply:inbound:greeting:${messageId ?? hashFallback(text)}`,
          metadata: { ingest_kind: 'observation' },
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
  recordChannelEvent(root, subject, {
    type: 'channel_reply_enqueued',
    status: 'ok',
    idempotency_key: idempotencyKey,
    target: decision.target,
    ...baseEvent,
  });
  return { applied: true, outbound: written.message, file: written.file, decision };
}

export function decideAndApplyInboundReply(root, subject, context, options = {}) {
  const decision = decideInboundReply(root, subject, context);
  return { decision, result: applyReplyDecision(root, subject, decision, options) };
}

export function decideAndApplyProactiveReply(root, subject, context, options = {}) {
  const decision = decideProactiveReply(root, subject, context);
  return { decision, result: applyReplyDecision(root, subject, decision, options) };
}
