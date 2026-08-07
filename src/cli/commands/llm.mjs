import { MockAIClient } from '../../engine/index.mjs';
import { getProjectRoot, loadProjectEnv } from '../../infra/project.mjs';
import { DeepSeekOpenAIClient } from '../../ai/deepseek-client.mjs';

export async function pingLlm({ mock = false, timeout = 30 } = {}) {
  const client = mock
    ? new MockAIClient({ defaultResponse: 'pong' })
    : new DeepSeekOpenAIClient({ timeout });
  const started = Date.now();
  const text = typeof client.chatMessages === 'function'
    ? await client.chatMessages(
      [{ role: 'user', content: 'Reply with exactly: pong' }],
      { thinking: 'low', timeout, phase: 'llm_ping' },
    )
    : await client.chat('Reply with exactly: pong', 'low', timeout);
  return {
    ok: text.trim().toLowerCase().includes('pong'),
    mode: mock ? 'mock' : 'deepseek',
    elapsedMs: Date.now() - started,
    responsePreview: text.trim().slice(0, 80),
  };
}

export async function llmCommand({ subcommand, flags = {} } = {}) {
  if (subcommand !== 'ping') {
    console.error('Usage: jea llm ping [--mock] [--timeout N] [--json]');
    return 2;
  }
  loadProjectEnv(getProjectRoot());
  const mock = !!flags.mock;
  if (!mock && !process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is required. Use --mock for a local ping.');
    return 1;
  }
  try {
    const result = await pingLlm({ mock, timeout: Number(flags.timeout) || 30 });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`mode: ${result.mode}`);
      console.log(`ok: ${result.ok}`);
      console.log(`elapsedMs: ${result.elapsedMs}`);
      console.log(`response: ${result.responsePreview}`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const result = {
      ok: false,
      mode: mock ? 'mock' : 'deepseek',
      error: e?.message || String(e),
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`LLM ping failed: ${result.error}`);
    return 1;
  }
}

