import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  resolveSubjectConfig,
  runtimeInfoForSubject,
} from '../../cli/utils/subjects.mjs';
import { readJsonSafe } from '../../cli/utils/files.mjs';
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
} = {}) {
  const bridgeStatus = getOpenClawBridgeStatus(root, { subject });
  const safeStatus = ['pending', 'delivered', 'skipped'].includes(status) ? status : 'pending';
  const dir = join(bridgeStatus.intents.dir, safeStatus);
  const files = listJsonFiles(dir).slice(-Math.max(0, Number(limit) || 20)).reverse();
  return {
    subject: bridgeStatus.subject,
    status: safeStatus,
    dir,
    intents: files.map((file) => ({
      file,
      name: basename(file),
      payload: readJsonSafe(file, null),
    })),
  };
}
