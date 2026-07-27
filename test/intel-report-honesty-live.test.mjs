/**
 * Live DeepSeek evidence-honesty gate (opt-in).
 *
 * Requires:
 *   JEA_LIVE_DEEPSEEK=1
 *   DEEPSEEK_API_KEY (from repo .env or environment)
 *
 * Default `npm test` skips this file. Run:
 *   $env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek
 *
 * Asserts the same mechanical honesty rules as mock e2e against a real model
 * report (no injected canned markdown, no E2E_REPORT_TOKEN requirement).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../src/cli/utils/project.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { runHonestyLiveIntel } from './helpers/intel-report-honesty-live-runner.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
loadProjectEnv(REPO_ROOT);

const LIVE_ENABLED = process.env.JEA_LIVE_DEEPSEEK === '1'
  && Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());

async function runLiveHonestyPipeline(pipeline) {
  const result = await runHonestyLiveIntel({
    pipeline,
    requireDeepSeekInstance: true,
    DeepSeekClass: DeepSeekOpenAIClient,
  });
  console.info(`[live-honesty] pipeline=${pipeline} findings=`, result.findingsByRule);
  expect(
    result.honesty.findings,
    [
      `live DeepSeek evidence honesty failed for pipeline=${pipeline}`,
      'This is an evaluation signal (model Seen discipline), not a mock wiring bug.',
      JSON.stringify(result.honesty.findings, null, 2),
    ].join('\n'),
  ).toEqual([]);
  return result;
}

describe.skipIf(!LIVE_ENABLED)('Intel report evidence honesty (live DeepSeek)', () => {
  it('phases Intel report Seen citations resolve and exclude brief poison', async () => {
    await runLiveHonestyPipeline('phases');
  }, 900_000);

  it('agent_loop Intel report Seen citations resolve and exclude brief poison', async () => {
    await runLiveHonestyPipeline('agent_loop');
  }, 900_000);
});

describe.skipIf(LIVE_ENABLED)('Intel report evidence honesty (live DeepSeek) — gate', () => {
  it('skips unless JEA_LIVE_DEEPSEEK=1 and DEEPSEEK_API_KEY are set', () => {
    expect(LIVE_ENABLED).toBe(false);
  });
});
