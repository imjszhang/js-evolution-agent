import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { AIError } from '../src/engine/index.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  resetTokenBudgetsForTests,
  resolveTokenBudgetConfig,
  tokenBudgetSnapshot,
} from '../src/ai/token-budget.mjs';

afterEach(() => resetTokenBudgetsForTests());

const budgetTempDir = mkdtempSync(join(tmpdir(), 'jea-llm-budget-'));
afterAll(() => rmSync(budgetTempDir, { recursive: true, force: true }));

function budgetOptions(subjectKey = `test-${randomUUID()}`) {
  return {
    subjectKey,
    budgetLedgerPath: join(budgetTempDir, `${subjectKey}-${randomUUID()}.json`),
  };
}

const sampleTools = [{
  type: 'function',
  function: {
    name: 'finish_cycle',
    description: 'Finish the cycle',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        report_markdown: { type: 'string' },
      },
      required: ['status', 'report_markdown'],
    },
  },
}];

describe('LLM token budget configuration', () => {
  it('uses defaults only when budget variables are unset', () => {
    expect(resolveTokenBudgetConfig({})).toEqual({
      subjectTokenBudget: 1_000_000,
      requestMaxTokens: 8192,
      subjectSpendBudgetUsd: 10,
      pricing: {
        currency: 'USD',
        unit_tokens: 1_000_000,
        input_per_million_usd: 1,
        cache_hit_per_million_usd: 0.1,
        output_per_million_usd: 4,
        source: 'configured_estimate',
      },
    });
    expect(resolveTokenBudgetConfig({
      JEA_LLM_TOKEN_BUDGET: '12000',
      JEA_LLM_MAX_TOKENS: '512',
    })).toEqual({
      subjectTokenBudget: 12000,
      requestMaxTokens: 512,
      subjectSpendBudgetUsd: 10,
      pricing: {
        currency: 'USD',
        unit_tokens: 1_000_000,
        input_per_million_usd: 1,
        cache_hit_per_million_usd: 0.1,
        output_per_million_usd: 4,
        source: 'configured_estimate',
      },
    });
  });

  it.each([
    ['JEA_LLM_PROCESS_TOKEN_BUDGET', 'not-a-number'],
    ['JEA_LLM_REQUEST_MAX_TOKENS', '0'],
    ['JEA_LLM_TOKEN_BUDGET', ''],
    ['JEA_LLM_MAX_TOKENS', '8193'],
  ])('fails closed for invalid %s', (variable, value) => {
    expect(() => resolveTokenBudgetConfig({ [variable]: value })).toThrow(
      `Invalid ${variable}: expected an integer between 1 and`,
    );
    try {
      resolveTokenBudgetConfig({ [variable]: value });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'llm_token_budget_config_invalid',
        variable,
      });
    }
  });

  it.each([
    ['JEA_LLM_SUBJECT_SPEND_BUDGET_USD', '0'],
    ['JEA_LLM_INPUT_PRICE_PER_MILLION_USD', 'free'],
    ['JEA_LLM_OUTPUT_PRICE_PER_MILLION_USD', '-1'],
    ['JEA_LLM_CACHE_HIT_PRICE_PER_MILLION_USD', '1.0000001'],
  ])('fails closed for invalid spend configuration %s', (variable, value) => {
    expect(() => resolveTokenBudgetConfig({ [variable]: value })).toThrow();
    try {
      resolveTokenBudgetConfig({ [variable]: value });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'llm_spend_budget_config_invalid',
        variable,
      });
    }
  });
});

describe('OpenAI SDK 7 surface', () => {
  it('exposes the default client and chat.completions.create used by DeepSeek', () => {
    expect(typeof OpenAI).toBe('function');
    const sdk = new OpenAI({
      apiKey: 'sk-test-offline',
      baseURL: 'https://api.deepseek.com',
      timeout: 30_000,
    });
    expect(typeof sdk.chat.completions.create).toBe('function');
    const client = new DeepSeekOpenAIClient({
      apiKey: 'sk-test-offline',
      ...budgetOptions(),
      timeout: 30,
      env: {},
      thinkingMode: 'off',
    });
    expect(client._openai).toBeInstanceOf(OpenAI);
    expect(typeof client._openai.chat.completions.create).toBe('function');
  });
});

describe('DeepSeekOpenAIClient.chatMessagesWithTools', () => {
  it('requires an explicit subject key and subject runtime ledger', () => {
    expect(() => new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      env: {},
    })).toThrow(/subjectKey/);
    expect(() => new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      subjectKey: 'alpha',
      env: {},
    })).toThrow(/budgetLedgerPath/);
  });

  it('caps max_tokens and records per-subject process usage', async () => {
    const events = [];
    const budget = budgetOptions('budget-alpha');
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budget,
      env: {
        JEA_LLM_PROCESS_TOKEN_BUDGET: '10000',
        JEA_LLM_REQUEST_MAX_TOKENS: '123',
      },
      onBudgetEvent: (event) => events.push(event),
    });
    let capturedBody;
    client._openai = {
      chat: {
        completions: {
          async create(body) {
            capturedBody = body;
            return {
              choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          },
        },
      },
    };
    await client.chatMessages([{ role: 'user', content: 'hello' }], { maxTokens: 999 });
    expect(capturedBody.max_tokens).toBe(123);
    expect(tokenBudgetSnapshot(budget)).toMatchObject({ used_tokens: 15, calls: 1 });
    expect(events.map((event) => event.type)).toEqual([
      'llm_budget_reserved',
      'llm_budget_settled',
    ]);
    expect(events.at(-1)).toMatchObject({
      provider: 'deepseek',
      provider_usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      cost_estimated: false,
    });
    const persisted = JSON.parse(readFileSync(budget.budgetLedgerPath, 'utf-8'));
    expect(persisted.events.map((event) => event.type)).toEqual([
      'llm_budget_reserved',
      'llm_budget_settled',
    ]);
  });

  it('fails before the API call when the subject token budget is exhausted', async () => {
    const events = [];
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions('budget-closed'),
      env: {
        JEA_LLM_PROCESS_TOKEN_BUDGET: '20',
        JEA_LLM_REQUEST_MAX_TOKENS: '10',
      },
      onBudgetEvent: (event) => events.push(event),
    });
    let called = false;
    client._openai = {
      chat: {
        completions: {
          async create() {
            called = true;
            return {};
          },
        },
      },
    };
    await expect(client.chatMessages([{ role: 'user', content: 'this prompt exceeds the hard budget' }]))
      .rejects.toMatchObject({ code: 'llm_token_budget_exhausted' });
    expect(called).toBe(false);
    expect(events.at(-1)?.type).toBe('llm_token_budget_exhausted');
  });

  it('persists usage across client restart and isolates subjects', async () => {
    const alpha = budgetOptions('restart-alpha');
    const beta = budgetOptions('restart-beta');
    const complete = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
            };
          },
        },
      },
    };
    const first = new DeepSeekOpenAIClient({ apiKey: 'test-key', ...alpha, env: {} });
    first._openai = complete;
    await first.chatMessages([{ role: 'user', content: 'first' }], { maxTokens: 10 });

    const restarted = new DeepSeekOpenAIClient({ apiKey: 'test-key', ...alpha, env: {} });
    expect(restarted.tokenBudgetSnapshot()).toMatchObject({ used_tokens: 10, calls: 1 });
    expect(tokenBudgetSnapshot(beta)).toBeNull();
  });

  it('serializes concurrent reservations without losing spend or token usage', async () => {
    const budget = budgetOptions('concurrent-alpha');
    const makeClient = () => {
      const client = new DeepSeekOpenAIClient({
        apiKey: 'test-key',
        ...budget,
        env: { JEA_LLM_REQUEST_MAX_TOKENS: '10' },
      });
      client._openai = {
        chat: {
          completions: {
            async create() {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return {
                choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
                usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
              };
            },
          },
        },
      };
      return client;
    };
    await Promise.all([
      makeClient().chatMessages([{ role: 'user', content: 'one' }]),
      makeClient().chatMessages([{ role: 'user', content: 'two' }]),
    ]);
    expect(tokenBudgetSnapshot(budget)).toMatchObject({
      used_tokens: 20,
      reserved_tokens: 0,
      calls: 2,
      open_reservations: 0,
    });
    const persisted = JSON.parse(readFileSync(budget.budgetLedgerPath, 'utf-8'));
    expect(persisted.events.filter((event) => event.type === 'llm_budget_reserved')).toHaveLength(2);
    expect(persisted.events.filter((event) => event.type === 'llm_budget_settled')).toHaveLength(2);
  });

  it('fails before provider call when estimated spend is exhausted and audits it', async () => {
    const budget = budgetOptions('spend-closed');
    const events = [];
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budget,
      env: {
        JEA_LLM_REQUEST_MAX_TOKENS: '1',
        JEA_LLM_SUBJECT_SPEND_BUDGET_USD: '0.000001',
        JEA_LLM_INPUT_PRICE_PER_MILLION_USD: '1000',
        JEA_LLM_CACHE_HIT_PRICE_PER_MILLION_USD: '1000',
        JEA_LLM_OUTPUT_PRICE_PER_MILLION_USD: '1000',
      },
      onBudgetEvent: (event) => events.push(event),
    });
    let called = false;
    client._openai = {
      chat: {
        completions: {
          async create() {
            called = true;
            return {};
          },
        },
      },
    };
    await expect(client.chatMessages([{ role: 'user', content: 'costly' }]))
      .rejects.toMatchObject({ code: 'llm_spend_budget_exhausted' });
    expect(called).toBe(false);
    expect(events.at(-1)?.type).toBe('llm_spend_budget_exhausted');
    const persisted = JSON.parse(readFileSync(budget.budgetLedgerPath, 'utf-8'));
    expect(persisted.events.at(-1)?.type).toBe('llm_spend_budget_exhausted');
  });

  it('persists reserve and exhaustion events into the subject audit source', async () => {
    const budget = budgetOptions('audit-source');
    const intelligenceDir = join(budgetTempDir, `intelligence-${randomUUID()}`);
    const store = createIntelligenceStore({ baseDir: intelligenceDir });
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budget,
      env: {
        JEA_LLM_SUBJECT_TOKEN_BUDGET: '100',
        JEA_LLM_REQUEST_MAX_TOKENS: '10',
      },
      onBudgetEvent: (event) => store.recordEvolutionEvent(event),
    });
    client._openai = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      },
    };
    await client.chatMessages([{ role: 'user', content: 'ok' }]);
    await expect(client.chatMessages([{ role: 'user', content: 'x'.repeat(200) }]))
      .rejects.toMatchObject({ code: 'llm_token_budget_exhausted' });
    const auditPath = join(intelligenceDir, 'evolution_events', 'evolution-events.jsonl');
    const events = readFileSync(auditPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      'llm_budget_reserved',
      'llm_budget_settled',
      'llm_token_budget_exhausted',
    ]);
    expect(events.every((event) => event.subject_key === 'audit-source')).toBe(true);
  });

  it('redacts messages and tool schemas at the final provider boundary', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions('redaction-final'),
      env: {},
    });
    let capturedBody;
    client._openai = {
      chat: {
        completions: {
          async create(body) {
            capturedBody = body;
            return {
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            };
          },
        },
      },
    };
    const secret = 'sk-ant-api03-abcdefghijklmnop';
    const messages = [{ role: 'user', content: `credential ${secret}` }];
    const tools = [{
      type: 'function',
      function: {
        name: 'probe',
        description: `Authorization: Bearer ${secret}`,
        parameters: { type: 'object', properties: {} },
      },
    }];
    await client.chatMessagesWithTools(messages, { tools, maxTokens: 1 });
    expect(JSON.stringify(capturedBody)).not.toContain(secret);
    expect(JSON.stringify(capturedBody)).toContain('[REDACTED_SECRET]');
    expect(messages[0].content).toContain(secret);
  });

  it('passes tools and parses tool_calls with tolerant JSON arguments', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions(),
      timeout: 30,
      env: {},
      thinkingMode: 'high',
      model: 'deepseek-v4-flash',
    });
    let capturedBody = null;
    client._openai = {
      chat: {
        completions: {
          async create(body) {
            capturedBody = body;
            return {
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  reasoning_content: 'plan finish',
                  tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'finish_cycle',
                      arguments: '{"status":"done","report_markdown":"# ok"}',
                    },
                  }],
                },
              }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          },
        },
      },
    };

    const result = await client.chatMessagesWithTools(
      [{ role: 'user', content: 'finish now' }],
      { tools: sampleTools },
    );

    expect(capturedBody.tools).toEqual(sampleTools);
    expect(capturedBody.tool_choice).toBe('auto');
    expect(capturedBody.thinking).toEqual({ type: 'enabled' });
    expect(capturedBody.reasoning_effort).toBe('high');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'finish_cycle',
      arguments: { status: 'done', report_markdown: '# ok' },
    });
    expect(result.reasoningContent).toBe('plan finish');
    expect(result.rawMessage.reasoning_content).toBe('plan finish');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage.prompt_tokens).toBe(10);
  });

  it('sends thinking.disabled without reasoning_effort when off', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions(),
      timeout: 30,
      env: {},
      thinkingMode: 'off',
      model: 'deepseek-v4-flash',
    });
    let capturedBody = null;
    client._openai = {
      chat: {
        completions: {
          async create(body) {
            capturedBody = body;
            return {
              choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'pong' },
              }],
            };
          },
        },
      },
    };
    await client.chatMessages([{ role: 'user', content: 'hi' }], { phase: 'observe' });
    expect(capturedBody.model).toBe('deepseek-v4-flash');
    expect(capturedBody.thinking).toEqual({ type: 'disabled' });
    expect(capturedBody.reasoning_effort).toBeUndefined();
  });

  it('honors per-call phase and thinking overrides', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions(),
      timeout: 30,
      env: {},
      thinkingMode: 'off',
    });
    let capturedBody = null;
    client._openai = {
      chat: {
        completions: {
          async create(body) {
            capturedBody = body;
            return {
              choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'ok' },
              }],
            };
          },
        },
      },
    };
    await client.chatMessages([{ role: 'user', content: 'hi' }], {
      phase: 'decide',
      model: 'deepseek-v4-pro',
      thinkingMode: 'max',
    });
    expect(capturedBody.model).toBe('deepseek-v4-pro');
    expect(capturedBody.thinking).toEqual({ type: 'enabled' });
    expect(capturedBody.reasoning_effort).toBe('max');
  });

  it('keeps argumentsRaw when JSON parse fails', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions(),
      timeout: 30,
      env: {},
    });
    client._openai = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: 'trying',
                  tool_calls: [{
                    id: 'call_bad',
                    type: 'function',
                    function: {
                      name: 'intel_query',
                      arguments: '{not-json',
                    },
                  }],
                },
              }],
            };
          },
        },
      },
    };

    const result = await client.chatMessagesWithTools(
      [{ role: 'user', content: 'query' }],
      { tools: sampleTools },
    );
    expect(result.content).toBe('trying');
    expect(result.toolCalls[0].arguments).toBeNull();
    expect(result.toolCalls[0].argumentsRaw).toBe('{not-json');
  });

  it('throws when content and tool_calls are both empty', async () => {
    const client = new DeepSeekOpenAIClient({
      apiKey: 'test-key',
      ...budgetOptions(),
      timeout: 30,
      env: {},
    });
    client._openai = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [{
                finish_reason: 'stop',
                message: { role: 'assistant', content: '   ' },
              }],
            };
          },
        },
      },
    };
    await expect(client.chatMessagesWithTools(
      [{ role: 'user', content: 'hi' }],
      { tools: sampleTools },
    )).rejects.toBeInstanceOf(AIError);
  });
});

describe('MockToolsAIClient', () => {
  it('consumes script items in order then auto-finishes', async () => {
    const client = new MockToolsAIClient({
      script: [
        {
          toolCalls: [{ name: 'get_active_goals', arguments: {} }],
          content: null,
        },
        {
          toolCalls: [{
            name: 'record_observation',
            arguments: { description: 'note', params: { content: 'x' } },
          }],
        },
      ],
      finishReport: '# Custom Finish\n',
    });

    const first = await client.chatMessagesWithTools(
      [{ role: 'user', content: 'start' }],
      { tools: sampleTools },
    );
    expect(first.toolCalls[0].name).toBe('get_active_goals');

    const second = await client.chatMessagesWithTools(
      [{ role: 'user', content: 'next' }],
      { tools: sampleTools },
    );
    expect(second.toolCalls[0].name).toBe('record_observation');

    const third = await client.chatMessagesWithTools(
      [{ role: 'user', content: 'done' }],
      { tools: sampleTools },
    );
    expect(third.toolCalls[0].name).toBe('finish_cycle');
    expect(third.toolCalls[0].arguments.report_markdown).toContain('# Custom Finish');
  });

  it('still supports canned chat for phases compatibility', async () => {
    const client = new MockToolsAIClient({
      canned: [{ match: /hello/, response: 'world' }],
      defaultResponse: 'fallback',
    });
    await expect(client.chat('say hello please')).resolves.toBe('world');
    await expect(client.chat('other')).resolves.toBe('fallback');
  });
});
