import { getSubjectEntry } from '../cli/utils/subjects.mjs';

export const CLASSIFIER_MODES = Object.freeze(['llm', 'deterministic', 'mock']);

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 20;

/**
 * Transport-agnostic inbound classifier config from runtime/subjects/registry.json channels.classifier.
 */
export function resolveClassifierConfig(root, subject, overrides = {}) {
  const entry = getSubjectEntry(root, subject);
  const block = {
    ...(entry?.channels?.classifier ?? {}),
    ...(overrides.classifier ?? overrides),
  };
  const enabled = block.enabled !== false && block.enabled !== 'false';
  const modeRaw = String(block.mode ?? 'llm').trim().toLowerCase();
  const mode = CLASSIFIER_MODES.includes(modeRaw) ? modeRaw : 'llm';
  const llmTimeoutSec = Number(block.llm?.timeout ?? block.llm_timeout ?? 25) || 25;
  const fallbackRaw = String(block.fallback ?? 'observation').trim().toLowerCase();
  const fallback = ['observation', 'retry'].includes(fallbackRaw) ? fallbackRaw : 'observation';
  return {
    enabled,
    mode,
    interval_ms: Math.max(1000, Number(block.interval_ms ?? block.intervalMs) || DEFAULT_INTERVAL_MS),
    batch_size: Math.max(1, Number(block.batch_size ?? block.batchSize) || DEFAULT_BATCH_SIZE),
    timeout_ms: Math.max(1000, Number(block.timeout_ms ?? block.timeoutMs) || llmTimeoutSec * 1000),
    fallback,
    llm: {
      timeout: llmTimeoutSec,
      thinking: block.llm?.thinking ?? block.llm_thinking ?? 'low',
    },
  };
}

export function classifierConfigForApi(config) {
  if (!config) return null;
  return {
    enabled: config.enabled,
    mode: config.mode,
    interval_ms: config.interval_ms,
    batch_size: config.batch_size,
    timeout_ms: config.timeout_ms,
    fallback: config.fallback,
  };
}
