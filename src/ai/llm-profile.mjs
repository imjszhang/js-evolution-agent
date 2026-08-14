/**
 * DeepSeek V4 LLM profiles: model tier × thinking mode.
 * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */

export const DEEPSEEK_MODELS = Object.freeze({
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
});

export const THINKING_MODES = Object.freeze(['off', 'high', 'max']);

/** Named profiles: fast / balanced / deep */
export const NAMED_PROFILES = Object.freeze({
  fast: { model: DEEPSEEK_MODELS.flash, thinkingMode: 'off' },
  balanced: { model: DEEPSEEK_MODELS.flash, thinkingMode: 'high' },
  deep: { model: DEEPSEEK_MODELS.pro, thinkingMode: 'max' },
});

export const DEFAULT_PROFILE_NAME = 'balanced';

/**
 * Phase → named profile defaults (v1).
 * agent_loop investigate stays balanced unless JEA_LLM_PROFILE / phase override.
 */
export const PHASE_DEFAULT_PROFILES = Object.freeze({
  observe: 'fast',
  channel: 'fast',
  channel_classifier: 'fast',
  channel_presence: 'fast',
  channel_speech: 'fast',
  diary: 'fast',
  standing_memory: 'fast',
  report: 'balanced',
  decide: 'balanced',
  goals: 'balanced',
  belief: 'balanced',
  repair: 'balanced',
  agent_loop: 'balanced',
  llm_ping: 'balanced',
});

const MODEL_ALIASES = Object.freeze({
  flash: DEEPSEEK_MODELS.flash,
  'v4-flash': DEEPSEEK_MODELS.flash,
  'deepseek-v4-flash': DEEPSEEK_MODELS.flash,
  pro: DEEPSEEK_MODELS.pro,
  'v4-pro': DEEPSEEK_MODELS.pro,
  'deepseek-v4-pro': DEEPSEEK_MODELS.pro,
});

/**
 * Map engine / API thinking strings to off|high|max.
 * DeepSeek has no low/medium; those aliases mean "do not spend long thinking" → off.
 * @param {unknown} value
 * @returns {'off'|'high'|'max'|null}
 */
export function normalizeThinkingMode(value) {
  if (value == null || value === '') return null;
  if (value === false) return 'off';
  if (value === true) return 'high';
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (['off', 'disabled', 'false', '0', 'no', 'low', 'medium'].includes(raw)) return 'off';
  if (['max', 'xhigh'].includes(raw)) return 'max';
  if (['high', 'enabled', 'true', '1', 'yes', 'on'].includes(raw)) return 'high';
  return null;
}

/**
 * @param {string} raw
 * @returns {{ model: string, thinkingMode: 'off'|'high'|'max' }|null}
 */
export function parseProfileSpec(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (NAMED_PROFILES[lower]) {
    return { ...NAMED_PROFILES[lower] };
  }
  // Shorthand: flash:off | pro:max | deepseek-v4-flash:high
  const colon = text.indexOf(':');
  if (colon > 0) {
    const modelPart = text.slice(0, colon).trim().toLowerCase();
    const thinkingPart = text.slice(colon + 1).trim();
    const model = MODEL_ALIASES[modelPart] || (modelPart.startsWith('deepseek-') ? modelPart : null);
    const thinkingMode = normalizeThinkingMode(thinkingPart);
    if (model && thinkingMode) return { model, thinkingMode };
  }
  if (MODEL_ALIASES[lower]) {
    return { model: MODEL_ALIASES[lower], thinkingMode: NAMED_PROFILES.balanced.thinkingMode };
  }
  return null;
}

function phaseEnvKey(phase) {
  const slug = String(phase || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return slug ? `JEA_LLM_PHASE_${slug}` : null;
}

function applyLegacyDeepseekEnv(base, env) {
  const next = { ...base };
  const model = String(env.DEEPSEEK_MODEL || '').trim();
  if (model) next.model = MODEL_ALIASES[model.toLowerCase()] || model;

  const thinkingFlag = env.DEEPSEEK_THINKING;
  if (thinkingFlag != null && String(thinkingFlag).trim() !== '') {
    const enabled = ['1', 'true', 'yes', 'on', 'enabled'].includes(String(thinkingFlag).trim().toLowerCase());
    if (!enabled) {
      next.thinkingMode = 'off';
    } else {
      const effort = normalizeThinkingMode(env.DEEPSEEK_REASONING_EFFORT) || 'high';
      next.thinkingMode = effort === 'off' ? 'high' : effort;
    }
  } else if (env.DEEPSEEK_REASONING_EFFORT != null && String(env.DEEPSEEK_REASONING_EFFORT).trim() !== '') {
    const effort = normalizeThinkingMode(env.DEEPSEEK_REASONING_EFFORT);
    if (effort && effort !== 'off') next.thinkingMode = effort;
  }
  return next;
}

/**
 * Resolve per-call LLM options.
 * Priority (high → low): overrides → JEA_LLM_PHASE_* → JEA_LLM_PROFILE → legacy DEEPSEEK_* → phase default → balanced.
 *
 * @param {{ phase?: string, env?: NodeJS.ProcessEnv, overrides?: object }} [args]
 * @returns {{ model: string, thinkingMode: 'off'|'high'|'max', profileName: string|null, phase: string|null }}
 */
export function resolveLlmCallOptions({ phase = null, env = process.env, overrides = null } = {}) {
  let options = { ...NAMED_PROFILES[DEFAULT_PROFILE_NAME] };
  let profileName = DEFAULT_PROFILE_NAME;

  const phaseKey = phase ? String(phase).trim() : '';
  if (phaseKey && PHASE_DEFAULT_PROFILES[phaseKey]) {
    profileName = PHASE_DEFAULT_PROFILES[phaseKey];
    options = { ...NAMED_PROFILES[profileName] };
  }

  options = applyLegacyDeepseekEnv(options, env || {});

  const globalProfile = String(env?.JEA_LLM_PROFILE || '').trim();
  if (globalProfile) {
    const parsed = parseProfileSpec(globalProfile);
    if (parsed) {
      options = { ...parsed };
      profileName = NAMED_PROFILES[globalProfile.toLowerCase()] ? globalProfile.toLowerCase() : globalProfile;
    }
  }

  const envKey = phaseEnvKey(phaseKey);
  if (envKey && env?.[envKey] != null && String(env[envKey]).trim() !== '') {
    const parsed = parseProfileSpec(env[envKey]);
    if (parsed) {
      options = { ...parsed };
      profileName = String(env[envKey]).trim();
    }
  }

  if (overrides && typeof overrides === 'object') {
    if (overrides.model) {
      const m = String(overrides.model).trim();
      options.model = MODEL_ALIASES[m.toLowerCase()] || m;
    }
    if (overrides.thinkingMode != null || overrides.thinking != null) {
      const mode = normalizeThinkingMode(overrides.thinkingMode ?? overrides.thinking);
      if (mode) options.thinkingMode = mode;
    }
    if (overrides.profile) {
      const parsed = parseProfileSpec(overrides.profile);
      if (parsed) {
        options = { ...parsed };
        profileName = String(overrides.profile).trim();
      }
    }
  }

  if (!THINKING_MODES.includes(options.thinkingMode)) {
    options.thinkingMode = 'high';
  }

  return {
    model: options.model,
    thinkingMode: options.thinkingMode,
    profileName,
    phase: phaseKey || null,
  };
}

/**
 * Build DeepSeek Chat Completions request fields for thinking mode.
 * @param {{ model: string, thinkingMode: 'off'|'high'|'max' }} options
 */
export function toDeepSeekRequestFields(options = {}) {
  const model = String(options.model || DEEPSEEK_MODELS.flash);
  const thinkingMode = normalizeThinkingMode(options.thinkingMode) || 'high';
  if (thinkingMode === 'off') {
    return {
      model,
      thinking: { type: 'disabled' },
    };
  }
  return {
    model,
    thinking: { type: 'enabled' },
    reasoning_effort: thinkingMode === 'max' ? 'max' : 'high',
  };
}
