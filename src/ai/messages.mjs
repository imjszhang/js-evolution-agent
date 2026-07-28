/**
 * Small compatibility layer for OpenAI-style chat messages.
 *
 * DeepSeekOpenAIClient supports messages natively. Tests and local mock clients
 * may only implement `chat`, so we serialize messages into a readable transcript
 * as a fallback.
 */

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('messages must be a non-empty array');
  }
  return messages.map((msg) => ({
    role: msg?.role || 'user',
    content: String(msg?.content ?? ''),
  }));
}

export function serializeMessages(messages) {
  return normalizeMessages(messages)
    .map((msg) => `### ${String(msg.role).toUpperCase()}\n${msg.content}`)
    .join('\n\n---\n\n');
}

export async function chatMessages(aiClient, messages, opts = {}) {
  if (!aiClient) throw new Error('aiClient is required');
  const normalized = normalizeMessages(messages);
  if (typeof aiClient.chatMessages === 'function') {
    return aiClient.chatMessages(normalized, opts);
  }
  if (typeof aiClient.chat === 'function') {
    return aiClient.chat(
      serializeMessages(normalized),
      opts.thinking ?? null,
      opts.timeout ?? null,
    );
  }
  throw new Error('aiClient must implement chatMessages or chat');
}

/**
 * Like chatMessages, but returns `{ text, usage }` when the client exposes
 * chatMessagesDetailed (DeepSeek). Falls back to `{ text, usage: null }` for
 * mock / chat-only clients.
 *
 * @returns {Promise<{ text: string, usage: object|null, model?: string|null, thinkingMode?: string|null }>}
 */
export async function chatMessagesDetailed(aiClient, messages, opts = {}) {
  if (!aiClient) throw new Error('aiClient is required');
  const normalized = normalizeMessages(messages);
  if (typeof aiClient.chatMessagesDetailed === 'function') {
    const result = await aiClient.chatMessagesDetailed(normalized, opts);
    if (result && typeof result === 'object' && result.text != null) {
      return {
        text: String(result.text),
        usage: result.usage ?? null,
        model: result.model ?? null,
        thinkingMode: result.thinkingMode ?? null,
      };
    }
    return { text: String(result ?? ''), usage: null, model: null, thinkingMode: null };
  }
  const text = await chatMessages(aiClient, normalized, opts);
  return { text, usage: null, model: null, thinkingMode: null };
}

function stripJsonCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function extractJsonFromText(text) {
  const stripped = stripJsonCodeFence(text);
  if (!stripped) {
    throw new Error('Cannot extract JSON from AI response. First 500 chars: ');
  }
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        // Fall through to a consistent error message below.
      }
    }
  }
  throw new Error(`Cannot extract JSON from AI response. First 500 chars: ${stripped.slice(0, 500)}`);
}

export function parseJsonFromText(aiClient, text) {
  if (aiClient && typeof aiClient.parseJsonFromText === 'function') {
    try {
      return aiClient.parseJsonFromText(text);
    } catch {
      return extractJsonFromText(text);
    }
  }
  return extractJsonFromText(text);
}

export async function chatMessagesJson(aiClient, messages, opts = {}) {
  const text = await chatMessages(aiClient, messages, opts);
  return parseJsonFromText(aiClient, text);
}
