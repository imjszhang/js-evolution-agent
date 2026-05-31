import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  agentRunJsonlEnabled,
  appendAgentRunLogRecord,
  resolveAgentRunLogPath,
} from '../src/actions/agent-run-log.mjs';

let tempDir = null;
const ORIGINAL_JEA_AGENT_RUN_LOG = process.env.JEA_AGENT_RUN_LOG;
const ORIGINAL_JEA_AGENT_RUN_JSONL = process.env.JEA_AGENT_RUN_JSONL;

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
});

describe('agent-run-log', () => {
  it('appends structured records under data/evolution/agent-runs/<cycle>.jsonl', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-run-log-'));
    const dataRoot = join(tempDir, 'data');
    const ctx = {
      cycleId: 'cycle-20260531-test',
      host: { dataRoot },
    };

    const filePath = appendAgentRunLogRecord(ctx, {
      ts: '2026-05-31T00:00:00.000Z',
      provider: 'cursor_sdk',
      event: 'tool_call',
      level: 'info',
      cycle_id: 'cycle-20260531-test',
      name: 'Read',
      input: '{"path":"src/index.mjs"}',
    });

    expect(filePath).toBe(resolveAgentRunLogPath(ctx, 'cycle-20260531-test'));
    expect(existsSync(filePath)).toBe(true);
    const row = JSON.parse(readFileSync(filePath, 'utf-8').trim());
    expect(row.event).toBe('tool_call');
    expect(row.name).toBe('Read');
  });

  it('disables JSONL when JEA_AGENT_RUN_JSONL=0', () => {
    process.env.JEA_AGENT_RUN_JSONL = '0';
    expect(agentRunJsonlEnabled()).toBe(false);
  });
});
