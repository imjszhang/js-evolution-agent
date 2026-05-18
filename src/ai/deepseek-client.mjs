/**
 * DeepSeek via OpenAI-compatible Chat Completions API.
 * @see https://api-docs.deepseek.com/zh-cn/
 */
import OpenAI from 'openai';
import { AIError, BaseAIClient } from 'js-evolution-engine';

function envBool(value) {
  if (value == null || value === '') return false;
  const v = String(value).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'enabled';
}

export class DeepSeekOpenAIClient extends BaseAIClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] default: process.env.DEEPSEEK_API_KEY
   * @param {string} [opts.baseURL] default: process.env.DEEPSEEK_BASE_URL || https://api.deepseek.com
   * @param {string} [opts.model] default: process.env.DEEPSEEK_MODEL || deepseek-v4-flash
   * @param {boolean} [opts.thinkingEnabled] default: DEEPSEEK_THINKING=enabled|true|1
   * @param {string} [opts.reasoningEffort] default: process.env.DEEPSEEK_REASONING_EFFORT (e.g. high)
   */
  constructor(opts = {}) {
    super(opts);
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey?.trim()) {
      throw new AIError('DeepSeekOpenAIClient: set DEEPSEEK_API_KEY or pass apiKey');
    }
    const baseURL = opts.baseURL
      ?? process.env.DEEPSEEK_BASE_URL
      ?? 'https://api.deepseek.com';
    this.model = opts.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    this.thinkingEnabled = opts.thinkingEnabled ?? envBool(process.env.DEEPSEEK_THINKING);
    this.reasoningEffort = opts.reasoningEffort ?? process.env.DEEPSEEK_REASONING_EFFORT ?? '';

    const timeoutSec = opts.timeout ?? this.timeout;
    this._openai = new OpenAI({
      apiKey: apiKey.trim(),
      baseURL: baseURL.replace(/\/$/, ''),
      timeout: Math.max(1, Number(timeoutSec) || 120) * 1000,
    });
  }

  /**
   * @param {string} message
   * @param {{ thinking?: string, timeout?: number }} [opts]
   */
  async _chatRaw(message, opts = {}) {
    return this.chatMessages([{ role: 'user', content: message }], opts);
  }

  /**
   * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
   * @param {{ thinking?: string, timeout?: number }} [opts]
   */
  async chatMessages(messages, opts = {}) {
    const timeoutSec = opts.timeout ?? this.timeout;
    const body = {
      model: this.model,
      messages,
      stream: false,
    };
    if (this.thinkingEnabled) {
      body.thinking = { type: 'enabled' };
      if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;
    }

    let completion;
    try {
      completion = await this._openai.chat.completions.create(body, {
        timeout: Math.max(1, Number(timeoutSec) || 120) * 1000,
      });
    } catch (e) {
      const msg = e?.message || String(e);
      this._log(`DeepSeek API error: ${msg}`, 'error');
      throw new AIError(`DeepSeek request failed: ${msg}`);
    }

    const text = completion?.choices?.[0]?.message?.content;
    if (text == null || String(text).trim() === '') {
      throw new AIError('DeepSeek returned empty content');
    }
    return String(text);
  }
}
