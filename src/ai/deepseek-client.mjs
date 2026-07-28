/**
 * DeepSeek via OpenAI-compatible Chat Completions API.
 * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
import OpenAI from 'openai';
import { AIError, BaseAIClient } from '../engine/index.mjs';
import {
  resolveLlmCallOptions,
  toDeepSeekRequestFields,
} from './llm-profile.mjs';

export class DeepSeekOpenAIClient extends BaseAIClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] default: process.env.DEEPSEEK_API_KEY
   * @param {string} [opts.baseURL] default: process.env.DEEPSEEK_BASE_URL || https://api.deepseek.com
   * @param {string} [opts.model] default resolved from LLM profile / DEEPSEEK_MODEL
   * @param {string} [opts.thinkingMode] off|high|max
   * @param {boolean} [opts.thinkingEnabled] legacy; maps to thinkingMode high/off
   * @param {string} [opts.reasoningEffort] legacy; maps to thinkingMode high/max
   * @param {string} [opts.defaultPhase] default phase for resolveLlmCallOptions
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

    this._env = opts.env ?? process.env;
    this.defaultPhase = opts.defaultPhase ?? null;
    this._defaultOverrides = {};
    if (opts.model) this._defaultOverrides.model = opts.model;
    if (opts.thinkingMode != null) this._defaultOverrides.thinkingMode = opts.thinkingMode;
    else if (opts.thinkingEnabled != null) {
      this._defaultOverrides.thinkingMode = opts.thinkingEnabled ? (opts.reasoningEffort || 'high') : 'off';
    } else if (opts.reasoningEffort) {
      this._defaultOverrides.thinkingMode = opts.reasoningEffort;
    }

    const resolved = resolveLlmCallOptions({
      phase: this.defaultPhase,
      env: this._env,
      overrides: Object.keys(this._defaultOverrides).length ? this._defaultOverrides : null,
    });
    this.model = resolved.model;
    this.thinkingMode = resolved.thinkingMode;
    // Legacy mirrors for older callers / doctor
    this.thinkingEnabled = resolved.thinkingMode !== 'off';
    this.reasoningEffort = resolved.thinkingMode === 'off' ? '' : resolved.thinkingMode;

    const timeoutSec = opts.timeout ?? this.timeout;
    this._openai = new OpenAI({
      apiKey: apiKey.trim(),
      baseURL: baseURL.replace(/\/$/, ''),
      timeout: Math.max(1, Number(timeoutSec) || 120) * 1000,
    });
  }

  /**
   * @param {object} [opts]
   */
  resolveCallOptions(opts = {}) {
    const overrides = { ...this._defaultOverrides };
    if (opts.model) overrides.model = opts.model;
    if (opts.thinkingMode != null) overrides.thinkingMode = opts.thinkingMode;
    else if (opts.thinking != null) overrides.thinking = opts.thinking;
    if (opts.profile) overrides.profile = opts.profile;
    return resolveLlmCallOptions({
      phase: opts.phase ?? this.defaultPhase,
      env: this._env,
      overrides: Object.keys(overrides).length ? overrides : null,
    });
  }

  /**
   * @param {string} message
   * @param {{ thinking?: string, timeout?: number, phase?: string }} [opts]
   */
  async _chatRaw(message, opts = {}) {
    return this.chatMessages([{ role: 'user', content: message }], opts);
  }

  /**
   * Chat Completions with usage metadata (prompt cache hit/miss tokens).
   * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
   * @param {{ thinking?: string, thinkingMode?: string, timeout?: number, phase?: string, model?: string }} [opts]
   * @returns {Promise<{ text: string, usage: object|null, model: string, thinkingMode: string }>}
   */
  async chatMessagesDetailed(messages, opts = {}) {
    const timeoutSec = opts.timeout ?? this.timeout;
    const callOpts = this.resolveCallOptions(opts);
    const fields = toDeepSeekRequestFields(callOpts);
    const body = {
      ...fields,
      messages,
      stream: false,
    };
    this._log(
      `DeepSeek chat model=${fields.model} thinking=${callOpts.thinkingMode}`
      + (fields.reasoning_effort ? ` effort=${fields.reasoning_effort}` : ''),
    );

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
    return {
      text: String(text),
      usage: completion?.usage ?? null,
      model: fields.model,
      thinkingMode: callOpts.thinkingMode,
    };
  }

  /**
   * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
   * @param {{ thinking?: string, thinkingMode?: string, timeout?: number, phase?: string, model?: string }} [opts]
   */
  async chatMessages(messages, opts = {}) {
    const result = await this.chatMessagesDetailed(messages, opts);
    return result.text;
  }

  /**
   * OpenAI-compatible Chat Completions with native function calling.
   * Callers must pass raw tool-capable messages (do NOT route through
   * messages.mjs normalizeMessages — it strips tool_calls / tool_call_id).
   *
   * @param {Array<object>} messages
   * @param {{ tools: object[], toolChoice?: string|object, timeout?: number, phase?: string, thinking?: string, thinkingMode?: string, model?: string }} opts
   * @returns {Promise<{
   *   content: string|null,
   *   reasoningContent: string|null,
   *   toolCalls: Array<{ id: string, name: string, arguments: object|null, argumentsRaw: string }>,
   *   finishReason: string,
   *   usage: object|null,
   *   rawMessage: object,
   * }>}
   */
  async chatMessagesWithTools(messages, opts = {}) {
    if (!Array.isArray(opts.tools) || !opts.tools.length) {
      throw new AIError('chatMessagesWithTools requires a non-empty tools array');
    }
    const timeoutSec = opts.timeout ?? this.timeout;
    const callOpts = this.resolveCallOptions(opts);
    const fields = toDeepSeekRequestFields(callOpts);
    const body = {
      ...fields,
      messages,
      stream: false,
      tools: opts.tools,
      tool_choice: opts.toolChoice ?? 'auto',
    };
    this._log(
      `DeepSeek tools model=${fields.model} thinking=${callOpts.thinkingMode}`
      + (fields.reasoning_effort ? ` effort=${fields.reasoning_effort}` : ''),
    );

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

    const choice = completion?.choices?.[0];
    const message = choice?.message ?? {};
    const content = message.content == null ? null : String(message.content);
    const reasoningContent = message.reasoning_content == null
      ? null
      : String(message.reasoning_content);
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls = rawCalls.map((call, idx) => {
      const argumentsRaw = String(call?.function?.arguments ?? '');
      let parsed = null;
      if (argumentsRaw.trim()) {
        try {
          parsed = JSON.parse(argumentsRaw);
        } catch {
          parsed = null;
        }
      } else {
        parsed = {};
      }
      return {
        id: call?.id || `tool_call_${idx}`,
        name: String(call?.function?.name || ''),
        arguments: parsed,
        argumentsRaw,
      };
    });

    if ((content == null || content.trim() === '') && toolCalls.length === 0) {
      throw new AIError('DeepSeek returned empty content and no tool_calls');
    }

    return {
      content,
      reasoningContent,
      toolCalls,
      finishReason: String(choice?.finish_reason || 'stop'),
      usage: completion?.usage ?? null,
      rawMessage: message,
    };
  }
}
