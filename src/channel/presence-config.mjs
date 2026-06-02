import { getSubjectEntry } from '../cli/utils/subjects.mjs';

export const PRESENCE_PLANNERS = Object.freeze(['deterministic', 'llm']);

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Transport-agnostic presence loop config from policies/subjects.json channels.presence.
 */
export function resolvePresenceConfig(root, subject, overrides = {}) {
  const entry = getSubjectEntry(root, subject);
  const block = {
    ...(entry?.channels?.presence ?? {}),
    ...(overrides.presence ?? overrides),
  };
  const enabled = block.enabled === true || block.enabled === 'true';
  const planner = PRESENCE_PLANNERS.includes(block.planner) ? block.planner : 'deterministic';
  const legacyReply = Boolean(block.legacy_reply ?? block.legacyReply ?? false);
  return {
    enabled,
    planner,
    legacy_reply: legacyReply,
    interval_policy: block.interval_policy ?? block.intervalPolicy ?? 'tick',
    max_actions_per_tick: Math.max(0, Number(block.max_actions_per_tick ?? block.maxActionsPerTick) || 2),
    cooldown_ms: Number(block.cooldown_ms ?? block.cooldownMs) || DEFAULT_COOLDOWN_MS,
    max_messages_per_hour: Number(block.max_messages_per_hour ?? block.maxMessagesPerHour) || 0,
    llm: {
      timeout: Number(block.llm?.timeout ?? block.llm_timeout ?? 25) || 25,
      thinking: block.llm?.thinking ?? block.llm_thinking ?? 'low',
    },
    default_transport: block.default_transport ?? block.defaultTransport ?? null,
    default_target: block.default_target ?? block.defaultTarget ?? null,
  };
}

export function isPresenceEnabled(root, subject) {
  return resolvePresenceConfig(root, subject).enabled;
}

export function presenceConfigForApi(config) {
  if (!config) return null;
  return {
    enabled: config.enabled,
    planner: config.planner,
    legacy_reply: config.legacy_reply,
    max_actions_per_tick: config.max_actions_per_tick,
    cooldown_ms: config.cooldown_ms,
    max_messages_per_hour: config.max_messages_per_hour,
    default_transport: config.default_transport,
  };
}

export function shouldUseLegacyReplyPipeline(root, subject) {
  const cfg = resolvePresenceConfig(root, subject);
  if (!cfg.enabled) return true;
  return cfg.legacy_reply;
}
