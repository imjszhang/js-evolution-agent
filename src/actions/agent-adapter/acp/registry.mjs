import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export const ACP_PROVIDER_PREFIX = 'acp:';
export const CLAUDE_CODE_ACP_PROVIDER = 'acp:claude-code';

function splitArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  const text = String(value ?? '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Plain whitespace-separated arguments remain convenient for simple flags.
  }
  return text.split(/\s+/).filter(Boolean);
}

function localBin(projectRoot, name) {
  const candidate = join(projectRoot, 'node_modules', '.bin', name);
  return existsSync(candidate) ? candidate : name;
}

export function createAcpFrameworkRegistry({
  projectRoot = process.cwd(),
  env = process.env,
  entries = [],
} = {}) {
  const registry = new Map();
  registry.set(CLAUDE_CODE_ACP_PROVIDER, {
    id: 'claude-code',
    provider: CLAUDE_CODE_ACP_PROVIDER,
    command: env.JEA_ACP_CLAUDE_CODE_BIN || localBin(projectRoot, 'claude-agent-acp'),
    args: splitArgs(env.JEA_ACP_CLAUDE_CODE_ARGS),
    versionArgs: ['--version'],
    credentialEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    packageName: '@agentclientprotocol/claude-agent-acp',
  });
  for (const entry of entries) {
    if (entry?.provider?.startsWith(ACP_PROVIDER_PREFIX)) {
      registry.set(entry.provider.toLowerCase(), { ...entry });
    }
  }
  return registry;
}

export function isAcpProvider(provider) {
  return String(provider ?? '').toLowerCase().startsWith(ACP_PROVIDER_PREFIX);
}

export function resolveAcpFramework(provider, {
  projectRoot = process.cwd(),
  env = process.env,
  registry = null,
} = {}) {
  const normalized = String(provider ?? '').trim().toLowerCase();
  const effective = registry ?? createAcpFrameworkRegistry({ projectRoot, env });
  return effective.get(normalized) ?? null;
}

export function envWithLocalNodeBin(projectRoot, env = process.env) {
  const local = join(projectRoot, 'node_modules', '.bin');
  const current = String(env.PATH ?? '');
  return {
    ...env,
    PATH: current.split(delimiter).includes(local) ? current : `${local}${delimiter}${current}`,
  };
}

