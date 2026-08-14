import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_MODELS,
  NAMED_PROFILES,
  normalizeThinkingMode,
  parseProfileSpec,
  resolveLlmCallOptions,
  toDeepSeekRequestFields,
} from '../src/ai/llm-profile.mjs';

describe('normalizeThinkingMode', () => {
  it('maps off / high / max and engine aliases', () => {
    expect(normalizeThinkingMode('off')).toBe('off');
    expect(normalizeThinkingMode('disabled')).toBe('off');
    expect(normalizeThinkingMode('low')).toBe('off');
    expect(normalizeThinkingMode('medium')).toBe('off');
    expect(normalizeThinkingMode('high')).toBe('high');
    expect(normalizeThinkingMode('xhigh')).toBe('max');
    expect(normalizeThinkingMode('max')).toBe('max');
  });
});

describe('parseProfileSpec', () => {
  it('parses named profiles and shorthand', () => {
    expect(parseProfileSpec('fast')).toEqual(NAMED_PROFILES.fast);
    expect(parseProfileSpec('deep')).toEqual(NAMED_PROFILES.deep);
    expect(parseProfileSpec('flash:off')).toEqual({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'off',
    });
    expect(parseProfileSpec('pro:max')).toEqual({
      model: DEEPSEEK_MODELS.pro,
      thinkingMode: 'max',
    });
  });
});

describe('resolveLlmCallOptions', () => {
  it('uses phase defaults then balanced', () => {
    expect(resolveLlmCallOptions({ phase: 'observe', env: {} })).toMatchObject({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'off',
      profileName: 'fast',
    });
    expect(resolveLlmCallOptions({ phase: 'report', env: {} })).toMatchObject({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'high',
      profileName: 'balanced',
    });
    expect(resolveLlmCallOptions({ phase: 'agent_loop', env: {} })).toMatchObject({
      thinkingMode: 'high',
      profileName: 'balanced',
    });
  });

  it('applies JEA_LLM_PROFILE over phase default', () => {
    const opts = resolveLlmCallOptions({
      phase: 'observe',
      env: { JEA_LLM_PROFILE: 'deep' },
    });
    expect(opts).toMatchObject({
      model: DEEPSEEK_MODELS.pro,
      thinkingMode: 'max',
    });
  });

  it('applies JEA_LLM_PHASE_* over global profile', () => {
    const opts = resolveLlmCallOptions({
      phase: 'report',
      env: {
        JEA_LLM_PROFILE: 'deep',
        JEA_LLM_PHASE_REPORT: 'flash:off',
      },
    });
    expect(opts).toMatchObject({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'off',
    });
  });

  it('applies legacy DEEPSEEK_* when no profile env', () => {
    const opts = resolveLlmCallOptions({
      phase: 'report',
      env: {
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        DEEPSEEK_THINKING: 'enabled',
        DEEPSEEK_REASONING_EFFORT: 'max',
      },
    });
    expect(opts.model).toBe(DEEPSEEK_MODELS.pro);
    expect(opts.thinkingMode).toBe('max');
  });

  it('maps thinking:low override to off so it cannot bump a fast phase to high', () => {
    const opts = resolveLlmCallOptions({
      phase: 'diary',
      env: {},
      overrides: { thinking: 'low' },
    });
    expect(opts.thinkingMode).toBe('off');
  });

  it('call overrides win', () => {
    const opts = resolveLlmCallOptions({
      phase: 'report',
      env: { JEA_LLM_PROFILE: 'deep' },
      overrides: { thinkingMode: 'off', model: 'flash' },
    });
    expect(opts).toMatchObject({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'off',
    });
  });
});

describe('toDeepSeekRequestFields', () => {
  it('emits disabled without effort when off', () => {
    expect(toDeepSeekRequestFields({
      model: DEEPSEEK_MODELS.flash,
      thinkingMode: 'off',
    })).toEqual({
      model: DEEPSEEK_MODELS.flash,
      thinking: { type: 'disabled' },
    });
  });

  it('emits enabled + effort for high/max', () => {
    expect(toDeepSeekRequestFields({
      model: DEEPSEEK_MODELS.pro,
      thinkingMode: 'high',
    })).toEqual({
      model: DEEPSEEK_MODELS.pro,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(toDeepSeekRequestFields({
      model: DEEPSEEK_MODELS.pro,
      thinkingMode: 'max',
    }).reasoning_effort).toBe('max');
  });
});
