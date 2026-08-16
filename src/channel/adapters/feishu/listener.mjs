import { createHash } from 'node:crypto';
import { loadProjectEnv } from '../../../infra/project.mjs';
import { recordChannelEvent } from '../../audit.mjs';
import {
  consumeChannelReloadRequest,
  writeChannelReloadState,
  writePendingInbound,
} from '../../state.mjs';
import { enqueueClassifierIfPendingInbound } from '../../wake.mjs';
import { envelopeFromFeishuEvent } from './parser.mjs';
import { resolveFeishuConfig } from './config.mjs';
import { FeishuClient } from './client.mjs';
import { FeishuPolicy } from './policy.mjs';
import { FeishuMonitor } from './monitor.mjs';
import { tryHandleFeishuBind } from './binding.mjs';
import { runWithTimeout } from '../../async-utils.mjs';

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
const listenerOperations = new Map();
const listenerStates = new Map();
const listenerGenerations = new Map();

function listenerKey(root, subject) {
  return `${root}\u0000${subject}`;
}

function sanitizeError(error, config = {}) {
  let message = error?.message || String(error);
  for (const secret of [config.appSecret, config.bindToken, config.encryptKey, config.verificationToken]) {
    if (secret) message = message.replaceAll(String(secret), '[REDACTED]');
  }
  return message
    .replace(/authorization\s*[:=]\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/(app[_-]?secret|bind[_-]?token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function serializeListener(root, subject, operation) {
  const key = listenerKey(root, subject);
  const previous = listenerOperations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  listenerOperations.set(key, current);
  return current.finally(() => {
    if (listenerOperations.get(key) === current) listenerOperations.delete(key);
  });
}

function setListenerState(root, subject, state, extra = {}) {
  const record = {
    state,
    connected: state === 'connected',
    updated_at: new Date().toISOString(),
    ...extra,
  };
  listenerStates.set(listenerKey(root, subject), record);
  writeChannelReloadState(root, subject, {
    listener_state: state,
    listener_state_at: record.updated_at,
    last_error_code: record.last_error_code ?? null,
    last_error_at: record.last_error_at ?? null,
  });
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
    hashSecret(config.encryptKey),
    hashSecret(config.verificationToken),
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
    const lifecycle = listenerStates.get(listenerKey(root, subject));
    return {
      running: false,
      connected: lifecycle?.connected ?? false,
      state: lifecycle?.state ?? 'stopped',
      last_error_code: lifecycle?.last_error_code ?? null,
      last_error_at: lifecycle?.last_error_at ?? null,
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
    state: status.state,
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
  const generation = (listenerGenerations.get(key) ?? 0) + 1;
  listenerGenerations.set(key, generation);
  let botOpenId = null;
  const live = attachLiveConfig({}, config);
  const configFingerprint = feishuListenerConfigFingerprint(config);
  const startedAt = new Date().toISOString();
  setListenerState(root, subject, 'starting');
  try {
    const entry = await runWithTimeout(async (signal) => {
      const client = new FeishuClient({ ...config, signal });
      const policy = new FeishuPolicy(config);
      const monitor = new FeishuMonitor({
        client,
        policy,
        signal,
        onConnectionChange: (state) => {
          if (generation !== listenerGenerations.get(key)) return;
          if (state.botOpenId) botOpenId = state.botOpenId;
          const nextState = state.state ?? (state.connected ? 'connected' : 'disconnected');
          const safeMessage = state.error ? sanitizeError(state.error, config) : null;
          setListenerState(root, subject, nextState, {
            last_error_code: state.error?.code ?? null,
            last_error_at: state.error ? new Date().toISOString() : null,
          });
          recordChannelEvent(root, subject, {
            type: `feishu_listener_${nextState}`,
            status: state.error ? 'error' : 'ok',
            bot_open_id: state.botOpenId ?? null,
            error: safeMessage,
            error_code: state.error?.code ?? null,
          });
        },
        onMessage: async (event) => {
          if (generation !== listenerGenerations.get(key)) return;
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
          enqueueClassifierIfPendingInbound(root, subject);
        },
      });
      const candidate = {
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
      };
      activeListeners.set(key, candidate);
      try {
        await monitor.start();
      } catch (error) {
        if (activeListeners.get(key) === candidate) activeListeners.delete(key);
        await monitor.stop();
        throw error;
      }
      if (generation !== listenerGenerations.get(key)) {
        await monitor.stop();
        const error = new Error('Feishu listener start superseded');
        error.code = 'channel_aborted';
        throw error;
      }
      return candidate;
    }, config.connectTimeoutMs, 'feishu listener connect', {
      signal: config.signal,
      onCancel: () => {
        const candidate = activeListeners.get(key);
        if (candidate) void candidate.monitor.stop();
      },
    });
    activeListeners.set(key, entry);
  } catch (error) {
    if (activeListeners.get(key)?.configFingerprint === configFingerprint) activeListeners.delete(key);
    const safeMessage = sanitizeError(error, config);
    setListenerState(root, subject, 'failed', {
      last_error_code: error?.code ?? 'feishu_listener_start_failed',
      last_error_at: new Date().toISOString(),
    });
    throw Object.assign(new Error(safeMessage), {
      code: error?.code ?? 'feishu_listener_start_failed',
      retryable: error?.retryable,
    });
  }
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
async function startFeishuListenerUnlocked(root, subject, options = {}) {
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
      last_error_code: err?.code ?? null,
      last_error_at: new Date().toISOString(),
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

async function stopFeishuListenerUnlocked(root, subject, options = {}) {
  const key = listenerKey(root, subject);
  const entry = activeListeners.get(key);
  if (!entry) return { stopped: false, reason: 'not_running' };
  listenerGenerations.set(key, (listenerGenerations.get(key) ?? 0) + 1);
  activeListeners.delete(key);
  try {
    await runWithTimeout(
      () => entry.monitor.stop(),
      options.stopTimeoutMs ?? entry.config.stopTimeoutMs,
      'feishu listener stop',
      { signal: options.signal },
    );
  } catch (error) {
    setListenerState(root, subject, 'stopped', {
      last_error_code: error?.code ?? null,
      last_error_at: new Date().toISOString(),
    });
  }
  setListenerState(root, subject, 'stopped');
  recordChannelEvent(root, subject, {
    type: 'feishu_listener_stopped',
    status: 'ok',
  });
  return { stopped: true };
}

async function reloadFeishuListenerUnlocked(root, subject, reason = 'reload', options = {}) {
  await stopFeishuListenerUnlocked(root, subject, options);
  const result = await startFeishuListenerUnlocked(root, subject, { ...options, reloadReason: reason });
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

async function ensureFeishuListenerUnlocked(root, subject, options = {}) {
  const config = resolveFeishuConfig(root, subject, options);
  const fingerprint = feishuListenerConfigFingerprint(config);
  const entry = getListenerEntry(root, subject);
  const run = shouldRunListener(config);

  if (!run) {
    if (entry) {
      await stopFeishuListenerUnlocked(root, subject, options);
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
    const reloadResult = await reloadFeishuListenerUnlocked(
      root,
      subject,
      options.reason ?? 'config_changed',
      options,
    );
    return {
      action: reloadResult.started ? 'reloaded' : 'reload_failed',
      fingerprint,
      ...reloadResult,
    };
  }

  const startResult = await startFeishuListenerUnlocked(root, subject, options);
  return {
    action: startResult.started ? 'started' : 'start_failed',
    fingerprint,
    ...startResult,
  };
}

export function startFeishuListener(root, subject, options = {}) {
  return serializeListener(root, subject, () => startFeishuListenerUnlocked(root, subject, options));
}

export function stopFeishuListener(root, subject, options = {}) {
  return serializeListener(root, subject, () => stopFeishuListenerUnlocked(root, subject, options));
}

export function reloadFeishuListener(root, subject, reason = 'reload', options = {}) {
  return serializeListener(root, subject, () => reloadFeishuListenerUnlocked(root, subject, reason, options));
}

export function ensureFeishuListener(root, subject, options = {}) {
  return serializeListener(root, subject, () => ensureFeishuListenerUnlocked(root, subject, options));
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
