import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  resolveSubjectConfig,
  runtimeInfoForSubject,
} from '../../infra/subjects.mjs';
import { readJsonSafe } from '../../infra/files.mjs';
import { bridgeIntentDir } from '../../channel/adapters/bridge-intent/index.mjs';
import { bridgeConfigPath } from './deploy.mjs';

function listJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
}

function countJsonFiles(dir) {
  return listJsonFiles(dir).length;
}

function summarizeIntentPayload(payload = {}) {
  const outbound = payload?.outbound ?? {};
  const metadata = {
    ...(payload?.metadata ?? {}),
    ...(outbound?.metadata ?? {}),
  };
  return {
    intent_id: payload?.intent_id ?? outbound?.idempotency_key ?? null,
    generated_at: payload?.generated_at ?? outbound?.created_at ?? null,
    target: payload?.target ?? outbound?.target ?? null,
    channel: payload?.channel ?? outbound?.channel ?? null,
    text: outbound?.text ?? payload?.text ?? '',
    deliverable_id: metadata.deliverable_id ?? null,
    channel_agent_run_id: metadata.channel_agent_run_id ?? null,
    delivery_format: metadata.delivery_format ?? metadata.delivery_item ?? null,
    item_index: metadata.item_index ?? null,
    channel_deliverable: Boolean(metadata.channel_deliverable),
  };
}

export function getOpenClawBridgeStatus(root, {
  subject = null,
} = {}) {
  const config = resolveSubjectConfig(root, { subject });
  const runtime = runtimeInfoForSubject(root, config);
  const bridgeCfg = config.channels?.['bridge-intent'] ?? {};
  const intentsDir = bridgeIntentDir(root, runtime.subject, bridgeCfg);
  const currentTransport = config.channels?.presence?.default_transport
    ?? config.channels?.presence?.defaultTransport
    ?? null;
  const bridgeConfig = readJsonSafe(bridgeConfigPath(runtime), null);
  const pendingDir = join(intentsDir, 'pending');
  const deliveredDir = join(intentsDir, 'delivered');
  const skippedDir = join(intentsDir, 'skipped');
  return {
    subject: runtime.subject,
    mode: currentTransport ?? 'feishu',
    deployed: currentTransport === 'bridge-intent',
    agent_id: bridgeCfg.agent_id ?? bridgeCfg.agentId ?? bridgeConfig?.agent_id ?? null,
    target: bridgeCfg.target ?? bridgeConfig?.target ?? null,
    deployed_at: bridgeConfig?.deployed_at ?? null,
    undeployed_at: bridgeConfig?.undeployed_at ?? null,
    workspace: runtime.runtimeRoot,
    config_path: bridgeConfigPath(runtime),
    bridge_config: bridgeConfig,
    intents: {
      dir: intentsDir,
      pending: countJsonFiles(pendingDir),
      delivered: countJsonFiles(deliveredDir),
      skipped: countJsonFiles(skippedDir),
    },
  };
}

export function listOpenClawBridgeIntents(root, {
  subject = null,
  status = 'pending',
  limit = 20,
  deliverableId = null,
} = {}) {
  const bridgeStatus = getOpenClawBridgeStatus(root, { subject });
  const safeStatus = ['pending', 'delivered', 'skipped'].includes(status) ? status : 'pending';
  const dir = join(bridgeStatus.intents.dir, safeStatus);
  const needle = deliverableId ? String(deliverableId) : null;
  const intents = listJsonFiles(dir)
    .map((file) => {
      const payload = readJsonSafe(file, null);
      const summary = summarizeIntentPayload(payload);
      return {
        file,
        name: basename(file),
        summary,
        payload,
      };
    })
    .filter((item) => {
      if (!needle) return true;
      return item.summary.deliverable_id === needle
        || item.summary.channel_agent_run_id === needle
        || item.summary.intent_id === needle;
    })
    .slice(-Math.max(0, Number(limit) || 20))
    .reverse();
  return {
    subject: bridgeStatus.subject,
    status: safeStatus,
    dir,
    deliverable_id: needle,
    intents,
  };
}
