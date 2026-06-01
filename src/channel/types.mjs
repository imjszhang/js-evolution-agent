export const CHANNEL_TASK_TYPES = Object.freeze([
  'channel_inbound',
  'channel_ingest',
  'channel_watch',
  'channel_notify',
  'channel_retry',
]);

export const CHANNEL_DIRECTIONS = new Set(['inbound', 'outbound']);

export function isChannelTaskType(type) {
  return CHANNEL_TASK_TYPES.includes(type);
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeChannelEnvelope(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Channel envelope must be a JSON object');
  }
  const channel = String(input.channel ?? 'feishu');
  const messageId = String(input.message_id ?? input.messageId ?? '').trim();
  if (!messageId) throw new Error('Channel envelope requires message_id');
  const chatId = String(input.chat_id ?? input.chatId ?? '').trim();
  if (!chatId) throw new Error('Channel envelope requires chat_id');
  const content = String(input.content ?? input.text ?? '');
  return {
    schema_version: input.schema_version ?? 1,
    channel,
    adapter: input.adapter ?? 'feishu',
    direction: input.direction ?? 'inbound',
    message_id: messageId,
    chat_id: chatId,
    chat_type: input.chat_type ?? input.chatType ?? null,
    sender_id: input.sender_id ?? input.senderId ?? null,
    sender_name: input.sender_name ?? input.senderName ?? null,
    thread_id: input.thread_id ?? input.threadId ?? null,
    parent_id: input.parent_id ?? input.parentId ?? null,
    root_id: input.root_id ?? input.rootId ?? null,
    content,
    content_type: input.content_type ?? input.contentType ?? 'text',
    resources: Array.isArray(input.resources) ? input.resources : [],
    mentions: Array.isArray(input.mentions) ? input.mentions : [],
    received_at: input.received_at ?? nowIso(),
    raw: input.raw ?? input.rawMessage ?? input,
    metadata: input.metadata ?? {},
  };
}

export function normalizeOutboundMessage(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Outbound message must be a JSON object');
  }
  const channel = String(input.channel ?? 'feishu');
  const target = String(input.target ?? input.to ?? input.chat_id ?? '').trim();
  if (!target) throw new Error('Outbound message requires target');
  const text = String(input.text ?? input.content ?? '').trim();
  if (!text && !input.card) throw new Error('Outbound message requires text or card');
  return {
    schema_version: input.schema_version ?? 1,
    id: input.id ?? null,
    idempotency_key: input.idempotency_key ?? null,
    channel,
    adapter: input.adapter ?? 'feishu',
    target,
    text,
    card: input.card ?? null,
    reply_to_message_id: input.reply_to_message_id ?? input.replyToMessageId ?? null,
    thread_id: input.thread_id ?? input.threadId ?? null,
    reply_in_thread: Boolean(input.reply_in_thread ?? input.replyInThread ?? false),
    subject: input.subject ?? null,
    reason: input.reason ?? null,
    priority: input.priority ?? 'medium',
    created_at: input.created_at ?? nowIso(),
    metadata: input.metadata ?? {},
  };
}
