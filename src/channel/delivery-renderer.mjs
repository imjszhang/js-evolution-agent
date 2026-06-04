import { normalizeOutboundMessage } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';

const RICH_LENGTH_THRESHOLD = 600;
const TEXT_FALLBACK_LIMIT = 1500;

/** Media a channel adapter can carry. Feishu currently supports text + document. */
export const DEFAULT_CHANNEL_CAPABILITIES = Object.freeze(['text', 'document']);

function truncate(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return value.slice(0, limit).trimEnd();
}

/**
 * Whether a body needs rich rendering (a document) rather than a plain message.
 * Long content, code fences, tables, or multiple headings warrant a document.
 */
export function hasRichFormatting(text) {
  const value = String(text ?? '');
  if (value.length > RICH_LENGTH_THRESHOLD) return true;
  if (/```/.test(value)) return true;
  if (/^\s*\|.*\|/m.test(value)) return true;
  if ((value.match(/^#{1,6}\s/gm) || []).length >= 2) return true;
  return false;
}

function serializeData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function renderDeliveryDocument(deliverable) {
  const title = truncate(deliverable.title || deliverable.objective || 'Agent 调研交付', 100)
    || 'Agent 调研交付';
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

function documentItem(deliverable) {
  const document = renderDeliveryDocument(deliverable);
  const fallbackText = [document.message_text, truncate(deliverable.body, TEXT_FALLBACK_LIMIT)]
    .filter(Boolean)
    .join('\n\n');
  return {
    medium: 'document',
    payload: document,
    fallback_medium: 'text',
    fallback_payload: { text: fallbackText || document.message_text },
  };
}

function textItem(text) {
  const value = String(text ?? '').trim();
  return {
    medium: 'text',
    payload: { text: value },
    fallback_medium: 'text',
    fallback_payload: { text: value },
  };
}

/**
 * Resolve the delivery items for a persisted deliverable. The deliverable.type
 * declares intent; content characteristics decide the carrying medium. Returns
 * an ordered list of `{ medium, payload, fallback_medium, fallback_payload }`.
 */
export function resolveDeliveryItems(deliverable = {}) {
  const type = deliverable.type ?? 'message';
  const body = String(deliverable.body ?? '').trim();
  const summary = String(deliverable.summary ?? deliverable.tldr ?? '').trim();

  if (type === 'none') {
    return summary ? [textItem(summary)] : [];
  }

  if (type === 'link') {
    const url = String(deliverable.url ?? '').trim();
    const line = [summary, url].filter(Boolean).join('\n');
    return line ? [textItem(line)] : [];
  }

  if (type === 'document') {
    return [documentItem(deliverable)];
  }

  if (type === 'data') {
    const dataText = serializeData(deliverable.data);
    if (dataText.length > RICH_LENGTH_THRESHOLD || hasRichFormatting(body)) {
      return [documentItem(deliverable)];
    }
    const text = [summary, dataText].filter(Boolean).join('\n\n');
    return text ? [textItem(text)] : [documentItem(deliverable)];
  }

  // message (default): short/simple -> text, otherwise upgrade to a document.
  if (hasRichFormatting(body)) {
    return [documentItem(deliverable)];
  }
  const text = body || summary;
  return text ? [textItem(text)] : [];
}

/** Downgrade an item to its fallback when the channel cannot carry its medium. */
function applyCapabilities(item, capabilities) {
  if (capabilities.includes(item.medium)) return item;
  const fallbackMedium = item.fallback_medium ?? 'text';
  return {
    medium: fallbackMedium,
    payload: item.fallback_payload ?? { text: '' },
    fallback_medium: fallbackMedium,
    fallback_payload: item.fallback_payload ?? { text: '' },
    downgraded_from: item.medium,
  };
}

/**
 * Adapt a persisted deliverable into one or more outbox messages.
 * The renderer decides the medium; adapters only send. Items whose medium the
 * channel cannot carry are downgraded to their fallback.
 */
export async function renderDeliveryToOutbox(root, subject, deliverable, request = {}, {
  transport = null,
  capabilities = DEFAULT_CHANNEL_CAPABILITIES,
} = {}) {
  const routed = await resolveOutboundTarget(root, subject, request.target ?? 'channel_default', { transport });
  if (!routed.target) {
    return { messages: [], format: null, items: [], reason: 'missing_target', target: null, transport: routed.transport };
  }

  const rawItems = resolveDeliveryItems(deliverable);
  if (!rawItems.length) {
    return {
      messages: [],
      format: null,
      items: [],
      reason: 'no_delivery_items',
      target: routed.target,
      transport: routed.transport,
    };
  }

  const items = rawItems.map((item) => applyCapabilities(item, capabilities));
  const deliveryKey = deliverable.channel_agent_run_id || deliverable.deliverable_id;
  const baseMeta = {
    channel_deliverable: true,
    deliverable_id: deliverable.deliverable_id,
    channel_agent_run_id: deliverable.channel_agent_run_id ?? null,
    deliverable_type: deliverable.type ?? 'message',
  };

  const messages = items.map((item, index) => {
    const meta = {
      ...baseMeta,
      delivery_format: item.medium,
      delivery_item: item.medium,
      part: item.medium,
      item_index: index,
      ...(item.downgraded_from ? { downgraded_from: item.downgraded_from } : {}),
    };
    const common = {
      channel: routed.transport,
      target: routed.target,
      subject,
      reason: `channel_deliverable_${item.medium}`,
      idempotency_key: `channel-deliverable:${subject}:${deliveryKey}:${item.medium}:${index}`,
      metadata: meta,
    };
    if (item.medium === 'document') {
      return normalizeOutboundMessage({
        ...common,
        document: item.payload,
        text: item.payload.message_text,
      });
    }
    return normalizeOutboundMessage({ ...common, text: item.payload.text });
  });

  const format = items.length === 1 ? items[0].medium : 'mixed';
  // The renderer is the authority on medium: a deliverable the agent declared as
  // a plain `message` but whose content is rich gets upgraded to a document.
  // Surface that override so it can be audited (agent type-judgement quality).
  const declaredType = deliverable.type ?? 'message';
  const primaryMedium = items[0]?.medium ?? null;
  const typeOverridden = declaredType !== 'document' && primaryMedium === 'document';
  return {
    messages,
    format,
    items,
    target: routed.target,
    transport: routed.transport,
    declared_type: declaredType,
    resolved_medium: primaryMedium,
    type_overridden: typeOverridden,
  };
}
