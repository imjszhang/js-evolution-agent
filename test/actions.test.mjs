import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  actionHandlers,
  actionVerifiers,
} from '../src/actions/handlers.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

let tempDir = null;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;

async function* streamMessages(messages) {
  for (const message of messages) yield message;
}

function makeCtx() {
  tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-actions-'));
  const projectRoot = join(tempDir, 'project');
  const dataRoot = join(projectRoot, 'runtime', 'subjects', 'test', 'data');
  mkdirSync(dataRoot, { recursive: true });
  return {
    cycleId: 'test-cycle',
    projectRoot,
    host: {
      sourceRoot: projectRoot,
      dataRoot,
      intelligenceStore: createIntelligenceStore({ baseDir: join(tempDir, 'intelligence') }),
    },
  };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (ORIGINAL_ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_ANTHROPIC_API_KEY;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
  if (ORIGINAL_ANTHROPIC_AUTH_TOKEN) {
    process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_ANTHROPIC_AUTH_TOKEN;
  } else {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
  delete process.env.CLAUDE_AGENT_MAX_TURNS;
  delete process.env.CLAUDE_AGENT_PERMISSION_MODE;
  delete process.env.CLAUDE_AGENT_SETTING_SOURCES;
  vi.clearAllMocks();
});

describe('controlled action handlers', () => {
  it('records observations through the intelligence store', () => {
    const ctx = makeCtx();
    const result = actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        source: 'test',
        subject: 'handler',
        content: 'handler wrote an observation',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 })[0].content)
      .toBe('handler wrote an observation');
  });

  it('requires bounded probe fields before recording a probe', () => {
    const ctx = makeCtx();
    expect(() => actionHandlers.propose_probe({
      type: 'propose_probe',
      params: { hypothesis: 'too little data' },
    }, ctx)).toThrow(/missing required field/);
  });

  it('records core requests without executing mutation', () => {
    const ctx = makeCtx();
    const action = {
      type: 'request_core_review',
      params: {
        target: 'engine core',
        rationale: 'needs approval',
        risks: ['mutation'],
      },
    };
    const result = actionHandlers.request_core_review(action, ctx);
    const verification = actionVerifiers.request_core_review.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(verification.status).toBe('improved');
  });

  it('delegates open-ended work to the configured AI agent and records a receipt', async () => {
    const ctx = {
      ...makeCtx(),
      ai: {
        async chatMessages(messages) {
          expect(messages[0].content).toContain('autonomous execution agent');
          expect(messages[1].content).toContain('Find the strongest next probe');
          return JSON.stringify({
            status: 'completed',
            summary: 'recommended a focused probe',
            outputs: { recommendation: 'inspect queue receipts' },
            verification_hints: ['check action receipt'],
            next_actions: ['queue a run_probe action'],
            confidence: 0.82,
          });
        },
        parseJsonFromText(text) {
          return JSON.parse(text);
        },
      },
    };

    const action = {
      type: 'agent_execute',
      description: 'Let the agent decide the next useful probe',
      params: {
        objective: 'Find the strongest next probe',
        mode: 'propose',
        context: 'Use recent intelligence and receipts.',
        acceptance: 'Return a concrete recommendation.',
      },
    };
    const result = await actionHandlers.agent_execute(action, ctx);
    const verification = actionVerifiers.agent_execute.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('llm_only');
    expect(result.agent.outputs.recommendation).toBe('inspect queue receipts');
    expect(verification.status).toBe('improved');
    expect(ctx.host.intelligenceStore.readActionReceipts({ limit: 5 })[0].action_type)
      .toBe('agent_execute');
  });

  it('defers reserved agent providers until they are configured', async () => {
    const ctx = makeCtx();
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: {
        objective: 'Try a Cursor-backed execution',
        provider: 'cursor_sdk',
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.error).toMatch(/reserved but not configured/);
  });

  it('delegates execution to Claude Code SDK and normalizes the receipt', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let captured = null;
    vi.mocked(claudeQuery).mockImplementation((args) => {
      captured = args;
      return streamMessages([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Inspecting the project.' },
              { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-session-1',
          result: JSON.stringify({
            status: 'completed',
            summary: 'Claude recommended a focused execution path.',
            outputs: { recommendation: 'run the queue verifier' },
            verification_hints: ['inspect Claude receipt'],
            confidence: 0.9,
          }),
        },
      ]);
    });

    const ctx = makeCtx();
    const action = {
      type: 'agent_execute',
      params: {
        provider: 'claude_code_sdk',
        objective: 'Use Claude Code SDK to recommend execution',
        mode: 'observe',
      },
    };
    const result = await actionHandlers.agent_execute(action, ctx);
    const verification = actionVerifiers.agent_execute.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.agent.outputs.recommendation).toBe('run the queue verifier');
    expect(result.agent.outputs.claude.session_id).toBe('claude-session-1');
    expect(result.agent.outputs.claude.tool_uses[0].name).toBe('Read');
    expect(captured.options.permissionMode).toBe('bypassPermissions');
    expect(captured.options.allowDangerouslySkipPermissions).toBe(true);
    expect(captured.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(captured.options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(verification.status).toBe('improved');
  });

  it('maps sandbox_patch to Claude editing tools while preserving overrides', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let captured = null;
    vi.mocked(claudeQuery).mockImplementation((args) => {
      captured = args;
      return streamMessages([
        {
          type: 'result',
          subtype: 'success',
          result: JSON.stringify({
            status: 'completed',
            summary: 'Sandbox patch completed.',
            modified_files: ['src/example.mjs'],
            test_results: [{ command: 'npm test', status: 'passed' }],
          }),
        },
      ]);
    });

    const ctx = makeCtx();
    const sandbox = join(ctx.projectRoot, 'sandbox');
    mkdirSync(sandbox, { recursive: true });
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: {
        provider: 'claude_code',
        objective: 'Patch in sandbox',
        mode: 'sandbox_patch',
        boundary: { sandbox },
        maxTurns: 3,
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(captured.options.cwd).toBe(sandbox);
    expect(captured.options.permissionMode).toBe('bypassPermissions');
    expect(captured.options.allowDangerouslySkipPermissions).toBe(true);
    expect(captured.options.allowedTools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
    expect(captured.options.maxTurns).toBe(3);
    expect(result.modified_files).toEqual(['src/example.mjs']);
  });

  it('defers Claude Code SDK provider when API credentials are missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: {
        provider: 'claude_agent_sdk',
        objective: 'Try Claude without credentials',
      },
    }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.error).toMatch(/ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
    expect(claudeQuery).not.toHaveBeenCalled();
  });

  it('runs read-only JSONL probes and records structured results', () => {
    const ctx = makeCtx();
    const target = join(ctx.host.dataRoot, 'events.jsonl');
    writeFileSync(target, '{"type":"event","status":"ok"}\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'jsonl_validate',
        target,
        required_fields: ['type', 'status'],
        hypothesis: 'events are valid JSONL',
        success_signal: 'all lines parse and include required fields',
        failure_signal: 'invalid JSONL or missing fields',
        death_boundary: 'read-only inspection only',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].probe_type)
      .toBe('jsonl_validate');
  });

  it('runs open-ended investigations without requiring a probe_type', () => {
    const ctx = makeCtx();
    writeFileSync(join(ctx.projectRoot, 'README.md'), '# Test Project\n\nEvolution runner evidence.\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Investigate evolution runner evidence in the project',
      params: {
        objective: 'Find evolution runner evidence',
        targets: [ctx.projectRoot],
        budget: { max_files: 10, max_steps: 5 },
      },
    }, ctx);

    const probeResult = ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0];
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(probeResult.probe_type).toBe('investigation');
    expect(probeResult.evidence.steps.some((step) => step.tool === 'keyword_search')).toBe(true);
  });

  it('infers keyword_search keywords from probe context', () => {
    const ctx = makeCtx();
    const target = join(ctx.projectRoot, 'README.md');
    writeFileSync(target, '# Test Project\n\nPending decisions are visible.\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Search for pending decisions',
      params: {
        probe_type: 'keyword_search',
        target,
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('blocks probes against sensitive files while still recording the outcome', () => {
    const ctx = makeCtx();
    const target = join(ctx.projectRoot, '.env');
    writeFileSync(target, 'SECRET=hidden\n', 'utf-8');

    const result = actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'file_exists',
        target,
        hypothesis: 'sensitive file exists',
        success_signal: 'file exists',
        failure_signal: 'file missing',
        death_boundary: 'do not read sensitive files',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('blocked');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].reason)
      .toMatch(/sensitive/);
  });
});

