import { normalizeOutboundMessage } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';

function truncate(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}

export function renderDeliveryDocument(deliverable) {
  const title = truncate(deliverable.objective || 'Agent 调研交付', 100) || 'Agent 调研交付';
  const body = String(deliverable.body ?? '').trim() || '(无内容)';
  const metaLines = [
    `> 状态：${deliverable.status ?? 'unknown'}`,
    `> Provider：${deliverable.provider ?? 'unknown'}`,
    `> Deliverable：${deliverable.deliverable_id}`,
    deliverable.channel_agent_run_id ? `> Agent Run：${deliverable.channel_agent_run_id}` : null,
  ].filter(Boolean);
  return {
    title,
    markdown: `${metaLines.join('\n')}\n\n${body}`,
    message_text: `交付物已生成：${title}`,
  };
}

/**
 * Adapt a persisted Markdown deliverable into one or more outbox messages.
 * Does NOT rewrite content; only adapts format for the target channel.
 */
export async function renderDeliveryToOutbox(root, subject, deliverable, request = {}, {
  transport = null,
} = {}) {
  const routed = await resolveOutboundTarget(root, subject, request.target ?? 'channel_default', { transport });
  if (!routed.target) {
    return { messages: [], format: null, reason: 'missing_target', target: null, transport: routed.transport };
  }

  const format = 'feishu_doc';
  const baseMeta = {
    channel_deliverable: true,
    deliverable_id: deliverable.deliverable_id,
    channel_agent_run_id: deliverable.channel_agent_run_id ?? null,
    delivery_format: format,
  };
  const deliveryKey = deliverable.channel_agent_run_id || deliverable.deliverable_id;

  const document = renderDeliveryDocument(deliverable);

  const messages = [normalizeOutboundMessage({
    channel: routed.transport,
    target: routed.target,
    document,
    text: document.message_text,
    subject,
    reason: 'channel_deliverable_document',
    idempotency_key: `channel-deliverable:${subject}:${deliveryKey}:document`,
    metadata: { ...baseMeta, part: 'document' },
  })];

  return { messages, format, target: routed.target, transport: routed.transport };
}
