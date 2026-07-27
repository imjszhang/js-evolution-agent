/**
 * Mock AI client that supports OpenAI-style tool calling for agent_loop tests.
 * Extends MockAIClient so canned chat/chatMessages paths remain available for
 * standing memory, diary, verify, etc.
 */
import { MockAIClient } from '../engine/index.mjs';

const DEFAULT_FINISH_REPORT = [
  '# Mock Agent Loop Report',
  '',
  '## Seen',
  '- Mock agent_loop finished without live model calls.',
  '',
  '## Inferred',
  '- Pipeline wiring is intact under JEA_FORCE_MOCK / MockToolsAIClient.',
  '',
  '## Cyber-Taoist analysis',
  '- Bootstrap / mock path only; no competitive claim.',
  '',
  '## Next cycle suggestions',
  '- Switch to a real DeepSeek client for production agent_loop runs.',
].join('\n');

const DEFAULT_INVESTIGATION = Object.freeze({
  findings_summary: 'Mock investigation: mechanical Seen and brief are sufficient for report drafting.',
  enough_for_report: true,
  gaps_closed: ['confirmed brief coverage'],
  open_gaps: [],
});

function normalizeScriptItem(item = {}) {
  if (item?.error != null) {
    return {
      error: String(item.error),
      content: null,
      toolCalls: [],
      finishReason: 'error',
      delayMs: Number(item.delayMs) || 0,
    };
  }
  const toolCalls = Array.isArray(item.toolCalls)
    ? item.toolCalls.map((call, idx) => ({
      id: call.id || `mock_call_${idx}`,
      name: String(call.name || ''),
      arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
      argumentsRaw: typeof call.arguments === 'string'
        ? call.arguments
        : JSON.stringify(call.arguments ?? {}),
    }))
    : [];
  return {
    content: item.content == null ? null : String(item.content),
    toolCalls,
    finishReason: item.finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
    delayMs: Number(item.delayMs) || 0,
  };
}

export class MockToolsAIClient extends MockAIClient {
  /**
   * @param {object} [opts]
   * @param {Array<{ toolCalls?: Array<{name:string, arguments?:object}>, content?: string }>} [opts.script]
   * @param {string} [opts.finishReport]
   * @param {Array} [opts.canned]
   * @param {string|object} [opts.defaultResponse]
   */
  constructor({
    script = [],
    finishReport = DEFAULT_FINISH_REPORT,
    investigation = null,
    canned = [],
    defaultResponse = '{}',
    ...rest
  } = {}) {
    super({ canned, defaultResponse, ...rest });
    this._script = Array.isArray(script) ? script.map(normalizeScriptItem) : [];
    this._scriptIndex = 0;
    this.finishReport = String(finishReport || DEFAULT_FINISH_REPORT);
    this.investigation = investigation && typeof investigation === 'object'
      ? { ...DEFAULT_INVESTIGATION, ...investigation }
      : { ...DEFAULT_INVESTIGATION };
  }

  /**
   * @param {Array<object>} messages
   * @param {{ tools?: object[], toolChoice?: string|object, timeout?: number }} [opts]
   */
  async chatMessagesWithTools(messages, opts = {}) {
    if (!Array.isArray(opts.tools) || !opts.tools.length) {
      throw new Error('MockToolsAIClient.chatMessagesWithTools requires a non-empty tools array');
    }
    void messages;

    if (this._scriptIndex < this._script.length) {
      const item = this._script[this._scriptIndex++];
      if (item.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, item.delayMs));
      }
      if (item.error) {
        throw new Error(item.error);
      }
      if ((item.content == null || item.content.trim() === '') && item.toolCalls.length === 0) {
        throw new Error('MockToolsAIClient script item has empty content and no tool_calls');
      }
      return {
        content: item.content,
        toolCalls: item.toolCalls,
        finishReason: item.finishReason,
        usage: null,
        rawMessage: {
          role: 'assistant',
          content: item.content,
          tool_calls: item.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: call.argumentsRaw,
            },
          })),
        },
      };
    }

    // Exhausted script: finish investigation so the host can draft the report.
    const finishArgs = {
      findings_summary: this.investigation.findings_summary,
      enough_for_report: this.investigation.enough_for_report !== false,
      gaps_closed: this.investigation.gaps_closed,
      open_gaps: this.investigation.open_gaps,
    };
    // Prefer finish_investigation; fall back only if tools list is legacy-only.
    const toolNames = (opts.tools || [])
      .map((t) => t?.function?.name || t?.name)
      .filter(Boolean);
    const finishName = toolNames.includes('finish_investigation')
      ? 'finish_investigation'
      : (toolNames.includes('finish_cycle') ? 'finish_cycle' : 'finish_investigation');
    const legacyFinishArgs = finishName === 'finish_cycle'
      ? {
        status: 'done',
        report_markdown: this.finishReport,
        key_findings: ['mock agent_loop auto-finish'],
        next_cycle_suggestions: ['Use a real model for production runs'],
      }
      : finishArgs;
    return {
      content: null,
      toolCalls: [{
        id: 'mock_finish',
        name: finishName,
        arguments: legacyFinishArgs,
        argumentsRaw: JSON.stringify(legacyFinishArgs),
      }],
      finishReason: 'tool_calls',
      usage: null,
      rawMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'mock_finish',
          type: 'function',
          function: {
            name: finishName,
            arguments: JSON.stringify(legacyFinishArgs),
          },
        }],
      },
    };
  }
}

export { DEFAULT_FINISH_REPORT, DEFAULT_INVESTIGATION };
