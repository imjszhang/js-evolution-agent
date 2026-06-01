import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  agentRunLogEnabled,
  consumeCursorRunStream,
  createAgentRunObserver,
  handleClaudeAssistantMessage,
  handleCursorSdkMessage,
  providerLogTag,
} from '../src/actions/agent-run-observer.mjs';

let tempDir = null;
const ORIGINAL_JEA_AGENT_RUN_LOG = process.env.JEA_AGENT_RUN_LOG;
const ORIGINAL_JEA_AGENT_RUN_JSONL = process.env.JEA_AGENT_RUN_JSONL;
const ORIGINAL_JEA_AGENT_RUN_VERBOSE = process.env.JEA_AGENT_RUN_VERBOSE;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (ORIGINAL_JEA_AGENT_RUN_LOG) {
    process.env.JEA_AGENT_RUN_LOG = ORIGINAL_JEA_AGENT_RUN_LOG;
  } else {
    delete process.env.JEA_AGENT_RUN_LOG;
  }
  if (ORIGINAL_JEA_AGENT_RUN_JSONL) {
    process.env.JEA_AGENT_RUN_JSONL = ORIGINAL_JEA_AGENT_RUN_JSONL;
  } else {
    delete process.env.JEA_AGENT_RUN_JSONL;
  }
  if (ORIGINAL_JEA_AGENT_RUN_VERBOSE) {
    process.env.JEA_AGENT_RUN_VERBOSE = ORIGINAL_JEA_AGENT_RUN_VERBOSE;
  } else {
    delete process.env.JEA_AGENT_RUN_VERBOSE;
  }
});

function makeCtx() {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-run-observer-'));
  const dataRoot = join(tempDir, 'data');
  return {
    cycleId: 'cycle-observer-test',
    host: {
      dataRoot,
      logger: {
        info: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
      },
    },
    _agentRunLogMeta: {
      cycle_id: 'cycle-observer-test',
      action_id: 'act-1',
      action_type: 'agent_execute',
    },
  };
}

function jsonlRows(ctx) {
  const filePath = join(ctx.host.dataRoot, 'evolution', 'agent-runs', 'cycle-observer-test.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('agent-run-observer', () => {
  it('merges assistant chunks into a single assistant_segment on flush', () => {
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'cursor_sdk' });
    obs.beginTurn();
    obs.buffer.appendAssistant('Hello ');
    obs.buffer.appendAssistant('world.');
    obs.buffer.flushAssistant('test');

    const rows = jsonlRows(ctx);
    const segments = rows.filter((row) => row.event === 'assistant_segment');
    expect(segments).toHaveLength(1);
    expect(segments[0].text).toContain('Hello world.');
    expect(rows.filter((row) => row.event === 'assistant_text')).toHaveLength(0);
  });

  it('maps top-level Cursor tool_call running/completed to tool_started/finished', () => {
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'cursor_sdk' });
    obs.beginTurn();
    handleCursorSdkMessage(obs, {
      type: 'tool_call',
      call_id: 'tc-1',
      name: 'Shell',
      status: 'running',
      args: { command: 'npm test' },
    });
    handleCursorSdkMessage(obs, {
      type: 'tool_call',
      call_id: 'tc-1',
      name: 'Shell',
      status: 'completed',
      result: 'ok',
    });

    const rows = jsonlRows(ctx);
    expect(rows.some((row) => row.event === 'tool_started' && row.name === 'Shell')).toBe(true);
    expect(rows.some((row) => row.event === 'tool_finished' && row.name === 'Shell')).toBe(true);
  });

  it('emits capability_gap for incomplete Claude tool lifecycle at turn end', () => {
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'claude_code_sdk' });
    obs.beginTurn();
    handleClaudeAssistantMessage(obs, {
      message: {
        content: [
          { type: 'text', text: 'Searching.' },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    }, {
      textFromAssistant: (message) => message.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text),
      toolUsesFromAssistant: (message) => message.message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ name: block.name, input: block.input })),
    });
    obs.endTurn({ turn: 'initial' });

    const rows = jsonlRows(ctx);
    expect(rows.some((row) => row.event === 'tool_started' && row.name === 'Grep')).toBe(true);
    expect(rows.some((row) => row.event === 'capability_gap' && row.feature === 'tool_lifecycle')).toBe(true);
  });

  it('consumeCursorRunStream walks async stream events', async () => {
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'cursor_sdk' });
    obs.beginTurn();
    await consumeCursorRunStream(obs, {
      stream: async function* stream() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } };
        yield {
          type: 'tool_call',
          call_id: 'x1',
          name: 'Read',
          status: 'running',
          args: {},
        };
        yield {
          type: 'tool_call',
          call_id: 'x1',
          name: 'Read',
          status: 'completed',
          result: 'data',
        };
      },
    });

    const rows = jsonlRows(ctx);
    expect(rows.some((row) => row.event === 'assistant_segment')).toBe(true);
    expect(rows.some((row) => row.event === 'tool_finished' && row.name === 'Read')).toBe(true);
  });

  it('respects JEA_AGENT_RUN_LOG=0', () => {
    process.env.JEA_AGENT_RUN_LOG = '0';
    expect(agentRunLogEnabled()).toBe(false);
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'llm_only' });
    obs.emit('provider_start', {});
    expect(ctx.host.logger.info).not.toHaveBeenCalled();
    expect(jsonlRows(ctx)).toHaveLength(0);
  });

  it('maps Reasonix provider logs to the reasonix tag', () => {
    expect(providerLogTag('reasonix_cli')).toBe('reasonix');
    const ctx = makeCtx();
    const obs = createAgentRunObserver(ctx, { provider: 'reasonix_cli' });
    obs.emit('provider_start', { cwd: ctx.host.dataRoot });
    expect(ctx.host.logger.info.mock.calls[0][0]).toContain('[agent:reasonix]');
  });
});
