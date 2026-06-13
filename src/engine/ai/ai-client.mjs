/**
 * AI Client interface and base implementation.
 *
 * The engine doesn't talk to any specific LLM provider. Hosts provide a
 * concrete AI client by either:
 *   1. Subclassing BaseAIClient and overriding `_chatRaw(message, opts)`, or
 *   2. Passing any object that satisfies `{ chat(msg, opts), chatJson(msg, opts) }`.
 *
 * BaseAIClient ships with robust JSON extraction (handles markdown fences,
 * trailing commas, and partial responses) so hosts only need to implement
 * the raw transport.
 */

function fixTrailingCommas(raw) {
  return raw.replace(/,(\s*[}\]])/g, '$1');
}

export class AIError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AIError';
  }
}

export class BaseAIClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.thinking]
   * @param {number} [opts.timeout] seconds
   * @param {string|null} [opts.model]
   * @param {object|null} [opts.logger]
   */
  constructor({ thinking = 'low', timeout = 120, model = null, logger = null } = {}) {
    this.thinking = thinking;
    this.timeout = timeout;
    this.model = model;
    this.logger = logger;
  }

  /**
   * Subclasses MUST override. Should return the raw model response text.
   * @param {string} _message
   * @param {{ thinking?: string, timeout?: number }} [_opts]
   * @returns {Promise<string>}
   */
  async _chatRaw(_message, _opts = {}) {
    throw new AIError('BaseAIClient._chatRaw not implemented. Subclass and override.');
  }

  /**
   * @param {string} message
   * @param {string} [thinking]
   * @param {number} [timeout]
   * @returns {Promise<string>}
   */
  async chat(message, thinking = null, timeout = null) {
    const t = thinking || this.thinking;
    const to = timeout || this.timeout;
    this._log(`AI chat (thinking=${t}, timeout=${to}s)`);
    const text = await this._chatRaw(message, { thinking: t, timeout: to });
    this._log(`AI response length: ${text?.length ?? 0} chars`);
    return text;
  }

  /**
   * @param {string} message
   * @param {string} [thinking]
   * @param {number} [timeout]
   * @returns {Promise<object>}
   */
  async chatJson(message, thinking = null, timeout = null) {
    const text = await this.chat(message, thinking, timeout);
    return this.parseJsonFromText(text);
  }

  /** @param {string} text @returns {object} */
  parseJsonFromText(text) {
    try { return JSON.parse(text.trim()); } catch {}

    const stripped = text.trim();
    if (stripped.startsWith('```')) {
      const firstNl = stripped.indexOf('\n');
      if (firstNl !== -1) {
        let inner = stripped.slice(firstNl + 1);
        if (inner.trimEnd().endsWith('```')) inner = inner.trimEnd().slice(0, -3).trimEnd();
        try { return JSON.parse(inner); } catch {}
      }
    }

    const jsonBlocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
    for (let i = jsonBlocks.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonBlocks[i][1].trim());
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }

    const codeFence = text.match(/```(?:json)?\s*\n/);
    if (codeFence) {
      const rest = text.slice(codeFence.index + codeFence[0].length);
      const firstBrace = rest.indexOf('{');
      const lastBrace = rest.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const raw = rest.slice(firstBrace, lastBrace + 1);
        for (const candidate of [raw, fixTrailingCommas(raw)]) {
          try { return JSON.parse(candidate); } catch {}
        }
      }
    }

    const lastBrace = text.lastIndexOf('}');
    if (lastBrace !== -1) {
      let depth = 0;
      for (let i = lastBrace; i >= 0; i--) {
        const ch = text[i];
        if (ch === '}') depth++;
        else if (ch === '{') {
          depth--;
          if (depth === 0) {
            const raw = text.slice(i, lastBrace + 1);
            for (const candidate of [raw, fixTrailingCommas(raw)]) {
              try { return JSON.parse(candidate); } catch {}
            }
            break;
          }
        }
      }
    }

    throw new AIError(`Cannot extract JSON from AI response. First 500 chars: ${text.slice(0, 500)}`);
  }

  _log(message, level = 'info') {
    if (this.logger) {
      const fn = this.logger[level] || this.logger.info;
      if (typeof fn === 'function') fn.call(this.logger, message);
    }
  }
}

/**
 * Minimal mock client for tests / demos. Returns canned responses keyed by
 * a substring of the prompt. Default response is `{}`.
 */
export class MockAIClient extends BaseAIClient {
  /**
   * @param {object} [opts]
   * @param {Array<{ match: string|RegExp, response: string|object }>} [opts.canned]
   * @param {string|object} [opts.defaultResponse]
   */
  constructor({ canned = [], defaultResponse = '{}', ...rest } = {}) {
    super(rest);
    this._canned = canned;
    this._default = defaultResponse;
  }

  async _chatRaw(message) {
    for (const { match, response } of this._canned) {
      const ok = match instanceof RegExp ? match.test(message) : message.includes(match);
      if (ok) return typeof response === 'string' ? response : JSON.stringify(response);
    }
    return typeof this._default === 'string' ? this._default : JSON.stringify(this._default);
  }
}
