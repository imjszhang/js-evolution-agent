import { describe, expect, it } from 'vitest';
import {
  accumulateLlmUsage,
  formatLlmUsageSummary,
  summarizeLlmUsage,
} from '../src/ai/prompt-cache-metadata.mjs';
import { chatMessagesDetailed } from '../src/ai/messages.mjs';

describe('summarizeLlmUsage', () => {
  it('returns null for missing usage', () => {
    expect(summarizeLlmUsage(null)).toBeNull();
    expect(summarizeLlmUsage(undefined)).toBeNull();
    expect(summarizeLlmUsage('x')).toBeNull();
  });

  it('normalizes DeepSeek prompt_cache_hit/miss tokens', () => {
    const summary = summarizeLlmUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
      completion_tokens_details: { reasoning_tokens: 50 },
    });
    expect(summary).toMatchObject({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      cache_hit_tokens: 800,
      cache_miss_tokens: 200,
      cache_hit_ratio: 0.8,
      reasoning_tokens: 50,
    });
  });

  it('falls back to prompt_tokens_details.cached_tokens', () => {
    const summary = summarizeLlmUsage({
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 400 },
    });
    expect(summary.cache_hit_tokens).toBe(400);
    expect(summary.cache_hit_ratio).toBe(0.8);
  });

  it('computes hit ratio from hit+miss when prompt_tokens missing', () => {
    const summary = summarizeLlmUsage({
      prompt_cache_hit_tokens: 3,
      prompt_cache_miss_tokens: 1,
    });
    expect(summary.cache_hit_ratio).toBe(0.75);
  });
});

describe('accumulateLlmUsage', () => {
  it('sums summarized usages and sets call_count', () => {
    const total = accumulateLlmUsage([
      summarizeLlmUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 20,
      }),
      summarizeLlmUsage({
        prompt_tokens: 200,
        completion_tokens: 20,
        total_tokens: 220,
        prompt_cache_hit_tokens: 180,
        prompt_cache_miss_tokens: 20,
      }),
    ]);
    expect(total).toMatchObject({
      prompt_tokens: 300,
      completion_tokens: 30,
      total_tokens: 330,
      cache_hit_tokens: 260,
      cache_miss_tokens: 40,
      call_count: 2,
    });
    expect(total.cache_hit_ratio).toBeCloseTo(260 / 300, 4);
  });

  it('returns null for empty list', () => {
    expect(accumulateLlmUsage([])).toBeNull();
    expect(accumulateLlmUsage(null)).toBeNull();
  });
});

describe('formatLlmUsageSummary', () => {
  it('formats a compact log line', () => {
    const line = formatLlmUsageSummary({
      prompt_tokens: 100,
      cache_hit_tokens: 80,
      cache_miss_tokens: 20,
      cache_hit_ratio: 0.8,
      call_count: 2,
    }, 'prompt-cache test');
    expect(line).toContain('[prompt-cache test]');
    expect(line).toContain('prompt=100');
    expect(line).toContain('cache_hit=80');
    expect(line).toContain('hit_ratio=0.8');
    expect(line).toContain('calls=2');
  });

  it('returns null when usage missing', () => {
    expect(formatLlmUsageSummary(null)).toBeNull();
  });
});

describe('chatMessagesDetailed wrapper', () => {
  it('uses chatMessagesDetailed when available', async () => {
    const client = {
      async chatMessagesDetailed() {
        return {
          text: 'hello',
          usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 8 },
          model: 'deepseek-v4-flash',
          thinkingMode: 'high',
        };
      },
    };
    const result = await chatMessagesDetailed(client, [{ role: 'user', content: 'hi' }]);
    expect(result).toMatchObject({
      text: 'hello',
      usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 8 },
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
    });
  });

  it('falls back to chatMessages with usage null', async () => {
    const client = {
      async chatMessages() {
        return 'from chatMessages';
      },
    };
    const result = await chatMessagesDetailed(client, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({
      text: 'from chatMessages',
      usage: null,
      model: null,
      thinkingMode: null,
    });
  });

  it('falls back to chat with usage null', async () => {
    const client = {
      async chat() {
        return 'from chat';
      },
    };
    const result = await chatMessagesDetailed(client, [{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({
      text: 'from chat',
      usage: null,
      model: null,
      thinkingMode: null,
    });
  });
});
