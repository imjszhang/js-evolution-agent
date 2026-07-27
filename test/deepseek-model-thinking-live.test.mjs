/**
 * Opt-in live smoke matrix: DeepSeek V4 model × thinking mode.
 *
 * Requires JEA_LIVE_DEEPSEEK=1 and DEEPSEEK_API_KEY.
 * pro×max also requires JEA_LIVE_DEEPSEEK_DEEP=1 (cost control).
 *
 *   $env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../src/cli/utils/project.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { DEEPSEEK_MODELS } from '../src/ai/llm-profile.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
loadProjectEnv(REPO_ROOT);

const LIVE_ENABLED = process.env.JEA_LIVE_DEEPSEEK === '1'
  && Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());
const LIVE_DEEP = process.env.JEA_LIVE_DEEPSEEK_DEEP === '1';

const BASE_CELLS = [
  { model: DEEPSEEK_MODELS.flash, thinkingMode: 'off', label: 'flash×off' },
  { model: DEEPSEEK_MODELS.flash, thinkingMode: 'high', label: 'flash×high' },
  { model: DEEPSEEK_MODELS.pro, thinkingMode: 'high', label: 'pro×high' },
];

const DEEP_CELLS = [
  { model: DEEPSEEK_MODELS.pro, thinkingMode: 'max', label: 'pro×max' },
];

async function smokeCell({ model, thinkingMode, label }) {
  const client = new DeepSeekOpenAIClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
    model,
    thinkingMode,
    env: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    },
    timeout: 120,
  });

  // Intercept to capture request fields without breaking the real call.
  const originalCreate = client._openai.chat.completions.create.bind(client._openai.chat.completions);
  let capturedBody = null;
  client._openai.chat.completions.create = async (body, requestOpts) => {
    capturedBody = body;
    return originalCreate(body, requestOpts);
  };

  const text = await client.chatMessages(
    [{ role: 'user', content: 'Reply with exactly: pong' }],
    { timeout: 120, phase: 'llm_ping' },
  );

  expect(capturedBody?.model, `${label} model`).toBe(model);
  if (thinkingMode === 'off') {
    expect(capturedBody?.thinking).toEqual({ type: 'disabled' });
    expect(capturedBody?.reasoning_effort).toBeUndefined();
  } else {
    expect(capturedBody?.thinking).toEqual({ type: 'enabled' });
    expect(capturedBody?.reasoning_effort).toBe(thinkingMode);
  }
  expect(String(text || '').toLowerCase(), `${label} content`).toContain('pong');
  return { label, model, thinkingMode, ok: true, preview: String(text).trim().slice(0, 80) };
}

describe.skipIf(!LIVE_ENABLED)('DeepSeek model × thinking live matrix', () => {
  for (const cell of BASE_CELLS) {
    it(`smoke ${cell.label}`, async () => {
      const result = await smokeCell(cell);
      console.info('[live-matrix]', result);
    }, 180_000);
  }

  describe.skipIf(!LIVE_DEEP)('deep cells (JEA_LIVE_DEEPSEEK_DEEP=1)', () => {
    for (const cell of DEEP_CELLS) {
      it(`smoke ${cell.label}`, async () => {
        const result = await smokeCell(cell);
        console.info('[live-matrix]', result);
      }, 300_000);
    }
  });
});

describe.skipIf(LIVE_ENABLED)('DeepSeek model × thinking live matrix — gate', () => {
  it('skips unless JEA_LIVE_DEEPSEEK=1 and DEEPSEEK_API_KEY are set', () => {
    expect(LIVE_ENABLED).toBe(false);
  });
});
