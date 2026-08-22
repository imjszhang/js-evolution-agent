import { getSubjectEntry } from '../infra/subjects.mjs';

export const PRESENCE_PLANNERS = Object.freeze(['deterministic', 'llm']);

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Transport-agnostic presence loop config from <JEA_HOME>/subjects/registry.json channels.presence.
 */
export function resolvePresenceConfig(root, subject, overrides = {}) {
  const entry = getSubjectEntry(root, subject);
  const block = {
    ...(entry?.channels?.presence ?? {}),
    ...(overrides.presence ?? overrides),
  };
  const enabled = block.enabled !== false && block.enabled !== 'false';
  const planner = PRESENCE_PLANNERS.includes(block.planner) ? block.planner : 'deterministic';
  const llmTimeoutSec = Number(block.llm?.timeout ?? block.llm_timeout ?? 25) || 25;
  const llmTimeoutMs = llmTimeoutSec * 1000;
  const configuredDecisionMs = Number(block.decision_timeout_ms ?? block.decisionTimeoutMs);
  const defaultDecisionMs = Math.max(30_000, llmTimeoutMs);
  const decisionTimeoutMs = configuredDecisionMs > 0
    ? Math.max(configuredDecisionMs, llmTimeoutMs)
    : defaultDecisionMs;
  const configuredReactorMs = Number(block.timeout_ms ?? block.timeoutMs);
  const reactorTimeoutMs = configuredReactorMs > 0
    ? Math.max(configuredReactorMs, decisionTimeoutMs + 5_000)
    : Math.max(60_000, decisionTimeoutMs + 5_000);
  const fastAckRaw = block.fast_ack_operator_brief ?? block.fastAckOperatorBrief;
  const fast_ack_operator_brief = fastAckRaw !== false && fastAckRaw !== 'false';
  return {
    enabled,
    planner,
    interval_policy: block.interval_policy ?? block.intervalPolicy ?? 'tick',
    max_actions_per_tick: Math.max(0, Number(block.max_actions_per_tick ?? block.maxActionsPerTick) || 2),
    cooldown_ms: Number(block.cooldown_ms ?? block.cooldownMs) || DEFAULT_COOLDOWN_MS,
    max_messages_per_hour: Number(block.max_messages_per_hour ?? block.maxMessagesPerHour) || 0,
    timeout_ms: reactorTimeoutMs,
    decision_timeout_ms: decisionTimeoutMs,
    fast_ack_operator_brief,
    speech_generation_timeout_ms: Number(block.speech_generation_timeout_ms ?? block.speechGenerationTimeoutMs)
      || llmTimeoutMs,
    speech_generation_max_attempts: Math.max(
      1,
      Number(block.speech_generation_max_attempts ?? block.speechGenerationMaxAttempts) || 3,
    ),
    speech_generation_retry_delay_ms: Math.max(
      0,
      Number(block.speech_generation_retry_delay_ms ?? block.speechGenerationRetryDelayMs) || 0,
    ),
    llm: {
      timeout: llmTimeoutSec,
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
    max_actions_per_tick: config.max_actions_per_tick,
    cooldown_ms: config.cooldown_ms,
    max_messages_per_hour: config.max_messages_per_hour,
    timeout_ms: config.timeout_ms,
    decision_timeout_ms: config.decision_timeout_ms,
    fast_ack_operator_brief: config.fast_ack_operator_brief,
    speech_generation_timeout_ms: config.speech_generation_timeout_ms,
    speech_generation_max_attempts: config.speech_generation_max_attempts,
    speech_generation_retry_delay_ms: config.speech_generation_retry_delay_ms,
    default_transport: config.default_transport,
  };
}
