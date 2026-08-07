import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getProjectRoot, loadProjectEnv } from '../../infra/project.mjs';
import {
  formatEnvBlock,
  maskSecret,
  upsertEnvFile,
} from '../../infra/env-file.mjs';
import {
  getSubjectEntry,
  readSubjectsRegistry,
  writeSubjectsRegistry,
} from '../../infra/subjects.mjs';
import { subjectEnvSlug } from '../../channel/adapters/feishu/config.mjs';
import { resolveFeishuConfig } from '../../channel/adapters/feishu/config.mjs';
import { writeChannelReloadRequest } from '../../channel/state.mjs';
import { printRegisterQrPrompt } from '../utils/register-qr.mjs';

function envNamesForSubject(subject) {
  const slug = subjectEnvSlug(subject);
  return {
    appId: `JEA_CHANNEL_FEISHU_${slug}_APP_ID`,
    appSecret: `JEA_CHANNEL_FEISHU_${slug}_APP_SECRET`,
    bindToken: `JEA_CHANNEL_FEISHU_${slug}_BIND_TOKEN`,
  };
}

function buildFeishuSubjectSkeleton(subject) {
  const envNames = envNamesForSubject(subject);
  return {
    enabled: true,
    app_id_env: envNames.appId,
    app_secret_env: envNames.appSecret,
    domain: 'feishu',
    dm_policy: 'allowlist',
    allow_from: [],
    group_policy: 'disabled',
    require_mention: false,
    bind: {
      enabled: true,
      phrase: 'JEA BIND',
      token_env: envNames.bindToken,
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
  const registry = readSubjectsRegistry(root);
  const entry = registry.subjects?.[subject];
  if (!entry) {
    throw new Error(`Subject not found in runtime/subjects/registry.json: ${subject}`);
  }
  if (entry.channels?.feishu || entry.channels?.lark) {
    return { initialized: false, reason: 'already_configured' };
  }
  const nextEntry = {
    ...entry,
    channels: {
      ...(entry.channels ?? {}),
      feishu: buildFeishuSubjectSkeleton(subject),
    },
  };
  writeSubjectsRegistry(root, {
    default_subject: registry.default_subject,
    subjects: {
      ...registry.subjects,
      [subject]: nextEntry,
    },
  });
  return { initialized: true, path: registry.path };
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
    message: `Subject "${subject}" has no channels.feishu block in runtime/subjects/registry.json. `
      + 'Add one manually or rerun with --init-subject-config.',
  };
}

function buildCredentialUpdates(subject, credentials) {
  const envNames = envNamesForSubject(subject);
  return {
    [envNames.appId]: credentials.client_id,
    [envNames.appSecret]: credentials.client_secret,
  };
}

function printNextSteps(subject, { bindPhrase = 'JEA BIND' } = {}) {
  console.log('\n下一步:');
  console.log(`1. 确认 runtime/subjects/registry.json 已启用 channels.feishu`);
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
    const envPath = join(root, '.env');
    try {
      upsertEnvFile(envPath, updates, { force: Boolean(flags.force) });
      loadProjectEnv(root);
      if (!flags.quiet && !flags.json) {
        console.log(`\n已写入 ${envPath}`);
      }
    } catch (err) {
      console.error(err.message);
      return err.code === 'env_conflict' ? 2 : 1;
    }
  } else if (!flags.json && !flags.quiet) {
    console.log('\n如需自动写入 .env，请加 --write-env');
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

  const envNames = envNamesForSubject(subject);
  const bindTokenName = envNames.bindToken;
  const bindUpdates = {};
  if (!process.env[bindTokenName]?.trim()) {
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
    const envPath = join(root, '.env');
    try {
      upsertEnvFile(envPath, bindUpdates, { force: Boolean(flags.force) });
      loadProjectEnv(root);
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
