import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { getProjectRoot } from '../../infra/project.mjs';
import {
  formatEnvBlock,
  maskSecret,
  upsertEnvFile,
} from '../../infra/env-file.mjs';
import {
  getSubjectEntry,
  updateSubjectsRegistry,
} from '../../infra/subjects.mjs';
import { resolveEffectiveEnv } from '../../actions/execution-env.mjs';
import { runtimeForSubject } from '../../infra/runtime-paths.mjs';
import {
  FEISHU_LOCAL_ENV,
  resolveFeishuConfig,
  subjectEnvSlug,
  subjectRuntimeEnvPath,
} from '../../channel/adapters/feishu/config.mjs';
import { writeChannelReloadRequest } from '../../channel/state.mjs';
import { printRegisterQrPrompt } from '../utils/register-qr.mjs';

function buildFeishuSubjectSkeleton() {
  return {
    enabled: true,
    app_id_env: FEISHU_LOCAL_ENV.appId,
    app_secret_env: FEISHU_LOCAL_ENV.appSecret,
    domain: 'feishu',
    dm_policy: 'allowlist',
    allow_from: [],
    group_policy: 'disabled',
    require_mention: false,
    receipt_reaction: true,
    receipt_reaction_emoji: 'OK',
    bind: {
      enabled: true,
      phrase: 'JEA BIND',
      token_env: FEISHU_LOCAL_ENV.bindToken,
    },
  };
}

export async function loadFeishuSdk() {
  return import('@larksuiteoapi/node-sdk');
}

export async function registerFeishuApp(options = {}) {
  const lark = options.larkModule ?? await loadFeishuSdk();
  if (typeof lark.registerApp !== 'function') {
    const err = new Error(
      '@larksuiteoapi/node-sdk registerApp unavailable; upgrade to >= 1.61.1',
    );
    err.code = 'feishu_register_unavailable';
    throw err;
  }
  return lark.registerApp({
    source: options.source ?? 'jea',
    signal: options.signal,
    domain: options.domain,
    larkDomain: options.larkDomain,
    onQRCodeReady(info) {
      if (typeof options.onQRCodeReady === 'function') {
        options.onQRCodeReady(info);
        return;
      }
      printRegisterQrPrompt(info, {
        root: options.root,
        subject: options.subject,
        noQr: options.noQr,
        noQrImage: options.noQrImage,
        openQr: options.openQr,
      }).catch((err) => {
        console.error(`二维码渲染失败: ${err?.message || err}`);
        console.log(`请扫码或打开链接: ${info.url}`);
        console.log(`链接将在 ${info.expireIn} 秒后过期`);
      });
    },
    onStatusChange(info) {
      if (typeof options.onStatusChange === 'function') {
        options.onStatusChange(info);
      }
    },
  });
}

function maybeInitSubjectConfig(root, subject, flags = {}) {
  if (!flags['init-subject-config']) {
    return { initialized: false };
  }
  let initialized = false;
  let reason = null;
  const written = updateSubjectsRegistry(root, (registry) => {
    const entry = registry.subjects?.[subject];
    if (!entry) {
      throw new Error(`Subject not found in <JEA_HOME>/subjects/registry.json: ${subject}`);
    }
    if (entry.channels?.feishu || entry.channels?.lark) {
      reason = 'already_configured';
      return registry;
    }
    initialized = true;
    return {
      default_subject: registry.default_subject,
      subjects: {
        ...registry.subjects,
        [subject]: {
          ...entry,
          channels: {
            ...(entry.channels ?? {}),
            feishu: buildFeishuSubjectSkeleton(),
          },
        },
      },
    };
  });
  return { initialized, ...(reason ? { reason } : {}), path: written.path };
}

function ensureSubjectHasFeishuBlock(root, subject, flags = {}) {
  const entry = getSubjectEntry(root, subject);
  if (entry?.channels?.feishu || entry?.channels?.lark) {
    return { ok: true };
  }
  if (flags['init-subject-config']) {
    return maybeInitSubjectConfig(root, subject, flags);
  }
  return {
    ok: false,
    message: `Subject "${subject}" has no channels.feishu block in <JEA_HOME>/subjects/registry.json. `
      + 'Add one manually or rerun with --init-subject-config.',
  };
}

function writeSubjectRuntimeEnv(root, subject, updates, { force = false } = {}) {
  const envPath = subjectRuntimeEnvPath(root, subject);
  mkdirSync(dirname(envPath), { recursive: true });
  return upsertEnvFile(envPath, updates, { force });
}

function subjectHasEnvValue(root, subject, name) {
  const { env } = resolveEffectiveEnv(runtimeForSubject(root, subject).runtimeRoot);
  return Boolean(String(env[name] ?? '').trim());
}

function buildCredentialUpdates(_subject, credentials) {
  return {
    [FEISHU_LOCAL_ENV.appId]: credentials.client_id,
    [FEISHU_LOCAL_ENV.appSecret]: credentials.client_secret,
  };
}

function printNextSteps(subject, { bindPhrase = 'JEA BIND' } = {}) {
  console.log('\n下一步:');
  console.log(`1. 确认 <JEA_HOME>/subjects/registry.json 已启用 channels.feishu`);
  console.log(`2. 在飞书私聊机器人发送: ${bindPhrase} <口令>`);
  console.log(`3. 运行: npm run jea -- channel doctor --subject ${subject}`);
  console.log(`4. 启动: npm run jea -- daemon start --subject ${subject} --domain channel`);
  console.log('若 channel daemon 已在运行，配置会在数秒内自动 reload，无需重启。');
}

export async function channelFeishuRegisterCommand({
  root = getProjectRoot(),
  subject,
  flags = {},
  registerFn = registerFeishuApp,
} = {}) {
  const blockCheck = ensureSubjectHasFeishuBlock(root, subject, flags);
  if (!blockCheck.ok && !blockCheck.initialized) {
    console.error(blockCheck.message);
    return 2;
  }
  if (blockCheck.initialized) {
    console.log(`已写入 runtime subject registry channels.feishu skeleton -> ${blockCheck.path}`);
  }

  let result;
  try {
    result = await registerFn({
      source: flags.source && flags.source !== true ? String(flags.source) : 'jea',
      root,
      subject,
      noQr: Boolean(flags['no-qr']),
      noQrImage: Boolean(flags['no-qr-image']),
      openQr: flags['no-open-qr'] ? false : true,
      onQRCodeReady: flags.json
        ? (info) => {
          if (!flags.quiet) {
            console.error(`scan_url=${info.url} expire_in=${info.expireIn}`);
          }
        }
        : undefined,
    });
  } catch (err) {
    console.error(`Feishu registerApp failed: ${err.code ?? 'error'} ${err.description ?? err.message ?? err}`);
    return 1;
  }

  const updates = buildCredentialUpdates(subject, result);
  const payload = {
    subject,
    app_id: result.client_id,
    app_secret_masked: maskSecret(result.client_secret),
    env: updates,
    user_info: result.user_info ?? null,
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (!flags.quiet) {
    console.log(`\n已创建飞书应用 subject=${subject}`);
    console.log(`App ID: ${result.client_id}`);
    console.log(`App Secret: ${maskSecret(result.client_secret)}`);
    console.log('\n建议写入 .env:');
    console.log(formatEnvBlock(updates));
  }

  if (flags['write-env']) {
    try {
      const written = writeSubjectRuntimeEnv(root, subject, updates, { force: Boolean(flags.force) });
      if (!flags.quiet && !flags.json) {
        console.log(`\n已写入 ${written.path}`);
      }
    } catch (err) {
      console.error(err.message);
      return err.code === 'env_conflict' ? 2 : 1;
    }
  } else if (!flags.json && !flags.quiet) {
    console.log('\n如需自动写入 subject 运行时 .env，请加 --write-env');
  }

  return 0;
}

export async function channelFeishuSetupCommand({
  root = getProjectRoot(),
  subject,
  flags = {},
  registerFn = registerFeishuApp,
} = {}) {
  const initResult = maybeInitSubjectConfig(root, subject, flags);
  if (initResult.initialized) {
    console.log(`已写入 subjects.json channels.feishu skeleton -> ${initResult.path}`);
  }

  const blockCheck = ensureSubjectHasFeishuBlock(root, subject, flags);
  if (!blockCheck.ok && !blockCheck.initialized) {
    console.error(blockCheck.message);
    return 2;
  }

  const bindTokenName = FEISHU_LOCAL_ENV.bindToken;
  const prefixedBindToken = `JEA_CHANNEL_FEISHU_${subjectEnvSlug(subject)}_BIND_TOKEN`;
  const bindUpdates = {};
  if (!subjectHasEnvValue(root, subject, bindTokenName)
    && !subjectHasEnvValue(root, subject, prefixedBindToken)) {
    bindUpdates[bindTokenName] = randomBytes(24).toString('hex');
  }

  const registerExit = await channelFeishuRegisterCommand({
    root,
    subject,
    flags: {
      ...flags,
      'write-env': flags['write-env'] ?? true,
      quiet: !flags.json,
    },
    registerFn,
  });
  if (registerExit !== 0) return registerExit;

  if (Object.keys(bindUpdates).length) {
    try {
      writeSubjectRuntimeEnv(root, subject, bindUpdates, { force: Boolean(flags.force) });
      if (!flags.json) {
        console.log(`已生成绑定口令 env: ${bindTokenName}`);
      }
    } catch (err) {
      console.error(err.message);
      return err.code === 'env_conflict' ? 2 : 1;
    }
  }

  const reload = writeChannelReloadRequest(root, subject, {
    reason: 'feishu_setup_completed',
    changed: ['env', 'feishu_credentials'],
  });

  const feishuConfig = resolveFeishuConfig(root, subject);
  const summary = {
    subject,
    reload_request: reload.request,
    feishu: {
      hasAppId: Boolean(feishuConfig.appId),
      hasAppSecret: Boolean(feishuConfig.appSecret),
      bindPhrase: feishuConfig.bindPhrase,
    },
  };

  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\n已写入 channel reload 请求 -> ${reload.file}`);
    printNextSteps(subject, { bindPhrase: feishuConfig.bindPhrase });
  }

  return 0;
}

export async function channelFeishuCommand({
  action,
  flags = {},
  root = getProjectRoot(),
  subject,
} = {}) {
  if (action === 'register') {
    return channelFeishuRegisterCommand({ root, subject, flags });
  }
  if (action === 'setup') {
    return channelFeishuSetupCommand({ root, subject, flags });
  }
  console.error('Usage: jea channel feishu <register|setup> [--subject NAME] [--write-env] [--force] [--init-subject-config] [--no-qr] [--no-qr-image] [--no-open-qr] [--json]');
  return 2;
}
