import { join } from 'node:path';
import { resolveEffectiveEnv } from '../../../actions/execution-env.mjs';
import { runtimeForSubject } from '../../../infra/runtime-paths.mjs';
import {
  readOperatorBinding,
  resolveBindSettings,
  mergeOperatorBinding,
  operatorBindingForApi,
  DEFAULT_BIND_PHRASE,
} from './binding.mjs';
import {
  DEFAULT_FEISHU_RETRY_BASE_MS,
  DEFAULT_FEISHU_RETRY_JITTER,
  DEFAULT_FEISHU_RETRY_MAX_MS,
  DEFAULT_FEISHU_RETRY_MULTIPLIER,
} from './backoff.mjs';
import { DEFAULT_RECEIPT_REACTION_EMOJI } from './receipt.mjs';

const POLICY_OPEN = 'open';
const POLICY_ALLOWLIST = 'allowlist';
const POLICY_DISABLED = 'disabled';
export const DEFAULT_FEISHU_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_FEISHU_SEND_TIMEOUT_MS = 30_000;
export const DEFAULT_FEISHU_STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_CHANNEL_SHUTDOWN_GRACE_MS = 10_000;

function envFlag(name, env = process.env) {
  if (!name) return false;
  const v = env?.[name];
  return v === '1' || v === 'true';
}

/** @param {string} subject */
export function subjectEnvSlug(subject) {
  return String(subject)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

/** Preferred per-subject env file: `<JEA_HOME>/subjects/<ns>/.env`. */
export function subjectRuntimeEnvPath(root, subject) {
  return join(runtimeForSubject(root, subject).runtimeRoot, '.env');
}

function readEnv(name, env = process.env) {
  if (!name) return '';
  const v = env?.[name];
  return v == null ? '' : String(v).trim();
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function timeoutSetting({ override, block, envNames, fallback, env }) {
  if (override != null) return positiveMs(override, fallback);
  if (block != null) return positiveMs(block, fallback);
  for (const name of envNames) {
    const value = readEnv(name, env);
    if (value) return positiveMs(value, fallback);
  }
  return fallback;
}

function numericSetting({ override, block, envNames, fallback, min = 0, max = Number.POSITIVE_INFINITY, env }) {
  const candidates = [override, block, ...envNames.map((name) => readEnv(name, env))];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
  }
  return fallback;
}

function readLegacyLarkBlock(entry) {
  return entry?.channels?.feishu
    ?? entry?.channels?.lark
    ?? entry?.channel?.feishu
    ?? entry?.channel?.lark
    ?? {};
}

/** Names used inside a subject runtime `.env` — the file is already per-subject. */
export const FEISHU_LOCAL_ENV = {
  appId: 'JEA_CHANNEL_FEISHU_APP_ID',
  appSecret: 'JEA_CHANNEL_FEISHU_APP_SECRET',
  bindToken: 'JEA_CHANNEL_FEISHU_BIND_TOKEN',
  defaultChatId: 'JEA_CHANNEL_FEISHU_DEFAULT_CHAT_ID',
  docFolderToken: 'JEA_CHANNEL_FEISHU_DOC_FOLDER_TOKEN',
  docBaseUrl: 'JEA_CHANNEL_FEISHU_DOC_BASE_URL',
  mock: 'JEA_CHANNEL_FEISHU_MOCK',
  receiptReaction: 'JEA_CHANNEL_FEISHU_RECEIPT_REACTION',
  receiptReactionEmoji: 'JEA_CHANNEL_FEISHU_RECEIPT_REACTION_EMOJI',
};

function subjectPrefixedEnvNames(subject) {
  const slug = subjectEnvSlug(subject);
  return {
    appId: `JEA_CHANNEL_FEISHU_${slug}_APP_ID`,
    appSecret: `JEA_CHANNEL_FEISHU_${slug}_APP_SECRET`,
    bindToken: `JEA_CHANNEL_FEISHU_${slug}_BIND_TOKEN`,
    defaultChatId: `JEA_CHANNEL_FEISHU_${slug}_DEFAULT_CHAT_ID`,
    docFolderToken: `JEA_CHANNEL_FEISHU_${slug}_DOC_FOLDER_TOKEN`,
    docBaseUrl: `JEA_CHANNEL_FEISHU_${slug}_DOC_BASE_URL`,
    mock: `JEA_CHANNEL_FEISHU_${slug}_MOCK`,
    receiptReaction: `JEA_CHANNEL_FEISHU_${slug}_RECEIPT_REACTION`,
    receiptReactionEmoji: `JEA_CHANNEL_FEISHU_${slug}_RECEIPT_REACTION_EMOJI`,
  };
}

function optionalBoolSetting({ override, block, envNames, fallback, env }) {
  if (override === true || override === false) return override;
  if (block === true || block === false) return block;
  if (typeof block === 'string') {
    if (/^(1|true|yes)$/i.test(block)) return true;
    if (/^(0|false|no)$/i.test(block)) return false;
  }
  for (const name of envNames) {
    const value = readEnv(name, env);
    if (/^(1|true|yes)$/i.test(value)) return true;
    if (/^(0|false|no)$/i.test(value)) return false;
  }
  return fallback;
}

function resolveCredentialField({
  subject,
  blockValue,
  blockEnvKey,
  blockSecretValue,
  localEnvName,
  subjectEnvName,
  globalEnvNames = [],
  legacyEnvNames = [],
  env,
  runtimeValues = {},
}) {
  if (blockValue) return { value: String(blockValue).trim(), source: 'subjects.json' };
  const fromRuntime = readEnv(localEnvName, runtimeValues);
  if (fromRuntime) return { value: fromRuntime, source: localEnvName };
  const namedEnv = readEnv(blockEnvKey, env);
  if (namedEnv) return { value: namedEnv, source: blockEnvKey };
  const subjectEnv = readEnv(subjectEnvName, env);
  if (subjectEnv) return { value: subjectEnv, source: subjectEnvName };
  const local = readEnv(localEnvName, env);
  if (local) return { value: local, source: localEnvName };
  for (const name of globalEnvNames) {
    if (name === localEnvName) continue;
    const v = readEnv(name, env);
    if (v) return { value: v, source: name };
  }
  for (const name of legacyEnvNames) {
    const v = readEnv(name, env);
    if (v) return { value: v, source: name };
  }
  if (blockSecretValue) {
    return { value: String(blockSecretValue).trim(), source: 'subjects.json:app_secret' };
  }
  return { value: '', source: null };
}

/**
 * Resolve Feishu adapter config for a subject (per-subject bot + policy).
 * @param {string} root
 * @param {string} subject
 * @param {object} [overrides]
 */
export function resolveFeishuConfig(root, subject, overrides = {}) {
  const runtime = runtimeForSubject(root, subject);
  const entry = runtime.config;
  const block = readLegacyLarkBlock(entry);
  const prefixed = subjectPrefixedEnvNames(subject);
  const loadedEnv = resolveEffectiveEnv(runtime.runtimeRoot, {
    baseEnv: overrides.env ?? process.env,
  });
  const env = loadedEnv.env;
  const runtimeValues = loadedEnv.values ?? {};

  const mock = overrides.mock
    ?? (block.mock === true || block.mock === 'true')
    ?? (typeof block.mock === 'string' && !/^(true|false|1|0)$/i.test(block.mock) ? envFlag(block.mock, env) : false)
    ?? envFlag(FEISHU_LOCAL_ENV.mock, env)
    ?? envFlag(prefixed.mock, env)
    ?? envFlag('JEA_CHANNEL_LARK_MOCK', env);

  const appIdResolved = resolveCredentialField({
    subject,
    blockValue: overrides.appId ?? block.app_id ?? block.appId,
    blockEnvKey: block.app_id_env ?? block.appIdEnv,
    localEnvName: FEISHU_LOCAL_ENV.appId,
    subjectEnvName: prefixed.appId,
    legacyEnvNames: ['FEISHU_APP_ID'],
    env,
    runtimeValues,
  });

  const appSecretResolved = resolveCredentialField({
    subject,
    blockSecretValue: overrides.appSecret ?? block.app_secret ?? block.appSecret,
    blockEnvKey: block.app_secret_env ?? block.appSecretEnv,
    localEnvName: FEISHU_LOCAL_ENV.appSecret,
    subjectEnvName: prefixed.appSecret,
    legacyEnvNames: ['FEISHU_APP_SECRET'],
    env,
    runtimeValues,
  });

  const defaultChatResolved = resolveCredentialField({
    subject,
    blockValue: overrides.defaultChatId ?? block.default_chat_id ?? block.defaultChatId,
    blockEnvKey: block.default_chat_id_env ?? block.defaultChatIdEnv,
    localEnvName: FEISHU_LOCAL_ENV.defaultChatId,
    subjectEnvName: prefixed.defaultChatId,
    legacyEnvNames: ['JEA_CHANNEL_LARK_CHAT_ID'],
    env,
    runtimeValues,
  });

  const docFolderResolved = resolveCredentialField({
    subject,
    blockValue: overrides.docFolderToken ?? block.doc_folder_token ?? block.docFolderToken,
    blockEnvKey: block.doc_folder_token_env ?? block.docFolderTokenEnv,
    localEnvName: FEISHU_LOCAL_ENV.docFolderToken,
    subjectEnvName: prefixed.docFolderToken,
    env,
    runtimeValues,
  });

  const docBaseUrlResolved = resolveCredentialField({
    subject,
    blockValue: overrides.docBaseUrl ?? block.doc_base_url ?? block.docBaseUrl,
    blockEnvKey: block.doc_base_url_env ?? block.docBaseUrlEnv,
    localEnvName: FEISHU_LOCAL_ENV.docBaseUrl,
    subjectEnvName: prefixed.docBaseUrl,
    env,
    runtimeValues,
  });

  const domain = overrides.domain
    ?? block.domain
    ?? readEnv(`JEA_CHANNEL_FEISHU_${subjectEnvSlug(subject)}_DOMAIN`, env)
    ?? readEnv('JEA_CHANNEL_FEISHU_DOMAIN', env)
    ?? 'feishu';

  const explicitEnabled = block.enabled;
  const hasCredentials = Boolean(appIdResolved.value && appSecretResolved.value);
  const enabled = overrides.enabled ?? explicitEnabled ?? (explicitEnabled === undefined ? hasCredentials : explicitEnabled);
  const listenerEnabled = overrides.listenerEnabled
    ?? block.listener_enabled
    ?? block.listenerEnabled
    ?? (enabled && block.listener_enabled !== false);

  const bindSettings = resolveBindSettings(block, subject, env, runtimeValues);
  const operatorBinding = readOperatorBinding(root, subject);
  const subjectSlug = subjectEnvSlug(subject);
  const base = {
    subject,
    mock: Boolean(mock),
    enabled: Boolean(enabled),
    listenerEnabled: Boolean(listenerEnabled) && !mock,
    appId: appIdResolved.value,
    appSecret: appSecretResolved.value,
    credentialSources: {
      app_id: appIdResolved.source,
      app_secret: appSecretResolved.source,
    },
    domain: domain === 'lark' ? 'lark' : 'feishu',
    connectionMode: block.connection_mode ?? block.connectionMode ?? 'websocket',
    encryptKey: block.encrypt_key ?? block.encryptKey ?? '',
    verificationToken: block.verification_token ?? block.verificationToken ?? '',
    defaultChatId: defaultChatResolved.value || null,
    docFolderToken: docFolderResolved.value || null,
    docBaseUrl: docBaseUrlResolved.value || null,
    dmPolicy: block.dm_policy ?? block.dmPolicy ?? POLICY_OPEN,
    allowFrom: Array.isArray(block.allow_from) ? block.allow_from : (block.allowFrom ?? []),
    groupPolicy: block.group_policy ?? block.groupPolicy ?? POLICY_ALLOWLIST,
    groupAllowFrom: Array.isArray(block.group_allow_from) ? block.group_allow_from : (block.groupAllowFrom ?? []),
    requireMention: block.require_mention ?? block.requireMention ?? true,
    groups: block.groups ?? {},
    textChunkLimit: block.text_chunk_limit ?? 4000,
    receiptReactionEnabled: optionalBoolSetting({
      override: overrides.receiptReactionEnabled,
      block: block.receipt_reaction ?? block.receiptReaction,
      envNames: [FEISHU_LOCAL_ENV.receiptReaction, prefixed.receiptReaction],
      fallback: true,
      env,
    }),
    receiptReactionEmoji: String(
      overrides.receiptReactionEmoji
        ?? block.receipt_reaction_emoji
        ?? block.receiptReactionEmoji
        ?? readEnv(FEISHU_LOCAL_ENV.receiptReactionEmoji, env)
        ?? readEnv(prefixed.receiptReactionEmoji, env)
        ?? DEFAULT_RECEIPT_REACTION_EMOJI,
    ).trim() || DEFAULT_RECEIPT_REACTION_EMOJI,
    bindEnabled: bindSettings.enabled,
    bindPhrase: bindSettings.phrase,
    bindToken: bindSettings.token,
    bindTokenEnv: bindSettings.tokenEnv,
    operatorBinding,
    runtimeEnvPath: loadedEnv.envPath,
    runtimeEnvExists: loadedEnv.envFileExists,
    signal: overrides.signal ?? null,
    connectTimeoutMs: timeoutSetting({
      override: overrides.connectTimeoutMs,
      block: block.connect_timeout_ms ?? block.connectTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_CONNECT_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_CONNECT_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_CONNECT_TIMEOUT_MS,
      env,
    }),
    sendTimeoutMs: timeoutSetting({
      override: overrides.sendTimeoutMs,
      block: block.send_timeout_ms ?? block.sendTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_SEND_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_SEND_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_SEND_TIMEOUT_MS,
      env,
    }),
    stopTimeoutMs: timeoutSetting({
      override: overrides.stopTimeoutMs,
      block: block.stop_timeout_ms ?? block.stopTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_STOP_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_STOP_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_STOP_TIMEOUT_MS,
      env,
    }),
    shutdownGraceMs: timeoutSetting({
      override: overrides.shutdownGraceMs,
      block: block.shutdown_grace_ms ?? block.shutdownGraceMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_SHUTDOWN_GRACE_MS`, 'JEA_CHANNEL_SHUTDOWN_GRACE_MS'],
      fallback: DEFAULT_CHANNEL_SHUTDOWN_GRACE_MS,
      env,
    }),
    retryBaseMs: timeoutSetting({
      override: overrides.retryBaseMs,
      block: block.retry_base_ms ?? block.retryBaseMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_RETRY_BASE_MS`, 'JEA_CHANNEL_FEISHU_RETRY_BASE_MS'],
      fallback: DEFAULT_FEISHU_RETRY_BASE_MS,
      env,
    }),
    retryMultiplier: numericSetting({
      override: overrides.retryMultiplier,
      block: block.retry_multiplier ?? block.retryMultiplier,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_RETRY_MULTIPLIER`, 'JEA_CHANNEL_FEISHU_RETRY_MULTIPLIER'],
      fallback: DEFAULT_FEISHU_RETRY_MULTIPLIER,
      min: 1,
      env,
    }),
    retryMaxMs: timeoutSetting({
      override: overrides.retryMaxMs,
      block: block.retry_max_ms ?? block.retryMaxMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_RETRY_MAX_MS`, 'JEA_CHANNEL_FEISHU_RETRY_MAX_MS'],
      fallback: DEFAULT_FEISHU_RETRY_MAX_MS,
      env,
    }),
    retryJitter: numericSetting({
      override: overrides.retryJitter,
      block: block.retry_jitter ?? block.retryJitter,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_RETRY_JITTER`, 'JEA_CHANNEL_FEISHU_RETRY_JITTER'],
      fallback: DEFAULT_FEISHU_RETRY_JITTER,
      min: 0,
      max: 1,
      env,
    }),
  };
  return mergeOperatorBinding(base, operatorBinding);
}

export function feishuConfigForApi(config) {
  if (!config) return null;
  return {
    subject: config.subject ?? null,
    mock: config.mock,
    enabled: config.enabled,
    listenerEnabled: config.listenerEnabled,
    domain: config.domain,
    appId: config.appId ? `***${config.appId.slice(-4)}` : null,
    hasAppId: Boolean(config.appId),
    hasAppSecret: Boolean(config.appSecret),
    credentialSources: config.credentialSources ?? {},
    runtime_env: {
      path: config.runtimeEnvPath ?? null,
      exists: Boolean(config.runtimeEnvExists),
    },
    defaultChatId: config.defaultChatId,
    docFolderToken: config.docFolderToken ? `***${String(config.docFolderToken).slice(-4)}` : null,
    docBaseUrl: config.docBaseUrl ?? null,
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    requireMention: config.requireMention,
    operator: operatorBindingForApi(config.operatorBinding, config),
    bind_phrase: config.bindPhrase ?? DEFAULT_BIND_PHRASE,
    connect_timeout_ms: config.connectTimeoutMs,
    send_timeout_ms: config.sendTimeoutMs,
    stop_timeout_ms: config.stopTimeoutMs,
    shutdown_grace_ms: config.shutdownGraceMs,
    retry_base_ms: config.retryBaseMs,
    retry_multiplier: config.retryMultiplier,
    retry_max_ms: config.retryMaxMs,
    retry_jitter: config.retryJitter,
    receipt_reaction: config.receiptReactionEnabled !== false,
    receipt_reaction_emoji: config.receiptReactionEmoji ?? DEFAULT_RECEIPT_REACTION_EMOJI,
  };
}

export function assertFeishuCredentials(config) {
  if (config?.mock) return;
  if (!config?.appId || !config?.appSecret) {
    const subject = config?.subject ?? 'unknown';
    const slug = subjectEnvSlug(subject);
    const err = new Error(
      `Feishu credentials missing for subject "${subject}". `
      + `Set <JEA_HOME>/subjects/<ns>/.env JEA_CHANNEL_FEISHU_APP_ID / JEA_CHANNEL_FEISHU_APP_SECRET `
      + `(legacy JEA_CHANNEL_FEISHU_${slug}_APP_ID still works), `
      + `or registry app_id + app_secret_env.`,
    );
    err.code = 'feishu_credentials_missing';
    throw err;
  }
}
