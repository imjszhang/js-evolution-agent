import { recordChannelEvent } from '../../audit.mjs';
import { writePendingInbound } from '../../state.mjs';
import { enqueueChannelTask } from '../../task-queue.mjs';
import { envelopeFromFeishuEvent } from './parser.mjs';
import { resolveFeishuConfig } from './config.mjs';
import { FeishuClient } from './client.mjs';
import { FeishuPolicy } from './policy.mjs';
import { FeishuMonitor } from './monitor.mjs';
import { tryHandleFeishuBind } from './binding.mjs';
import { resolveFeishuConfig as reloadFeishuConfig } from './config.mjs';

/** @type {Map<string, { monitor: FeishuMonitor, client: FeishuClient, config: object }>} */
const activeListeners = new Map();

function listenerKey(root, subject) {
  return `${root}\u0000${subject}`;
}

export function getFeishuListenerStatus(root, subject) {
  const entry = activeListeners.get(listenerKey(root, subject));
  if (!entry) return { running: false, connected: false, botOpenId: null };
  const status = entry.monitor.getStatus();
  return {
    running: status.isRunning,
    connected: status.connected,
    botOpenId: status.botOpenId,
    enabled: entry.config.listenerEnabled,
  };
}

/**
 * Start Feishu WebSocket listener for a subject (channel domain sidecar).
 */
export async function startFeishuListener(root, subject, options = {}) {
  const config = resolveFeishuConfig(root, subject, options);
  if (!config.listenerEnabled) {
    return { started: false, reason: 'listener_disabled' };
  }
  if (config.mock) {
    return { started: false, reason: 'mock_mode' };
  }
  if (!config.appId || !config.appSecret) {
    return { started: false, reason: 'credentials_missing' };
  }

  const key = listenerKey(root, subject);
  if (activeListeners.has(key)) {
    return { started: false, reason: 'already_running', status: getFeishuListenerStatus(root, subject) };
  }

  const client = new FeishuClient(config);
  let liveConfig = config;
  const policy = new FeishuPolicy(liveConfig);
  let botOpenId = null;

  function syncPolicyFromConfig(cfg) {
    policy.updateConfig({
      dmPolicy: cfg.dmPolicy,
      allowFrom: cfg.allowFrom,
      groupPolicy: cfg.groupPolicy,
      groupAllowFrom: cfg.groupAllowFrom,
      requireMention: cfg.requireMention,
      bindEnabled: cfg.bindEnabled,
      bindPhrase: cfg.bindPhrase,
      bindToken: cfg.bindToken,
    });
  }

  const monitor = new FeishuMonitor({
    client,
    policy,
    onConnectionChange: (state) => {
      if (state.botOpenId) botOpenId = state.botOpenId;
      recordChannelEvent(root, subject, {
        type: state.connected ? 'feishu_listener_connected' : 'feishu_listener_disconnected',
        status: 'ok',
        bot_open_id: state.botOpenId ?? null,
      });
    },
    onMessage: async (event) => {
      const bindResult = await tryHandleFeishuBind(root, subject, event, { client, config: liveConfig });
      if (bindResult.handled) {
        if (bindResult.ok) {
          liveConfig = reloadFeishuConfig(root, subject);
          syncPolicyFromConfig(liveConfig);
        }
        return;
      }
      const envelope = envelopeFromFeishuEvent(
        { sender: { sender_id: { open_id: event.senderOpenId, user_id: event.senderId } }, message: {
          message_id: event.messageId,
          chat_id: event.chatId,
          chat_type: event.chatType,
          message_type: event.messageType,
          content: event.content,
          mentions: event.mentions,
          root_id: event.rootId,
          parent_id: event.parentId,
        } },
        { botOpenId },
      );
      writePendingInbound(root, subject, envelope, { label: 'feishu-ws' });
      recordChannelEvent(root, subject, {
        type: 'channel_message_received',
        status: 'ok',
        message_id: envelope.message_id,
        chat_id: envelope.chat_id,
        channel: 'feishu',
      });
      enqueueChannelTask(root, subject, {
        type: 'channel_ingest',
        priority: 20,
        idempotencyKey: `${subject}:channel_ingest:feishu:${envelope.message_id}`,
      });
    },
  });

  try {
    await monitor.start();
    activeListeners.set(key, { monitor, client, get config() { return liveConfig; } });
    recordChannelEvent(root, subject, {
      type: 'feishu_listener_started',
      status: 'ok',
      app_id: config.appId ? `***${config.appId.slice(-4)}` : null,
    });
    return { started: true, status: getFeishuListenerStatus(root, subject) };
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'feishu_listener_start_failed',
      status: 'error',
      error: err?.message || String(err),
      error_code: err?.code ?? null,
    });
    return { started: false, reason: err?.message || String(err) };
  }
}

export async function stopFeishuListener(root, subject) {
  const key = listenerKey(root, subject);
  const entry = activeListeners.get(key);
  if (!entry) return { stopped: false, reason: 'not_running' };
  try {
    await entry.monitor.stop();
  } catch {
    // ignore
  }
  activeListeners.delete(key);
  recordChannelEvent(root, subject, {
    type: 'feishu_listener_stopped',
    status: 'ok',
  });
  return { stopped: true };
}

export async function stopAllFeishuListeners() {
  const keys = [...activeListeners.keys()];
  for (const key of keys) {
    const idx = key.indexOf('\u0000');
    const root = key.slice(0, idx);
    const subject = key.slice(idx + 1);
    await stopFeishuListener(root, subject);
  }
}
