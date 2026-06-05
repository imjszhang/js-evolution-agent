import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  readSubjectsRegistry,
  resolveSubjectConfig,
  runtimeInfoForSubject,
  writeSubjectsRegistry,
} from '../../cli/utils/subjects.mjs';
import { readJsonSafe, writeJsonFile } from '../../cli/utils/files.mjs';
import { bridgeIntentDir } from '../../channel/adapters/bridge-intent/index.mjs';
import { buildOpenClawAgentsMd } from './templates/AGENTS.md.mjs';

function nowIso() {
  return new Date().toISOString();
}

function normalizeAgentId(subject, value) {
  return String(value || `jea-${subject}`).trim();
}

function bridgeRootForRuntime(runtime) {
  return join(runtime.dataRoot, 'bridge', 'openclaw');
}

function bridgeConfigPath(runtime) {
  return join(bridgeRootForRuntime(runtime), 'config.json');
}

function snippetPath(runtime) {
  return join(bridgeRootForRuntime(runtime), 'openclaw-config-snippet.json5');
}

function agentsMdPath(runtime) {
  return join(runtime.runtimeRoot, 'AGENTS.md');
}

function buildOpenClawConfigSnippet({
  agentId,
  subject,
  workspace,
  channel = '<channel>',
  accountId = '<account>',
}) {
  return `{
  agents: {
    list: [
      {
        id: "${agentId}",
        name: "${subject} 演化体",
        workspace: "${workspace.replace(/\\/g, '/')}",
        skipBootstrap: true,
        heartbeat: { every: "5m" },
      },
    ],
  },
  bindings: [
    { agentId: "${agentId}", match: { channel: "${channel}", accountId: "${accountId}" } },
  ],
}
`;
}

function updateSubjectEntry(root, subject, updater) {
  const registry = readSubjectsRegistry(root);
  const entry = registry.subjects?.[subject];
  if (!entry) throw new Error(`Subject not found in runtime/subjects/registry.json: ${subject}`);
  const nextEntry = updater(entry, registry);
  const written = writeSubjectsRegistry(root, {
    default_subject: registry.default_subject,
    subjects: {
      ...registry.subjects,
      [subject]: nextEntry,
    },
  });
  return { registry, entry, nextEntry, written };
}

export function deployOpenClawBridge(root, {
  subject = null,
  agentId = null,
  target = null,
  force = false,
  channel = null,
  accountId = null,
} = {}) {
  const config = resolveSubjectConfig(root, { subject });
  const runtime = runtimeInfoForSubject(root, config);
  const resolvedSubject = runtime.subject;
  const resolvedAgentId = normalizeAgentId(resolvedSubject, agentId);
  const resolvedTarget = String(target || resolvedAgentId);
  const deployedAt = nowIso();
  const existingState = readJsonSafe(bridgeConfigPath(runtime), null);

  const update = updateSubjectEntry(root, resolvedSubject, (entry) => {
    const channels = entry.channels ?? {};
    const presence = channels.presence ?? {};
    return {
      ...entry,
      channels: {
        ...channels,
        presence: {
          ...presence,
          default_transport: 'bridge-intent',
        },
        'bridge-intent': {
          ...(channels['bridge-intent'] ?? {}),
          target: resolvedTarget,
          agent_id: resolvedAgentId,
        },
      },
    };
  });

  const previousTransport = update.entry.channels?.presence?.default_transport
    ?? update.entry.channels?.presence?.defaultTransport
    ?? null;
  const restoredTransport = previousTransport === 'bridge-intent'
    ? (existingState?.previous_transport ?? null)
    : previousTransport;
  const bridgeCfg = update.nextEntry.channels?.['bridge-intent'] ?? {};
  const intentsDir = bridgeIntentDir(root, resolvedSubject, bridgeCfg);
  mkdirSync(join(intentsDir, 'pending'), { recursive: true });
  mkdirSync(join(intentsDir, 'delivered'), { recursive: true });

  const agentsFile = agentsMdPath(runtime);
  const agentsExisted = existsSync(agentsFile);
  let agentsWritten = false;
  if (!agentsExisted || force) {
    mkdirSync(runtime.runtimeRoot, { recursive: true });
    writeFileSync(
      agentsFile,
      buildOpenClawAgentsMd({
        subject: resolvedSubject,
        agentId: resolvedAgentId,
        intentsRelativeDir: relative(runtime.runtimeRoot, intentsDir).replace(/\\/g, '/'),
      }),
      'utf-8',
    );
    agentsWritten = true;
  }

  const snippet = buildOpenClawConfigSnippet({
    agentId: resolvedAgentId,
    subject: resolvedSubject,
    workspace: runtime.runtimeRoot,
    channel: channel || '<channel>',
    accountId: accountId || '<account>',
  });
  const bridgeRoot = bridgeRootForRuntime(runtime);
  mkdirSync(bridgeRoot, { recursive: true });
  const snippetFile = snippetPath(runtime);
  writeFileSync(snippetFile, snippet, 'utf-8');

  const state = {
    schema_version: 1,
    status: 'deployed',
    subject: resolvedSubject,
    agent_id: resolvedAgentId,
    target: resolvedTarget,
    deployed_at: deployedAt,
    previous_transport: restoredTransport,
    workspace: runtime.runtimeRoot,
    intents_dir: intentsDir,
    agents_md: agentsFile,
    openclaw_config_snippet: snippetFile,
  };
  writeJsonFile(bridgeConfigPath(runtime), state);

  return {
    subject: resolvedSubject,
    runtime,
    status: 'deployed',
    already_deployed: previousTransport === 'bridge-intent',
    registry_path: update.written.path,
    agent_id: resolvedAgentId,
    target: resolvedTarget,
    intents_dir: intentsDir,
    agents_md: {
      path: agentsFile,
      written: agentsWritten,
      skipped: agentsExisted && !force,
    },
    config_path: bridgeConfigPath(runtime),
    openclaw_config_snippet: snippetFile,
    state,
  };
}

export function undeployOpenClawBridge(root, {
  subject = null,
} = {}) {
  const config = resolveSubjectConfig(root, { subject });
  const runtime = runtimeInfoForSubject(root, config);
  const resolvedSubject = runtime.subject;
  const undeployedAt = nowIso();
  const existingState = readJsonSafe(bridgeConfigPath(runtime), null);
  const restoreTransport = existingState?.previous_transport ?? null;
  const update = updateSubjectEntry(root, resolvedSubject, (entry) => {
    const channels = entry.channels ?? {};
    const presence = { ...(channels.presence ?? {}) };
    if (restoreTransport) {
      presence.default_transport = restoreTransport;
    } else {
      delete presence.default_transport;
      delete presence.defaultTransport;
    }
    return {
      ...entry,
      channels: {
        ...channels,
        presence,
      },
    };
  });

  const bridgeCfg = update.nextEntry.channels?.['bridge-intent'] ?? {};
  const intentsDir = bridgeIntentDir(root, resolvedSubject, bridgeCfg);
  const state = {
    schema_version: 1,
    status: 'undeployed',
    subject: resolvedSubject,
    undeployed_at: undeployedAt,
    restored_transport: restoreTransport ?? 'feishu',
    restored_explicit_transport: restoreTransport,
    workspace: runtime.runtimeRoot,
    intents_dir: intentsDir,
  };
  mkdirSync(bridgeRootForRuntime(runtime), { recursive: true });
  writeJsonFile(bridgeConfigPath(runtime), state);
  return {
    subject: resolvedSubject,
    runtime,
    status: 'undeployed',
    registry_path: update.written.path,
    restored_transport: restoreTransport ?? 'feishu',
    restored_explicit_transport: restoreTransport,
    config_path: bridgeConfigPath(runtime),
    state,
  };
}

export {
  agentsMdPath,
  bridgeConfigPath,
  bridgeRootForRuntime,
  snippetPath,
};
