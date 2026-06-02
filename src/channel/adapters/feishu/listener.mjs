import { createHash } from 'node:crypto';
import { loadProjectEnv } from '../../../cli/utils/project.mjs';
import { recordChannelEvent } from '../../audit.mjs';
import {
  consumeChannelReloadRequest,
  writeChannelReloadState,
  writePendingInbound,
} from '../../state.mjs';
import { enqueueChannelTask } from '../../task-queue.mjs';
import { envelopeFromFeishuEvent } from './parser.mjs';
import { resolveFeishuConfig } from './config.mjs';
import { FeishuClient } from './client.mjs';
import { FeishuPolicy } from './policy.mjs';
import { FeishuMonitor } from './monitor.mjs';
import { tryHandleFeishuBind } from './binding.mjs';

/** @type {Map<string, {
 *   monitor: FeishuMonitor,
 *   client: FeishuClient,
 *   policy: FeishuPolicy,
 *   configFingerprint: string,
 *   startedAt: string,
 *   lastReloadAt: string|null,
 *   lastReloadReason: string|null,
 *   get config(): object,
 * }>} */
const activeListeners = new Map();

function listenerKey(root, subject) {
  return `${root}\u0000${subject}`;
}

function hashSecret(secret) {
  if (!secret) return '';
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

export function feishuListenerConfigFingerprint(config = {}) {
  return [
    config.enabled ? '1' : '0',
    config.listenerEnabled ? '1' : '0',
    config.mock ? '1' : '0',
    config.appId ?? '',
    hashSecret(config.appSecret),
    config.domain ?? 'feishu',
    config.connectionMode ?? 'websocket',
    config.encryptKey ?? '',
    config.verificationToken ?? '',
  ].join('|');
}

function syncPolicyFromConfig(policy, cfg) {
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

function shouldRunListener(config) {
  return Boolean(
    config.listenerEnabled
    && !config.mock
    && config.appId
    && config.appSecret,
  );
}

function getListenerEntry(root, subject) {
  return activeListeners.get(listenerKey(root, subject)) ?? null;
}

export function getFeishuListenerStatus(root, subject) {
  const entry = getListenerEntry(root, subject);
  if (!entry) {
    return {
      running: false,
      connected: false,
      botOpenId: null,
      config_fingerprint: null,
      started_at: null,
      last_reload_at: null,
      last_reload_reason: null,
    };
  }
  const status = entry.monitor.getStatus();
  return {
    running: status.isRunning,
    connected: status.connected,
    botOpenId: status.botOpenId,
    enabled: entry.config.listenerEnabled,
    config_fingerprint: entry.configFingerprint,
    started_at: entry.startedAt,
    last_reload_at: entry.lastReloadAt,
    last_reload_reason: entry.lastReloadReason,
  };
}

function attachLiveConfig(entry, initialConfig) {
  let liveConfig = initialConfig;
  return {
    get config() {
      return liveConfig;
    },
    setConfig(next) {
      liveConfig = next;
    },
  };
}

async function createAndStartListener(root, subject, config, { reloadReason = null } = {}) {
  const key = listenerKey(root, subject);
  const client = new FeishuClient(config);
  const policy = new FeishuPolicy(config);
  let botOpenId = null;
  const live = attachLiveConfig({}, config);
  const configFingerprint = feishuListenerConfigFingerprint(config);
  const startedAt = new Date().toISOString();

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
      const bindResult = await tryHandleFeishuBind(root, subject, event, {
        client,
        config: live.config,
      });
      if (bindResult.handled) {
        if (bindResult.ok) {
          live.setConfig(resolveFeishuConfig(root, subject));
          syncPolicyFromConfig(policy, live.config);
        }
        return;
      }
      const envelope = envelopeFromFeishuEvent(
        {
          sender: { sender_id: { open_id: event.senderOpenId, user_id: event.senderId } },
          message: {
            message_id: event.messageId,
            chat_id: event.chatId,
            chat_type: event.chatType,
            message_type: event.messageType,
            content: event.content,
            mentions: event.mentions,
            root_id: event.rootId,
            parent_id: event.parentId,
          },
        },
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
        type: 'channel_presence',
        priority: 15,
        input: { run_ingest: true },
        idempotencyKey: `${subject}:channel_presence:feishu:${envelope.message_id}`,
      });
    },
  });

  await monitor.start();
  activeListeners.set(key, {
    monitor,
    client,
    policy,
    live,
    configFingerprint,
    startedAt,
    lastReloadAt: reloadReason ? startedAt : null,
    lastReloadReason: reloadReason,
    get config() {
      return live.config;
    },
  });
  recordChannelEvent(root, subject, {
    type: reloadReason ? 'feishu_listener_reloaded' : 'feishu_listener_started',
    status: 'ok',
    app_id: config.appId ? `***${config.appId.slice(-4)}` : null,
    reason: reloadReason,
    config_fingerprint: configFingerprint,
  });
  writeChannelReloadState(root, subject, {
    last_reload_at: reloadReason ? startedAt : null,
    last_reload_reason: reloadReason,
    last_error: null,
    config_fingerprint: configFingerprint,
  });
  return { started: true, status: getFeishuListenerStatus(root, subject) };
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

  try {
    return await createAndStartListener(root, subject, config, {
      reloadReason: options.reloadReason ?? null,
    });
  } catch (err) {
    writeChannelReloadState(root, subject, {
      last_error: err?.message || String(err),
    });
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

export async function reloadFeishuListener(root, subject, reason = 'reload') {
  await stopFeishuListener(root, subject);
  const result = await startFeishuListener(root, subject, { reloadReason: reason });
  if (result.started) {
    recordChannelEvent(root, subject, {
      type: 'channel_config_reloaded',
      status: 'ok',
      reason,
      config_fingerprint: result.status?.config_fingerprint ?? null,
    });
  }
  return result;
}

function syncListenerSoftConfig(entry, config) {
  entry.live.setConfig(config);
  syncPolicyFromConfig(entry.policy, config);
  if (entry.client?.updateConfig) {
    entry.client.updateConfig({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      encryptKey: config.encryptKey,
      verificationToken: config.verificationToken,
    });
  }
}

export async function ensureFeishuListener(root, subject, options = {}) {
  const config = resolveFeishuConfig(root, subject, options);
  const fingerprint = feishuListenerConfigFingerprint(config);
  const entry = getListenerEntry(root, subject);
  const run = shouldRunListener(config);

  if (!run) {
    if (entry) {
      await stopFeishuListener(root, subject);
      return {
        action: 'stopped',
        reason: !config.listenerEnabled
          ? 'listener_disabled'
          : config.mock
            ? 'mock_mode'
            : 'credentials_missing',
      };
    }
    return {
      action: 'idle',
      reason: !config.listenerEnabled
        ? 'listener_disabled'
        : config.mock
          ? 'mock_mode'
          : 'credentials_missing',
      fingerprint,
    };
  }

  if (entry) {
    if (entry.configFingerprint === fingerprint) {
      syncListenerSoftConfig(entry, config);
      return { action: 'unchanged', fingerprint };
    }
    const reloadResult = await reloadFeishuListener(
      root,
      subject,
      options.reason ?? 'config_changed',
    );
    return {
      action: reloadResult.started ? 'reloaded' : 'reload_failed',
      fingerprint,
      ...reloadResult,
    };
  }

  const startResult = await startFeishuListener(root, subject, options);
  return {
    action: startResult.started ? 'started' : 'start_failed',
    fingerprint,
    ...startResult,
  };
}

export async function refreshChannelFeishuListener(root, subject, options = {}) {
  if (options.noFeishuListener) {
    return { skipped: true, reason: 'listener_disabled_flag' };
  }
  loadProjectEnv(root);
  const reloadRequest = consumeChannelReloadRequest(root, subject);
  const reason = reloadRequest?.reason ?? options.reason ?? 'periodic_check';
  const result = await ensureFeishuListener(root, subject, {
    ...options,
    reason,
  });
  return {
    reload_request: reloadRequest,
    ...result,
  };
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
