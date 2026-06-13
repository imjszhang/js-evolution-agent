import { MockAIClient } from '../engine/index.mjs';
import { DeepSeekOpenAIClient } from './deepseek-client.mjs';

function envBool(value) {
  if (value == null || value === '') return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

export function createLlmClient({
  profile = 'default',
  env = process.env,
  timeout = null,
  mockResponse = null,
  allowMissing = true,
} = {}) {
  if (envBool(env.JEA_FORCE_MOCK) || profile === 'mock') {
    return new MockAIClient(mockResponse ? { defaultResponse: mockResponse } : {});
  }
  if (!String(env.DEEPSEEK_API_KEY ?? '').trim()) {
    if (allowMissing) return null;
    throw new Error('createLlmClient: missing DEEPSEEK_API_KEY');
  }
  return new DeepSeekOpenAIClient({
    apiKey: env.DEEPSEEK_API_KEY,
    baseURL: env.DEEPSEEK_BASE_URL,
    model: env.DEEPSEEK_MODEL,
    thinkingEnabled: envBool(env.DEEPSEEK_THINKING),
    reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
    timeout,
  });
}
