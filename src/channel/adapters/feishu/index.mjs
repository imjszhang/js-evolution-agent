import { normalizeOutboundMessage } from '../../types.mjs';
import { resolveFeishuConfig, assertFeishuCredentials } from './config.mjs';
import { normalizeInboundPayload } from './parser.mjs';
import { FeishuClient } from './client.mjs';
import { FeishuSender } from './sender.mjs';

export { resolveFeishuConfig, feishuConfigForApi, assertFeishuCredentials, subjectEnvSlug } from './config.mjs';
export { normalizeInboundPayload, envelopeFromFeishuEvent, envelopeFromMessageContext } from './parser.mjs';
export { startFeishuListener, stopFeishuListener, getFeishuListenerStatus, stopAllFeishuListeners } from './listener.mjs';
export { resolveIdType, normalizeTarget } from './sender.mjs';

/** @type {Map<string, import('./sender.mjs').FeishuSender>} */
const senderCache = new Map();

function senderCacheKey(config) {
  return [
    config.subject ?? '',
    config.appId ?? '',
    config.appSecret ?? '',
    config.domain ?? '',
    config.mock ? '1' : '0',
  ].join('|');
}

async function getSender(config) {
  if (config.mock) return null;
  assertFeishuCredentials(config);
  const key = senderCacheKey(config);
  let sender = senderCache.get(key);
  if (!sender) {
    const client = new FeishuClient(config);
    sender = new FeishuSender(client, config);
    senderCache.set(key, sender);
  }
  return sender;
}

/**
 * @param {object} outbound
 * @param {object} [options]
 * @param {object} [options.cfg]
 * @param {string} [options.root]
 * @param {string} [options.subject]
 */
export async function sendOutboundMessage(outbound, options = {}) {
  const message = normalizeOutboundMessage(outbound);
  const cfg = options.cfg ?? (options.root && options.subject
    ? resolveFeishuConfig(options.root, options.subject)
    : resolveFeishuConfig(process.cwd(), process.env.JEA_SUBJECT || 'default'));

  if (cfg.mock || message.metadata?.mock) {
    return {
      messageId: `mock-${Date.now()}`,
      chatId: message.target,
      mock: true,
    };
  }

  const sender = await getSender(cfg);
  if (message.card) {
    const result = await sender.sendCard(message.target, message.card);
    return {
      messageId: result.messageId,
      chatId: message.target,
      chunks: 1,
    };
  }
  if (message.reply_to_message_id) {
    const result = await sender.replyText(message.reply_to_message_id, message.text);
    return {
      messageId: result.messageIds?.[0],
      chatId: message.target,
      chunks: result.chunks,
    };
  }
  const result = await sender.sendText(message.target, message.text);
  return {
    messageId: result.messageIds?.[0],
    chatId: message.target,
    chunks: result.chunks,
  };
}
