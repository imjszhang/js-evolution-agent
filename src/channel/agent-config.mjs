import { getSubjectEntry } from '../infra/subjects.mjs';
import { subjectEnvSlug } from './adapters/feishu/config.mjs';

export const DEFAULT_CHANNEL_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

function positiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Channel-only agent_run timeout. Cycle exec keeps using provider-specific timeouts.
 */
export function resolveChannelAgentConfig(root, subject, overrides = {}) {
  const entry = getSubjectEntry(root, subject);
  const block = {
    ...(entry?.channels?.agent ?? {}),
    ...overrides,
  };
  const slug = subjectEnvSlug(subject);
  const envNames = [
    `JEA_CHANNEL_AGENT_${slug}_TIMEOUT_MS`,
    'JEA_CHANNEL_AGENT_TIMEOUT_MS',
    'JEA_CURSOR_AGENT_TIMEOUT_MS',
  ];
  let timeoutMs = overrides.timeoutMs ?? overrides.timeout_ms ?? block.timeout_ms ?? block.timeoutMs ?? null;
  if (timeoutMs == null) {
    for (const name of envNames) {
      const value = process.env[name];
      if (value) {
        timeoutMs = value;
        break;
      }
    }
  }
  return {
    timeout_ms: positiveMs(timeoutMs, DEFAULT_CHANNEL_AGENT_TIMEOUT_MS),
  };
}

export function channelAgentConfigForApi(config) {
  if (!config) return null;
  return { timeout_ms: config.timeout_ms };
}
