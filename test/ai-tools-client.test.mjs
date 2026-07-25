import { describe, expect, it } from 'vitest';
import { AIError } from '../src/engine/index.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';

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

describe('DeepSeekOpenAIClient.chatMessagesWithTools', () => {
  it('passes tools and parses tool_calls with tolerant JSON arguments', async () => {
    const client = new DeepSeekOpenAIClient({ apiKey: 'test-key', timeout: 30 });
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
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'finish_cycle',
      arguments: { status: 'done', report_markdown: '# ok' },
    });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage.prompt_tokens).toBe(10);
  });

  it('keeps argumentsRaw when JSON parse fails', async () => {
    const client = new DeepSeekOpenAIClient({ apiKey: 'test-key', timeout: 30 });
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
    const client = new DeepSeekOpenAIClient({ apiKey: 'test-key', timeout: 30 });
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
