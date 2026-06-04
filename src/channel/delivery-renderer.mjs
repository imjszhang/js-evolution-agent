import { normalizeOutboundMessage } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';

const CARD_MD_LIMIT = 2000;
const TEXT_OVERFLOW_THRESHOLD = 6000;

function statusTemplate(status) {
  if (status === 'completed') return 'green';
  if (status === 'deferred' || status === 'requires_human_review') return 'orange';
  return 'red';
}

function truncate(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}

/**
 * Render a deliverable into a Feishu interactive card. The card carries the
 * (possibly truncated) deliverable body verbatim via lark_md, plus a metadata note.
 */
export function renderDeliveryCard(deliverable, { bodyForCard } = {}) {
  const title = truncate(deliverable.objective || 'Agent 调研交付', 100) || 'Agent 调研交付';
  const content = String(bodyForCard ?? deliverable.body ?? '').trim() || '(无内容)';
  const metaParts = [
    `状态: ${deliverable.status ?? 'unknown'}`,
    `provider: ${deliverable.provider ?? 'unknown'}`,
    deliverable.deliverable_id,
  ].filter(Boolean);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: statusTemplate(deliverable.status),
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'lark_md', content: metaParts.join(' · ') }] },
    ],
  };
}

function chooseFormat(bodyLength) {
  if (bodyLength <= CARD_MD_LIMIT) return 'card';
  if (bodyLength <= TEXT_OVERFLOW_THRESHOLD) return 'card+text';
  return 'card+text_truncated';
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

  const body = String(deliverable.body ?? '').trim();
  const format = chooseFormat(body.length);
  const baseMeta = {
    channel_deliverable: true,
    deliverable_id: deliverable.deliverable_id,
    channel_agent_run_id: deliverable.channel_agent_run_id ?? null,
    delivery_format: format,
  };
  const deliveryKey = deliverable.channel_agent_run_id || deliverable.deliverable_id;

  const messages = [];

  const cardBody = body.length <= CARD_MD_LIMIT
    ? body
    : `${truncate(body, CARD_MD_LIMIT)}\n\n…（完整内容已归档：${deliverable.deliverable_id}${format === 'card+text' ? '，见后续消息' : ''}）`;
  const card = renderDeliveryCard(deliverable, { bodyForCard: cardBody });

  messages.push(normalizeOutboundMessage({
    channel: routed.transport,
    target: routed.target,
    card,
    text: deliverable.tldr || deliverable.objective || 'agent deliverable',
    subject,
    reason: 'channel_deliverable',
    idempotency_key: `channel-deliverable:${subject}:${deliveryKey}:1-card`,
    metadata: { ...baseMeta, part: 'card' },
  }));

  if (format === 'card+text') {
    // Send the full body via sendText (not reply) so all chunks are delivered;
    // FeishuSender.replyText only emits the first chunk and drops the rest.
    messages.push(normalizeOutboundMessage({
      channel: routed.transport,
      target: routed.target,
      text: body,
      subject,
      reason: 'channel_deliverable_body',
      idempotency_key: `channel-deliverable:${subject}:${deliveryKey}:2-body`,
      metadata: { ...baseMeta, part: 'body' },
    }));
  }

  return { messages, format, target: routed.target, transport: routed.transport };
}
