import { join } from 'node:path';
import { runtimeForSubject } from '../../../infra/runtime-paths.mjs';
import { readJsonSafe, writeJsonFile } from '../../../infra/files.mjs';
import { recordChannelEvent } from '../../audit.mjs';
import { parseTextContent } from './parser.mjs';
import { subjectEnvSlug } from './config.mjs';
import { sanitizeFeishuError } from './errors.mjs';

export const DEFAULT_BIND_PHRASE = 'JEA BIND';
const BIND_FILE = 'feishu-operator-binding.json';

function readEnv(name) {
  if (!name) return '';
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

export function operatorBindingPath(root, subject) {
  const { runtimeRoot } = runtimeForSubject(root, subject);
  return join(runtimeRoot, 'data', 'channel', BIND_FILE);
}

/** @returns {object|null} */
export function readOperatorBinding(root, subject) {
  const data = readJsonSafe(operatorBindingPath(root, subject));
  if (!data?.open_id) return null;
  return data;
}

export function isUnresolvedOperatorId(id) {
  if (!id) return true;
  const s = String(id).trim();
  if (!s) return true;
  return /REPLACE/i.test(s);
}

export function resolveBindSettings(block = {}, subject = '') {
  const bind = block.bind ?? {};
  const slug = subjectEnvSlug(subject);
  const enabled = bind.enabled !== false && block.bind_enabled !== false;
  const phrase = String(bind.phrase ?? block.bind_phrase ?? DEFAULT_BIND_PHRASE).trim() || DEFAULT_BIND_PHRASE;
  const tokenEnv = bind.token_env ?? bind.tokenEnv ?? block.bind_token_env
    ?? `JEA_CHANNEL_FEISHU_${slug}_BIND_TOKEN`;
  return {
    enabled,
    phrase,
    token: readEnv(tokenEnv) || (bind.token ? String(bind.token).trim() : ''),
    tokenEnv: readEnv(tokenEnv) ? tokenEnv : (bind.token_env ?? bind.tokenEnv ?? null),
  };
}

/**
 * @param {string} text
 * @param {string} phrase
 */
export function matchesBindPhrase(text, phrase = DEFAULT_BIND_PHRASE) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const p = String(phrase).trim().replace(/\s+/g, ' ');
  return normalized.toLowerCase().startsWith(p.toLowerCase());
}

/**
 * @param {string} text
 * @param {{ phrase: string, token?: string }} bind
 */
export function parseBindCommand(text, bind) {
  const phrase = bind.phrase ?? DEFAULT_BIND_PHRASE;
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!matchesBindPhrase(normalized, phrase)) {
    return { matched: false, token: null };
  }
  const rest = normalized.slice(phrase.length).trim();
  return { matched: true, token: rest || null };
}

/**
 * @param {object} config - resolved Feishu config (incl. bind + operatorBinding)
 * @param {object} event - parsed message event
 */
export function validateBindAttempt(config, event) {
  const text = parseTextContent(event.content, event.messageType);
  const parsed = parseBindCommand(text, { phrase: config.bindPhrase, token: config.bindToken });
  if (!parsed.matched) {
    return { ok: false, code: 'not_bind_message' };
  }
  if (config.bindToken && parsed.token !== config.bindToken) {
    return { ok: false, code: 'bind_token_invalid' };
  }
  const senderOpenId = event.senderOpenId || event.senderId;
  if (!senderOpenId) {
    return { ok: false, code: 'sender_missing' };
  }
  const existing = config.operatorBinding;
  if (existing?.open_id && existing.open_id !== senderOpenId) {
    if (!config.bindToken || parsed.token !== config.bindToken) {
      return { ok: false, code: 'bind_occupied' };
    }
  }
  return { ok: true, openId: senderOpenId, userId: event.senderId || null, text, parsed };
}

export function applyOperatorBinding(root, subject, payload) {
  const record = {
    schema_version: 1,
    subject,
    open_id: payload.openId,
    user_id: payload.userId ?? null,
    chat_id: payload.chatId ?? null,
    bound_at: new Date().toISOString(),
    message_id: payload.messageId ?? null,
    bind_phrase: payload.bindPhrase ?? DEFAULT_BIND_PHRASE,
  };
  writeJsonFile(operatorBindingPath(root, subject), record);
  return record;
}

/**
 * Merge runtime binding into resolved config (allowFrom / defaultChatId).
 * @param {object} config
 */
export function mergeOperatorBinding(config, binding) {
  const allowFrom = Array.isArray(config.allowFrom) ? [...config.allowFrom] : [];
  const filtered = allowFrom.filter((id) => !isUnresolvedOperatorId(id));
  const defaultChatId = isUnresolvedOperatorId(config.defaultChatId) ? null : config.defaultChatId;

  if (binding?.open_id) {
    return {
      ...config,
      defaultChatId: binding.open_id,
      allowFrom: [binding.open_id],
      operatorBound: true,
    };
  }

  return {
    ...config,
    defaultChatId: defaultChatId || null,
    allowFrom: filtered,
    operatorBound: false,
  };
}

export function maskOpenId(openId) {
  if (!openId) return null;
  const s = String(openId);
  if (s.length <= 8) return `***${s.slice(-4)}`;
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function bindReplyText(code, config, extra = {}) {
  const phrase = config.bindPhrase ?? DEFAULT_BIND_PHRASE;
  switch (code) {
    case 'bind_success':
      return [
        `JEA [${config.subject}] 私聊已绑定。`,
        `open_id: ${extra.open_id}`,
        '之后系统通知与你的私聊将仅发往该账号。',
        `重新绑定：再次发送「${phrase}」${config.bindToken ? ' <口令>' : ''}。`,
      ].join('\n');
    case 'bind_token_invalid':
      return `绑定口令错误。请发送：${phrase}${config.bindToken ? ' <你的口令>' : ''}`;
    case 'bind_token_required':
      return `绑定需要口令。请发送：${phrase} <口令>（口令来自环境变量 ${config.bindTokenEnv ?? 'BIND_TOKEN'}）`;
    case 'bind_occupied':
      return '已有其他操作者绑定此机器人。若需覆盖，请使用正确口令发送绑定消息。';
    case 'bind_disabled':
      return '当前主体未启用飞书绑定。';
    default:
      return `绑定失败：${code}`;
  }
}

/**
 * Handle bind handshake in listener / ingest (no intelligence write).
 * @returns {Promise<{ handled: boolean, ok?: boolean, code?: string, binding?: object }>}
 */
export async function tryHandleFeishuBind(root, subject, event, { client, config } = {}) {
  if (!config?.bindEnabled) return { handled: false };
  if (event.chatType === 'group') {
    return { handled: false };
  }

  const text = parseTextContent(event.content, event.messageType);
  if (!matchesBindPhrase(text, config.bindPhrase)) {
    return { handled: false };
  }

  const parsed = parseBindCommand(text, { phrase: config.bindPhrase });
  if (config.bindToken && !parsed.token) {
    await sendBindReply(client, event, bindReplyText('bind_token_required', config));
    recordChannelEvent(root, subject, {
      type: 'feishu_bind_failed',
      status: 'error',
      error_code: 'bind_token_required',
    });
    return { handled: true, ok: false, code: 'bind_token_required' };
  }

  const validation = validateBindAttempt(config, event);
  if (!validation.ok) {
    const replyCode = validation.code === 'bind_token_invalid' ? 'bind_token_invalid' : validation.code;
    await sendBindReply(client, event, bindReplyText(replyCode, config));
    recordChannelEvent(root, subject, {
      type: 'feishu_bind_failed',
      status: 'error',
      error_code: validation.code,
    });
    return { handled: true, ok: false, code: validation.code };
  }

  const binding = applyOperatorBinding(root, subject, {
    openId: validation.openId,
    userId: validation.userId,
    chatId: event.chatId,
    messageId: event.messageId,
    bindPhrase: config.bindPhrase,
  });

  const merged = mergeOperatorBinding(config, binding);
  await sendBindReply(client, event, bindReplyText('bind_success', merged, { open_id: binding.open_id }));
  recordChannelEvent(root, subject, {
    type: 'feishu_operator_bound',
    status: 'ok',
    open_id: maskOpenId(binding.open_id),
    message_id: event.messageId,
    rebound: Boolean(config.operatorBinding?.open_id),
  });

  return { handled: true, ok: true, code: 'bind_success', binding, mergedConfig: merged };
}

async function sendBindReply(client, event, text) {
  if (!client || !text) return;
  const receiveId = event.senderOpenId || event.senderId;
  if (!receiveId) return;
  try {
    await client.sendText({
      receiveId,
      receiveIdType: receiveId.startsWith('ou_') ? 'open_id' : 'open_id',
      text,
    });
  } catch (err) {
    console.error('[FeishuBind] reply failed:', sanitizeFeishuError(err, client?.config));
  }
}

export function operatorBindingForApi(binding, config) {
  return {
    bound: Boolean(binding?.open_id),
    open_id: binding?.open_id ? maskOpenId(binding.open_id) : null,
    bound_at: binding?.bound_at ?? null,
    bind_enabled: Boolean(config?.bindEnabled),
    bind_phrase: config?.bindPhrase ?? DEFAULT_BIND_PHRASE,
    bind_token_required: Boolean(config?.bindToken),
  };
}
