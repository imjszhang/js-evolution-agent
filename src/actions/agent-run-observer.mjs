import {
  appendAgentRunLogRecord,
  resolveAgentRunCycleId,
  resolveAgentRunLogPath,
} from './agent-run-log.mjs';

const CURSOR_PROVIDER = 'cursor_sdk';
const CLAUDE_PROVIDER = 'claude_code_sdk';
const LLM_PROVIDER = 'llm_only';
const REASONIX_PROVIDER = 'reasonix_cli';

export function agentRunLogEnabled() {
  const raw = process.env.JEA_AGENT_RUN_LOG;
  if (raw == null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

export function agentRunVerbose() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.JEA_AGENT_RUN_VERBOSE ?? '').trim().toLowerCase());
}

export function agentRunDeltaEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.JEA_AGENT_RUN_DELTA ?? '').trim().toLowerCase());
}

function resolveAgentLogger(ctx) {
  const logger = ctx?.host?.logger;
  if (logger?.info || logger?.warning || logger?.error) {
    return {
      info: (msg) => logger.info?.(msg),
      warning: (msg) => logger.warning?.(msg),
      error: (msg) => logger.error?.(msg),
    };
  }
  return {
    info: (msg) => console.log(msg),
    warning: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
  };
}

export function providerLogTag(provider) {
  if (String(provider ?? '').startsWith('acp:')) return 'acp';
  if (provider === CURSOR_PROVIDER) return 'cursor';
  if (provider === CLAUDE_PROVIDER) return 'claude';
  if (provider === REASONIX_PROVIDER) return 'reasonix';
  return 'llm';
}

export function summarizeAgentText(text, maxLen = 200) {
  const s = String(text ?? '').trim();
  if (agentRunVerbose()) return s;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[+${s.length - maxLen}]`;
}

export function summarizeToolInput(input, maxLen = 120) {
  if (input == null) return '';
  let s;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  if (agentRunVerbose()) return s;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[+${s.length - maxLen}]`;
}

function summarizeToolResult(result, maxLen = 120) {
  return summarizeToolInput(result, maxLen);
}

function formatAgentLogFields(fields = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

class TurnLogBuffer {
  constructor(obs) {
    this.obs = obs;
    this.chunks = [];
  }

  appendAssistant(text) {
    const s = String(text ?? '');
    if (!s) return;
    this.chunks.push(s);
    if (agentRunVerbose()) {
      this.obs.emit('assistant_text', { text: summarizeAgentText(s) });
    }
  }

  flushAssistant(reason = 'boundary') {
    if (!this.chunks.length) return;
    const merged = this.chunks.join('');
    this.chunks = [];
    if (!merged.trim()) return;
    this.obs.emit('assistant_segment', {
      text: summarizeAgentText(merged, agentRunVerbose() ? 2000 : 400),
      flush_reason: reason,
    });
    this.obs.noteActivity();
  }
}

export function createAgentRunObserver(ctx, { provider }) {
  const seenNativeTypes = new Set();
  const openTools = new Map();
  const toolStartTimes = new Map();
  let toolSeq = 0;
  const obs = {
    ctx,
    provider,
    buffer: null,
    seenNativeTypes,
    openTools,

    emit(event, fields = {}, level = 'info') {
      if (!agentRunLogEnabled()) return;
      if (event === 'jsonl_path') {
        const tag = providerLogTag(provider);
        const path = fields.path ?? resolveAgentRunLogPath(ctx, ctx?._agentRunLogMeta?.cycle_id ?? resolveAgentRunCycleId(ctx));
        if (path) resolveAgentLogger(ctx).info(`[agent:${tag}] jsonl_path path=${path}`);
        return;
      }
      const tag = providerLogTag(provider);
      const detail = formatAgentLogFields(fields);
      const msg = detail ? `[agent:${tag}] ${event} ${detail}` : `[agent:${tag}] ${event}`;
      resolveAgentLogger(ctx)[level]?.(msg);
      appendAgentRunLogRecord(ctx, {
        ts: new Date().toISOString(),
        provider,
        event,
        level,
        cycle_id: ctx?._agentRunLogMeta?.cycle_id ?? resolveAgentRunCycleId(ctx),
        action_id: ctx?._agentRunLogMeta?.action_id ?? null,
        action_type: ctx?._agentRunLogMeta?.action_type ?? null,
        ...fields,
      });
      this.noteActivity();
    },

    noteActivity() {
      this.lastActivityAt = Date.now();
    },

    emitJsonlPath() {
      const cycleId = ctx?._agentRunLogMeta?.cycle_id ?? resolveAgentRunCycleId(ctx);
      const filePath = resolveAgentRunLogPath(ctx, cycleId);
      if (filePath) this.emit('jsonl_path', { path: filePath });
    },

    beginTurn() {
      this.buffer = new TurnLogBuffer(this);
    },

    endTurn(fields = {}) {
      this.buffer?.flushAssistant('turn_finished');
      this.checkOpenTools('turn_finished');
      this.emit('turn_finished', fields);
      this.buffer = null;
    },

    toolKey(callId, name) {
      if (callId) return String(callId);
      toolSeq += 1;
      return `weak:${name ?? 'tool'}:${toolSeq}`;
    },

    markToolStarted(callId, name, inputSummary, source = 'stream') {
      this.buffer?.flushAssistant('tool_started');
      const key = this.toolKey(callId, name);
      if (openTools.has(key)) return key;
      // Cursor SDK may emit the same tool via assistant_block and on_delta/sdk_message.
      // If an open entry already exists for this name under a different source, skip duplicate.
      if (name) {
        for (const [existingKey, meta] of openTools.entries()) {
          if (meta?.name === name && meta?.source && meta.source !== source) {
            return existingKey;
          }
        }
      }
      openTools.set(key, { name, started_at: Date.now(), source });
      toolStartTimes.set(key, Date.now());
      this.emit('tool_started', {
        call_id: callId ?? null,
        name: name ?? 'tool',
        input_summary: inputSummary ?? '',
        source,
      });
      return key;
    },

    markToolFinished(callId, name, status, resultSummary) {
      let key = callId ? String(callId) : null;
      if (key && !openTools.has(key)) {
        // callId from finish event may not match start key; fall back by name.
        key = null;
      }
      if (!key) {
        key = [...openTools.keys()].find((k) => openTools.get(k)?.name === name) ?? null;
      }
      const startedAt = key ? toolStartTimes.get(key) : null;
      const durationMs = startedAt ? Date.now() - startedAt : null;
      if (key) {
        openTools.delete(key);
        toolStartTimes.delete(key);
      }
      this.emit('tool_finished', {
        call_id: callId ?? null,
        name: name ?? 'tool',
        status: status ?? 'completed',
        result_summary: resultSummary ?? '',
        duration_ms: durationMs,
      });
    },

    checkOpenTools(reason) {
      if (openTools.size === 0) return;
      for (const [key, meta] of openTools.entries()) {
        this.emit('capability_gap', {
          feature: 'tool_lifecycle',
          reason: 'incomplete',
          tool_key: key,
          tool_name: meta.name,
          context: reason,
        }, 'warning');
      }
      openTools.clear();
      toolStartTimes.clear();
    },

    noteNativeType(type) {
      if (!type || seenNativeTypes.has(type)) return;
      seenNativeTypes.add(type);
      this.emit('native_event', { native_type: type });
    },
  };

  obs.lastActivityAt = Date.now();
  return obs;
}

export function handleCursorSdkMessage(obs, event) {
  if (!event?.type) return;
  switch (event.type) {
    case 'tool_call': {
      const status = event.status ?? 'running';
      const name = event.name ?? 'tool';
      const inputSummary = summarizeToolInput(event.args);
      if (status === 'running') {
        obs.markToolStarted(event.call_id, name, inputSummary, 'sdk_message');
      } else {
        obs.markToolFinished(event.call_id, name, status, summarizeToolResult(event.result));
      }
      break;
    }
    case 'assistant': {
      const content = event.message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (block?.type === 'text' || typeof block?.text === 'string') {
          obs.buffer?.appendAssistant(block.text);
        } else if (block?.type === 'tool_use' || block?.name) {
          obs.markToolStarted(block.id ?? block.name, block.name ?? block.type ?? 'tool', summarizeToolInput(block.input), 'assistant_block');
        }
      }
      break;
    }
    case 'thinking':
      obs.buffer?.flushAssistant('thinking');
      obs.emit('thinking_segment', {
        text: summarizeAgentText(event.text, 300),
        thinking_duration_ms: event.thinking_duration_ms ?? null,
      });
      break;
    case 'system':
      if (event.subtype === 'init' || event.tools?.length) {
        obs.emit('native_event', {
          native_type: 'system_init',
          tools: Array.isArray(event.tools) ? event.tools.join(',') : null,
          model: event.model?.id ?? event.model ?? null,
        });
      }
      break;
    case 'status':
      obs.emit('native_event', {
        native_type: 'status',
        status: event.status ?? null,
        message: summarizeAgentText(event.message, 120),
      }, event.status === 'ERROR' ? 'warning' : 'info');
      break;
    case 'request':
      obs.emit('native_event', {
        native_type: 'request',
        request_id: event.request_id ?? null,
      }, 'warning');
      break;
    default:
      obs.noteNativeType(event.type);
      break;
  }
}

export async function consumeCursorRunStream(obs, run) {
  if (typeof run?.stream !== 'function') return;
  try {
    for await (const event of run.stream()) {
      handleCursorSdkMessage(obs, event);
    }
  } catch (e) {
    obs.emit('stream_error', {
      error: summarizeAgentText(e?.message || String(e), 300),
    }, 'warning');
  }
}

export function buildCursorSendOptions(obs) {
  if (!agentRunDeltaEnabled()) return undefined;
  return {
    onDelta: ({ update }) => {
      if (!update?.type) return;
      switch (update.type) {
        case 'text-delta':
          obs.buffer?.appendAssistant(update.text);
          break;
        case 'thinking-delta':
          if (agentRunVerbose()) obs.buffer?.appendAssistant(update.text);
          break;
        case 'tool-call-started': {
          const tc = update.toolCall ?? {};
          obs.markToolStarted(update.callId, tc.name ?? tc.type ?? 'tool', summarizeToolInput(tc.args ?? tc.input), 'on_delta');
          break;
        }
        case 'tool-call-completed': {
          const tc = update.toolCall ?? {};
          obs.markToolFinished(update.callId, tc.name ?? tc.type ?? 'tool', 'completed', summarizeToolResult(tc.result));
          break;
        }
        case 'partial-tool-call':
          break;
        default:
          break;
      }
    },
  };
}

export function handleClaudeAssistantMessage(obs, message, { textFromAssistant, toolUsesFromAssistant }) {
  for (const text of textFromAssistant(message)) {
    obs.buffer?.appendAssistant(text);
  }
  obs.buffer?.flushAssistant('assistant_message');
  for (const tool of toolUsesFromAssistant(message)) {
    obs.markToolStarted(tool.id ?? null, tool.name, summarizeToolInput(tool.input), 'claude_assistant');
  }
}

export function handleClaudeResultMessage(obs, message) {
  obs.emit('session_bound', {
    session_id: message.session_id ?? message.sessionId ?? null,
    subtype: message.subtype ?? null,
  });
}

export {
  CURSOR_PROVIDER,
  CLAUDE_PROVIDER,
  LLM_PROVIDER,
  REASONIX_PROVIDER,
};
