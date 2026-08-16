import { runtimeForSubject } from '../../../infra/runtime-paths.mjs';
import {
  readOperatorBinding,
  resolveBindSettings,
  mergeOperatorBinding,
  operatorBindingForApi,
  DEFAULT_BIND_PHRASE,
} from './binding.mjs';

const POLICY_OPEN = 'open';
const POLICY_ALLOWLIST = 'allowlist';
const POLICY_DISABLED = 'disabled';
export const DEFAULT_FEISHU_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_FEISHU_SEND_TIMEOUT_MS = 30_000;
export const DEFAULT_FEISHU_STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_CHANNEL_SHUTDOWN_GRACE_MS = 10_000;

function envFlag(name) {
  if (!name) return false;
  const v = process.env[name];
  return v === '1' || v === 'true';
}

/** @param {string} subject */
export function subjectEnvSlug(subject) {
  return String(subject)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase();
}

function readEnv(name) {
  if (!name) return '';
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function timeoutSetting({ override, block, envNames, fallback }) {
  if (override != null) return positiveMs(override, fallback);
  if (block != null) return positiveMs(block, fallback);
  for (const name of envNames) {
    const value = readEnv(name);
    if (value) return positiveMs(value, fallback);
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

function subjectPrefixedEnvNames(subject) {
  const slug = subjectEnvSlug(subject);
  return {
    appId: `JEA_CHANNEL_FEISHU_${slug}_APP_ID`,
    appSecret: `JEA_CHANNEL_FEISHU_${slug}_APP_SECRET`,
    defaultChatId: `JEA_CHANNEL_FEISHU_${slug}_DEFAULT_CHAT_ID`,
    docFolderToken: `JEA_CHANNEL_FEISHU_${slug}_DOC_FOLDER_TOKEN`,
    docBaseUrl: `JEA_CHANNEL_FEISHU_${slug}_DOC_BASE_URL`,
    mock: `JEA_CHANNEL_FEISHU_${slug}_MOCK`,
  };
}

function resolveCredentialField({
  subject,
  blockValue,
  blockEnvKey,
  blockSecretValue,
  subjectEnvName,
  globalEnvNames = [],
  legacyEnvNames = [],
}) {
  if (blockValue) return { value: String(blockValue).trim(), source: 'subjects.json' };
  const namedEnv = readEnv(blockEnvKey);
  if (namedEnv) return { value: namedEnv, source: blockEnvKey };
  const subjectEnv = readEnv(subjectEnvName);
  if (subjectEnv) return { value: subjectEnv, source: subjectEnvName };
  for (const name of globalEnvNames) {
    const v = readEnv(name);
    if (v) return { value: v, source: name };
  }
  for (const name of legacyEnvNames) {
    const v = readEnv(name);
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
  const entry = runtimeForSubject(root, subject).config;
  const block = readLegacyLarkBlock(entry);
  const prefixed = subjectPrefixedEnvNames(subject);

  const mock = overrides.mock
    ?? (block.mock === true || block.mock === 'true')
    ?? (typeof block.mock === 'string' && !/^(true|false|1|0)$/i.test(block.mock) ? envFlag(block.mock) : false)
    ?? envFlag(readEnv(prefixed.mock))
    ?? envFlag('JEA_CHANNEL_FEISHU_MOCK')
    ?? envFlag('JEA_CHANNEL_LARK_MOCK');

  const appIdResolved = resolveCredentialField({
    subject,
    blockValue: overrides.appId ?? block.app_id ?? block.appId,
    blockEnvKey: block.app_id_env ?? block.appIdEnv,
    subjectEnvName: prefixed.appId,
    globalEnvNames: ['JEA_CHANNEL_FEISHU_APP_ID'],
    legacyEnvNames: ['FEISHU_APP_ID'],
  });

  const appSecretResolved = resolveCredentialField({
    subject,
    blockSecretValue: overrides.appSecret ?? block.app_secret ?? block.appSecret,
    blockEnvKey: block.app_secret_env ?? block.appSecretEnv,
    subjectEnvName: prefixed.appSecret,
    globalEnvNames: ['JEA_CHANNEL_FEISHU_APP_SECRET'],
    legacyEnvNames: ['FEISHU_APP_SECRET'],
  });

  const defaultChatResolved = resolveCredentialField({
    subject,
    blockValue: overrides.defaultChatId ?? block.default_chat_id ?? block.defaultChatId,
    blockEnvKey: block.default_chat_id_env ?? block.defaultChatIdEnv,
    subjectEnvName: prefixed.defaultChatId,
    globalEnvNames: ['JEA_CHANNEL_FEISHU_DEFAULT_CHAT_ID'],
    legacyEnvNames: ['JEA_CHANNEL_LARK_CHAT_ID'],
  });

  const docFolderResolved = resolveCredentialField({
    subject,
    blockValue: overrides.docFolderToken ?? block.doc_folder_token ?? block.docFolderToken,
    blockEnvKey: block.doc_folder_token_env ?? block.docFolderTokenEnv,
    subjectEnvName: prefixed.docFolderToken,
    globalEnvNames: ['JEA_CHANNEL_FEISHU_DOC_FOLDER_TOKEN'],
  });

  const docBaseUrlResolved = resolveCredentialField({
    subject,
    blockValue: overrides.docBaseUrl ?? block.doc_base_url ?? block.docBaseUrl,
    blockEnvKey: block.doc_base_url_env ?? block.docBaseUrlEnv,
    subjectEnvName: prefixed.docBaseUrl,
    globalEnvNames: ['JEA_CHANNEL_FEISHU_DOC_BASE_URL'],
  });

  const domain = overrides.domain
    ?? block.domain
    ?? readEnv(`JEA_CHANNEL_FEISHU_${subjectEnvSlug(subject)}_DOMAIN`)
    ?? readEnv('JEA_CHANNEL_FEISHU_DOMAIN')
    ?? 'feishu';

  const explicitEnabled = block.enabled;
  const hasCredentials = Boolean(appIdResolved.value && appSecretResolved.value);
  const enabled = overrides.enabled ?? explicitEnabled ?? (explicitEnabled === undefined ? hasCredentials : explicitEnabled);
  const listenerEnabled = overrides.listenerEnabled
    ?? block.listener_enabled
    ?? block.listenerEnabled
    ?? (enabled && block.listener_enabled !== false);

  const bindSettings = resolveBindSettings(block, subject);
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
    bindEnabled: bindSettings.enabled,
    bindPhrase: bindSettings.phrase,
    bindToken: bindSettings.token,
    bindTokenEnv: bindSettings.tokenEnv,
    operatorBinding,
    signal: overrides.signal ?? null,
    connectTimeoutMs: timeoutSetting({
      override: overrides.connectTimeoutMs,
      block: block.connect_timeout_ms ?? block.connectTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_CONNECT_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_CONNECT_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_CONNECT_TIMEOUT_MS,
    }),
    sendTimeoutMs: timeoutSetting({
      override: overrides.sendTimeoutMs,
      block: block.send_timeout_ms ?? block.sendTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_SEND_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_SEND_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_SEND_TIMEOUT_MS,
    }),
    stopTimeoutMs: timeoutSetting({
      override: overrides.stopTimeoutMs,
      block: block.stop_timeout_ms ?? block.stopTimeoutMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_STOP_TIMEOUT_MS`, 'JEA_CHANNEL_FEISHU_STOP_TIMEOUT_MS'],
      fallback: DEFAULT_FEISHU_STOP_TIMEOUT_MS,
    }),
    shutdownGraceMs: timeoutSetting({
      override: overrides.shutdownGraceMs,
      block: block.shutdown_grace_ms ?? block.shutdownGraceMs,
      envNames: [`JEA_CHANNEL_FEISHU_${subjectSlug}_SHUTDOWN_GRACE_MS`, 'JEA_CHANNEL_SHUTDOWN_GRACE_MS'],
      fallback: DEFAULT_CHANNEL_SHUTDOWN_GRACE_MS,
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
  };
}

export function assertFeishuCredentials(config) {
  if (config?.mock) return;
  if (!config?.appId || !config?.appSecret) {
    const subject = config?.subject ?? 'unknown';
    const slug = subjectEnvSlug(subject);
    const err = new Error(
      `Feishu credentials missing for subject "${subject}". `
      + `Set subjects.json channels.feishu.app_id + app_secret_env, or `
      + `JEA_CHANNEL_FEISHU_${slug}_APP_ID / JEA_CHANNEL_FEISHU_${slug}_APP_SECRET.`,
    );
    err.code = 'feishu_credentials_missing';
    throw err;
  }
}
