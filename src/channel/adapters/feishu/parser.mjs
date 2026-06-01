import { normalizeChannelEnvelope, nowIso } from '../../types.mjs';

export function parseTextContent(content, messageType = 'text') {
  if (!content) return '';
  if (messageType !== 'text') return String(content);
  try {
    const parsed = JSON.parse(content);
    return parsed.text ?? String(content);
  } catch {
    return String(content);
  }
}

/**
 * Parsed Feishu message event (transport layer, not ChannelEnvelope).
 */
export function parseFeishuMessageEvent(data = {}) {
  const sender = data?.sender ?? {};
  const message = data?.message ?? {};
  return {
    senderId: sender.sender_id?.user_id || sender.sender_id?.open_id || '',
    senderOpenId: sender.sender_id?.open_id || '',
    senderType: sender.sender_type || '',
    messageId: message.message_id || '',
    chatId: message.chat_id || '',
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    messageType: message.message_type || 'text',
    content: message.content || '',
    rootId: message.root_id || null,
    parentId: message.parent_id || null,
    mentions: message.mentions || [],
    raw: data,
  };
}

export function envelopeFromFeishuEvent(data = {}, { botOpenId = null } = {}) {
  const event = parseFeishuMessageEvent(data);
  if (!event.messageId || !event.chatId) {
    throw new Error('Feishu message event missing message_id or chat_id');
  }
  const text = parseTextContent(event.content, event.messageType);
  return normalizeChannelEnvelope({
    channel: 'feishu',
    adapter: 'feishu',
    direction: 'inbound',
    message_id: event.messageId,
    chat_id: event.chatId,
    chat_type: event.chatType,
    sender_id: event.senderOpenId || event.senderId,
    thread_id: event.rootId,
    parent_id: event.parentId,
    content: text,
    content_type: event.messageType,
    mentions: event.mentions,
    received_at: nowIso(),
    raw: event.raw,
    metadata: { bot_open_id: botOpenId },
  });
}

export function envelopeFromMessageContext(ctx = {}) {
  return normalizeChannelEnvelope({
    channel: 'feishu',
    adapter: 'feishu',
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

/**
 * @param {object} payload
 * @param {object} [options]
 */
export async function normalizeInboundPayload(payload = {}, options = {}) {
  if (payload?.schema_version && payload?.message_id && payload?.chat_id) {
    return normalizeChannelEnvelope(payload);
  }
  if (payload?.message_id || payload?.messageId || payload?.chatId || payload?.chat_id) {
    return envelopeFromMessageContext(payload);
  }
  if (payload?.message?.message_id && payload?.sender) {
    return envelopeFromFeishuEvent(payload, { botOpenId: options.botOpenId ?? null });
  }
  return normalizeChannelEnvelope(payload);
}
