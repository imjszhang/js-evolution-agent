import { normalizeChannelEnvelope, normalizeOutboundMessage, nowIso } from '../types.mjs';

async function loadOpenClawLark() {
  const spec = process.env.JEA_CHANNEL_LARK_MODULE || '@larksuite/openclaw-lark';
  try {
    return await import(spec);
  } catch (err) {
    const error = new Error(`openclaw-lark adapter unavailable: ${err?.message || err}`);
    error.code = 'openclaw_lark_unavailable';
    throw error;
  }
}

export function envelopeFromOpenClawMessageContext(ctx = {}) {
  return normalizeChannelEnvelope({
    channel: 'lark',
    adapter: 'openclaw-lark',
    direction: 'inbound',
    message_id: ctx.message_id ?? ctx.messageId,
    chat_id: ctx.chat_id ?? ctx.chatId,
    chat_type: ctx.chat_type ?? ctx.chatType,
    sender_id: ctx.sender_id ?? ctx.senderId,
    sender_name: ctx.sender_name ?? ctx.senderName,
    thread_id: ctx.thread_id ?? ctx.threadId,
    parent_id: ctx.parent_id ?? ctx.parentId,
    root_id: ctx.root_id ?? ctx.rootId,
    content: ctx.content ?? ctx.text ?? '',
    content_type: ctx.content_type ?? ctx.contentType ?? 'text',
    resources: ctx.resources ?? [],
    mentions: ctx.mentions ?? [],
    received_at: ctx.received_at ?? nowIso(),
    raw: ctx,
  });
}

export async function envelopeFromFeishuEvent(event = {}, { botOpenId = null, cfg = null } = {}) {
  const plugin = await loadOpenClawLark();
  if (typeof plugin.parseMessageEvent !== 'function') {
    throw new Error('openclaw-lark parseMessageEvent export is unavailable');
  }
  const ctx = await plugin.parseMessageEvent(event, botOpenId, cfg ? { cfg } : {});
  return envelopeFromOpenClawMessageContext(ctx);
}

export async function normalizeInboundPayload(payload = {}, options = {}) {
  if (payload?.message_id || payload?.messageId || payload?.chatId || payload?.chat_id) {
    return envelopeFromOpenClawMessageContext(payload);
  }
  if (payload?.message?.message_id && payload?.sender) {
    return envelopeFromFeishuEvent(payload, options);
  }
  return normalizeChannelEnvelope(payload);
}

function adapterConfigFromEnv() {
  if (process.env.JEA_CHANNEL_LARK_MOCK === '1') return { mock: true };
  if (process.env.JEA_CHANNEL_LARK_CONFIG_JSON) {
    try {
      return JSON.parse(process.env.JEA_CHANNEL_LARK_CONFIG_JSON);
    } catch (err) {
      throw new Error(`Invalid JEA_CHANNEL_LARK_CONFIG_JSON: ${err?.message || err}`);
    }
  }
  return null;
}

export async function sendOutboundMessage(outbound, { cfg = null } = {}) {
  const message = normalizeOutboundMessage(outbound);
  const resolvedCfg = cfg ?? adapterConfigFromEnv();
  if (resolvedCfg?.mock || message.metadata?.mock) {
    return {
      messageId: `mock-${Date.now()}`,
      chatId: message.target,
      mock: true,
    };
  }
  if (!resolvedCfg) {
    throw new Error('Missing openclaw-lark cfg. Set JEA_CHANNEL_LARK_CONFIG_JSON or use mock mode.');
  }
  const plugin = await loadOpenClawLark();
  if (message.card) {
    if (typeof plugin.sendCardFeishu !== 'function') {
      throw new Error('openclaw-lark sendCardFeishu export is unavailable');
    }
    return plugin.sendCardFeishu({
      cfg: resolvedCfg,
      to: message.target,
      card: message.card,
      replyToMessageId: message.reply_to_message_id ?? undefined,
      replyInThread: message.reply_in_thread,
    });
  }
  if (typeof plugin.sendMessageFeishu !== 'function') {
    throw new Error('openclaw-lark sendMessageFeishu export is unavailable');
  }
  return plugin.sendMessageFeishu({
    cfg: resolvedCfg,
    to: message.target,
    text: message.text,
    replyToMessageId: message.reply_to_message_id ?? undefined,
    threadId: message.thread_id ?? undefined,
    replyInThread: message.reply_in_thread,
  });
}
