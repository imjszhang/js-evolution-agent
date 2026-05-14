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
import { Agent, CursorAgentError } from '@cursor/sdk';
import {
  actionHandlers,
  actionVerifiers,
} from '../src/actions/handlers.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('@cursor/sdk', () => {
  class MockCursorAgentError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'CursorAgentError';
      this.isRetryable = !!options.isRetryable;
    }
  }
  return {
    Agent: {
      prompt: vi.fn(),
    },
    CursorAgentError: MockCursorAgentError,
  };
});

let tempDir = null;
const ORIGINAL_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
const ORIGINAL_CURSOR_API_KEY = process.env.CURSOR_API_KEY;
const ORIGINAL_JEA_AGENT_PROVIDER = process.env.JEA_AGENT_PROVIDER;

async function* streamMessages(messages) {
  for (const message of messages) yield message;
}

function directAgentParams(overrides = {}) {
  return {
    objective: 'Execute an open-ended task that no dedicated action type covers.',
    mode: 'propose',
    boundary: 'Do not mutate files unless this test explicitly provides a sandbox.',
    acceptance: 'Return a normalized agent action result.',
    escape_hatch_reason: 'This test exercises the direct agent_execute fallback path.',
    ...overrides,
  };
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

function makeAgenticCtx(agentResponse = null) {
  const ctx = makeCtx();
  const agentCalls = [];
  return {
    ...ctx,
    ai: {
      agentCalls,
      async chatMessages(messages) {
        agentCalls.push(messages);
        const response = typeof agentResponse === 'function'
          ? agentResponse(messages)
          : (agentResponse ?? {
            status: 'completed',
            summary: 'Phase 2 agent approved local finalization.',
            outputs: { approved: true },
            confidence: 0.8,
          });
        return JSON.stringify(response);
      },
      parseJsonFromText(text) {
        return JSON.parse(text);
      },
    },
  };
}

function installFakeWorktree(ctx, path = join(ctx.projectRoot, '.worktrees', 'fake-core-apply')) {
  const createCoreApplyWorktree = vi.fn(() => ({
    path,
    branch: 'jea/core-apply/fake-core-apply',
    auto_created: true,
    created: true,
    cleanup_hint: [
      `git worktree remove "${path}"`,
      'git branch -D "jea/core-apply/fake-core-apply"',
    ],
  }));
  ctx.host.createCoreApplyWorktree = createCoreApplyWorktree;
  return createCoreApplyWorktree;
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
  delete process.env.JEA_CORE_APPLY_POLICY;
  if (ORIGINAL_CURSOR_API_KEY) {
    process.env.CURSOR_API_KEY = ORIGINAL_CURSOR_API_KEY;
  } else {
    delete process.env.CURSOR_API_KEY;
  }
  delete process.env.CURSOR_AGENT_MODEL;
  delete process.env.CURSOR_AGENT_SETTING_SOURCES;
  if (ORIGINAL_JEA_AGENT_PROVIDER) {
    process.env.JEA_AGENT_PROVIDER = ORIGINAL_JEA_AGENT_PROVIDER;
  } else {
    delete process.env.JEA_AGENT_PROVIDER;
  }
  vi.clearAllMocks();
});

describe('controlled action handlers', () => {
  it('records observations through the intelligence store', async () => {
    const ctx = makeAgenticCtx();
    const result = await actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        source: 'test',
        subject: 'handler',
        content: 'handler wrote an observation',
        allow_legacy_fallback: true,
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.agentic_execution.provider).toBe('llm_only');
    expect(ctx.ai.agentCalls).toHaveLength(1);
    expect(ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 })[0].content)
      .toBe('handler wrote an observation');
  });

  it('prefers agent observation writes over the legacy observation finalizer', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Agent produced an observation write.',
      writes: {
        observations: [{
          source: 'agent',
          subject: 'phase2',
          kind: 'agent_write',
          content: 'agent-first observation',
          confidence: 'high',
        }],
      },
      evidence: { observations: ['agent selected the persisted observation'] },
      confidence: 0.9,
    });

    const result = await actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        source: 'legacy',
        subject: 'handler',
        content: 'legacy observation',
      },
    }, ctx);

    const observations = ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 });
    expect(result.success).toBe(true);
    expect(result.fallback_used).toBe(false);
    expect(result.writes_applied.observations).toBe(1);
    expect(observations[0].content).toBe('agent-first observation');
  });

  it('does not persist agent writes when approval is required', async () => {
    const ctx = makeAgenticCtx({
      status: 'requires_human_review',
      summary: 'Needs approval before writing.',
      requires_approval: true,
      writes: {
        observations: [{
          content: 'should not be written',
        }],
      },
    });

    const result = await actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        source: 'test',
        subject: 'approval',
        content: 'fallback should not run either',
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.requires_approval).toBe(true);
    expect(ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 })).toEqual([]);
  });

  it('requires bounded probe fields before recording a probe', async () => {
    const ctx = makeAgenticCtx();
    await expect(actionHandlers.propose_probe({
      type: 'propose_probe',
      params: { hypothesis: 'too little data' },
    }, ctx)).rejects.toThrow(/missing required field/);
  });

  it('records core requests without executing mutation', async () => {
    const ctx = makeAgenticCtx();
    const action = {
      type: 'request_core_review',
      params: {
        target: 'engine core',
        rationale: 'needs approval',
        risks: ['mutation'],
        allow_legacy_fallback: true,
      },
    };
    const result = await actionHandlers.request_core_review(action, ctx);
    const verification = actionVerifiers.request_core_review.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(result.agentic_execution.provider).toBe('llm_only');
    expect(verification.status).toBe('improved');
  });

  it('records core requests from params when agent writes are absent', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Core review request acknowledged, but no writes returned.',
      writes: {},
    });
    const action = {
      type: 'request_core_review',
      params: {
        target: 'safe-runtime boundary policy',
        rationale: 'read isolation scope needs operator review',
        risks: ['goal definition drift'],
        approval_needed: true,
      },
    };

    const result = await actionHandlers.request_core_review(action, ctx);
    const events = ctx.host.intelligenceStore.readEvolutionEvents({ limit: 5 });
    const receipts = ctx.host.intelligenceStore.readActionReceipts({ limit: 5 });
    const verification = actionVerifiers.request_core_review.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(result.fallback_used).toBe(false);
    expect(result.writes_applied.core_reviews).toBe(1);
    expect(events[0]).toMatchObject({
      type: 'core_review_requested',
      target: 'safe-runtime boundary policy',
      status: 'requires_human_review',
    });
    expect(receipts[0].result.message).toMatch(/action params/);
    expect(verification.status).toBe('improved');
  });

  function coreApplyAction(overrides = {}) {
    return {
      type: 'core_apply',
      params: {
        target: 'src/actions/handlers.mjs',
        rationale: 'exercise the core apply protocol',
        boundary: { death_boundary: 'test-only mutation boundary' },
        acceptance: 'Return diff, tests, and rollback evidence.',
        death_boundary: 'Only test fixtures may fail.',
        ...overrides,
      },
    };
  }

  it('blocks core_apply when the core policy is disabled without calling the agent', async () => {
    process.env.JEA_CORE_APPLY_POLICY = 'disabled';
    const ctx = makeAgenticCtx();

    const result = await actionHandlers.core_apply(coreApplyAction(), ctx);
    const verification = actionVerifiers.core_apply.verify(coreApplyAction(), result);

    expect(result.success).toBe(false);
    expect(result.requires_approval).toBe(true);
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(verification.status).toBe('partial');
  });

  it('keeps core_apply in human review by default without approval or sandbox', async () => {
    const ctx = makeAgenticCtx();

    const action = coreApplyAction();
    const result = await actionHandlers.core_apply(action, ctx);
    const verification = actionVerifiers.core_apply.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(result.policy).toBe('review');
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(verification.status).toBe('partial');
  });

  it('executes core_apply in review policy when explicit approval is granted', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Applied approved core patch.',
      modified_files: ['src/actions/handlers.mjs'],
      test_results: [{ command: 'npm test', status: 'passed' }],
      evidence: {
        changed_files: ['src/actions/handlers.mjs'],
        diff_summary: 'Added core apply policy handler.',
        rollback_plan: 'Revert the core_apply patch.',
        death_boundary_result: 'No fixture damage.',
      },
      confidence: 0.9,
    });
    const createCoreApplyWorktree = installFakeWorktree(ctx);

    const action = coreApplyAction({ approval_granted: true });
    const result = await actionHandlers.core_apply(action, ctx);
    const verification = actionVerifiers.core_apply.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(false);
    expect(createCoreApplyWorktree).toHaveBeenCalledOnce();
    expect(ctx.ai.agentCalls[0][1].content).toContain('mode: core_apply');
    expect(ctx.ai.agentCalls[0][1].content).toContain('.worktrees');
    expect(result.core_apply_audit.complete).toBe(true);
    expect(result.core_apply_audit.worktree.auto_created).toBe(true);
    expect(verification.status).toBe('improved');
  });

  it('allows auto core_apply but marks incomplete audit evidence as partial', async () => {
    process.env.JEA_CORE_APPLY_POLICY = 'auto';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Changed core without enough audit evidence.',
      modified_files: ['src/actions/handlers.mjs'],
      evidence: { diff_summary: 'Changed a handler.' },
    });
    installFakeWorktree(ctx);

    const action = coreApplyAction();
    const result = await actionHandlers.core_apply(action, ctx);
    const verification = actionVerifiers.core_apply.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(false);
    expect(result.core_apply_audit.complete).toBe(false);
    expect(result.core_apply_audit.worktree.path).toContain('.worktrees');
    expect(verification.status).toBe('partial');
  });

  it('marks auto core_apply with full audit evidence as improved', async () => {
    process.env.JEA_CORE_APPLY_POLICY = 'auto';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Changed core with audit evidence.',
      modified_files: ['src/actions/handlers.mjs'],
      test_results: [{ command: 'npm test', status: 'passed' }],
      evidence: {
        diff_summary: 'Registered core_apply verifier.',
        rollback_plan: 'Revert the focused handler diff.',
        death_boundary_result: 'No core death boundary breach.',
      },
    });
    installFakeWorktree(ctx);

    const action = coreApplyAction();
    const result = await actionHandlers.core_apply(action, ctx);
    const verification = actionVerifiers.core_apply.verify(action, result);

    expect(result.success).toBe(true);
    expect(result.core_apply_audit.complete).toBe(true);
    expect(result.core_apply_audit.worktree.cleanup_hint[0]).toContain('git worktree remove');
    expect(verification.status).toBe('improved');
  });

  it('uses an explicit worktree without auto-creating one', async () => {
    const explicitWorktree = join(tempDir ?? tmpdir(), 'explicit-worktree');
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Changed core in explicit worktree.',
      modified_files: ['src/actions/handlers.mjs'],
      test_results: [{ command: 'npm test', status: 'passed' }],
      evidence: {
        diff_summary: 'Used explicit worktree.',
        rollback_plan: 'Remove explicit worktree changes.',
        death_boundary_result: 'No boundary breach.',
      },
    });
    const createCoreApplyWorktree = installFakeWorktree(ctx);

    const action = coreApplyAction({
      approval_granted: true,
      boundary: { worktree: explicitWorktree, death_boundary: 'test-only mutation boundary' },
    });
    const result = await actionHandlers.core_apply(action, ctx);

    expect(createCoreApplyWorktree).not.toHaveBeenCalled();
    expect(result.core_apply_audit.worktree).toMatchObject({
      path: explicitWorktree,
      auto_created: false,
    });
  });

  it('blocks core_apply when automatic worktree creation fails', async () => {
    process.env.JEA_CORE_APPLY_POLICY = 'auto';
    const ctx = makeAgenticCtx();
    ctx.host.createCoreApplyWorktree = vi.fn(() => {
      throw new Error('git worktree add failed');
    });

    const action = coreApplyAction();
    const result = await actionHandlers.core_apply(action, ctx);
    const verification = actionVerifiers.core_apply.verify(action, result);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.requires_approval).toBe(true);
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(result.evidence.worktree_error).toContain('git worktree add failed');
    expect(verification.status).toBe('partial');
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
      params: directAgentParams({
        objective: 'Find the strongest next probe',
        mode: 'propose',
        context: 'Use recent intelligence and receipts.',
        acceptance: 'Return a concrete recommendation.',
      }),
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

  it('requires explicit escape-hatch boundaries for direct agent execution', async () => {
    await expect(actionHandlers.agent_execute({
      type: 'agent_execute',
      params: {
        objective: 'Do an underspecified open-ended task',
      },
    }, makeCtx())).rejects.toThrow(/mode, boundary, acceptance, escape_hatch_reason/);
  });

  it('defers reserved agent providers until they are configured', async () => {
    const ctx = makeCtx();
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Try a reserved CLI-backed execution',
        provider: 'cli_agent',
      }),
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.error).toMatch(/reserved but not configured/);
  });

  it('delegates execution to Cursor SDK local runtime and normalizes the receipt', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    process.env.CURSOR_AGENT_SETTING_SOURCES = 'project,user';
    let capturedPrompt = null;
    let capturedOptions = null;
    vi.mocked(Agent.prompt).mockImplementation(async (prompt, options) => {
      capturedPrompt = prompt;
      capturedOptions = options;
      return {
        id: 'cursor-run-1',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Cursor recommended a focused execution path.',
          outputs: { recommendation: 'inspect Cursor receipt' },
          verification_hints: ['inspect Cursor SDK run id'],
          confidence: 0.88,
        }),
        model: { id: 'composer-2' },
        durationMs: 1200,
      };
    });

    const ctx = makeCtx();
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Use Cursor SDK to recommend execution',
        mode: 'observe',
      }),
    }, ctx);
    const verification = actionVerifiers.agent_execute.verify(null, result);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cursor_sdk');
    expect(result.agent.outputs.recommendation).toBe('inspect Cursor receipt');
    expect(result.agent.outputs.cursor.run_id).toBe('cursor-run-1');
    expect(capturedPrompt).toContain('Cursor SDK local runtime note');
    expect(capturedOptions.apiKey).toBe('cursor-test-key');
    expect(capturedOptions.model).toEqual({ id: 'composer-2' });
    expect(capturedOptions.local.cwd).toBe(ctx.projectRoot);
    expect(capturedOptions.local.settingSources).toEqual(['project', 'user']);
    expect(verification.status).toBe('improved');
  });

  it('uses JEA_AGENT_PROVIDER as the default agent provider', async () => {
    process.env.JEA_AGENT_PROVIDER = 'cursor_sdk';
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    vi.mocked(Agent.prompt).mockResolvedValue({
      id: 'cursor-run-default',
      status: 'finished',
      result: JSON.stringify({
        status: 'completed',
        summary: 'Cursor default provider completed.',
      }),
    });

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Use the configured default provider',
      }),
    }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cursor_sdk');
    expect(result.agent.outputs.cursor.run_id).toBe('cursor-run-default');
    expect(Agent.prompt).toHaveBeenCalledOnce();
  });

  it('allows action provider to override JEA_AGENT_PROVIDER', async () => {
    process.env.JEA_AGENT_PROVIDER = 'cursor_sdk';
    const ctx = {
      ...makeCtx(),
      ai: {
        async chatMessages() {
          return JSON.stringify({
            status: 'completed',
            summary: 'LLM override completed.',
          });
        },
        parseJsonFromText(text) {
          return JSON.parse(text);
        },
      },
    };

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'llm_only',
        objective: 'Override the configured default provider',
      }),
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('llm_only');
    expect(result.agent.summary).toBe('LLM override completed.');
    expect(Agent.prompt).not.toHaveBeenCalled();
  });

  it('supports Claude SDK as the configured default provider', async () => {
    process.env.JEA_AGENT_PROVIDER = 'claude_code_sdk';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(claudeQuery).mockImplementation(() => streamMessages([
      {
        type: 'result',
        subtype: 'success',
        session_id: 'claude-default-session',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Claude default provider completed.',
        }),
      },
    ]));

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Use Claude as the configured default provider',
      }),
    }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.agent.outputs.claude.session_id).toBe('claude-default-session');
    expect(claudeQuery).toHaveBeenCalledOnce();
  });

  it('requires Cursor SDK credentials before execution', async () => {
    delete process.env.CURSOR_API_KEY;
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor',
        objective: 'Try Cursor without credentials',
      }),
    }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.provider).toBe('cursor_sdk');
    expect(result.error).toMatch(/CURSOR_API_KEY/);
    expect(Agent.prompt).not.toHaveBeenCalled();
  });

  it('defers Cursor SDK startup failures with retry metadata', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    vi.mocked(Agent.prompt).mockRejectedValue(new CursorAgentError('temporary outage', { isRetryable: true }));

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Run Cursor despite a startup failure',
      }),
    }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.provider).toBe('cursor_sdk');
    expect(result.error).toMatch(/temporary outage/);
  });

  it('requires an explicit sandbox before Cursor SDK sandbox_patch execution', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Patch without a sandbox',
        mode: 'sandbox_patch',
      }),
    }, makeCtx());

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(result.status).toBe('requires_human_review');
    expect(Agent.prompt).not.toHaveBeenCalled();
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
      params: directAgentParams({
        provider: 'claude_code_sdk',
        objective: 'Use Claude Code SDK to recommend execution',
        mode: 'observe',
      }),
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
      params: directAgentParams({
        provider: 'claude_code',
        objective: 'Patch in sandbox',
        mode: 'sandbox_patch',
        boundary: { sandbox },
        maxTurns: 3,
      }),
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
      params: directAgentParams({
        provider: 'claude_agent_sdk',
        objective: 'Try Claude without credentials',
      }),
    }, makeCtx());

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.error).toMatch(/ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
    expect(claudeQuery).not.toHaveBeenCalled();
  });

  it('runs read-only JSONL probes and records structured results', async () => {
    const ctx = makeAgenticCtx();
    const target = join(ctx.host.dataRoot, 'events.jsonl');
    writeFileSync(target, '{"type":"event","status":"ok"}\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'jsonl_validate',
        target,
        allow_legacy_fallback: true,
        required_fields: ['type', 'status'],
        hypothesis: 'events are valid JSONL',
        success_signal: 'all lines parse and include required fields',
        failure_signal: 'invalid JSONL or missing fields',
        death_boundary: 'read-only inspection only',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.agentic_execution.provider).toBe('llm_only');
    expect(ctx.ai.agentCalls[0][1].content).toContain('Agentic execution task');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].probe_type)
      .toBe('jsonl_validate');
  });

  it('records agent probe evidence without using the read-only finalizer', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Agent verified runtime evidence directly.',
      evidence: {
        files_read: ['runtime/subjects/test/data/goals/active_goals.json'],
        observations: ['safe-runtime goal exists'],
        matches: [{ path: 'runtime/subjects/test/data/goals/active_goals.json', text: 'safe-runtime' }],
      },
      confidence: 0.85,
    });

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Investigate safe-runtime goal evidence',
      params: {
        probe_type: 'file_exists',
        target: join(ctx.projectRoot, 'does-not-exist.json'),
      },
    }, ctx);

    const probeResult = ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0];
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.fallback_used).toBe(false);
    expect(result.synthesized_probe_result).toBe(true);
    expect(probeResult.probe_type).toBe('file_exists');
    expect(probeResult.evidence.observations).toEqual(['safe-runtime goal exists']);
  });

  it('does not use the legacy probe finalizer unless explicitly requested', async () => {
    const ctx = makeAgenticCtx();
    const target = join(ctx.projectRoot, 'README.md');
    writeFileSync(target, '# Test Project\n\nPending decisions are visible.\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Search for pending decisions',
      params: {
        probe_type: 'keyword_search',
        target,
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.fallback_used).toBe(false);
    expect(result.missing_agent_artifacts).toBe('evidence or writes.probe_results');
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })).toEqual([]);
  });

  it('marks empty agent investigation receipts as partial in mechanical verification', () => {
    const verification = actionVerifiers.run_probe.verify({ type: 'run_probe' }, {
      success: true,
      status: 'completed',
      message: 'agent completed without evidence',
      provider: 'llm_only',
      evidence: {},
      writes: {},
      fallback_used: false,
      agentic_execution: { provider: 'llm_only' },
    });

    expect(verification.metric).toBe('agent_action_result');
    expect(verification.status).toBe('partial');
    expect(verification.value.evidence_count).toBe(0);
  });

  it('runs open-ended investigations without requiring a probe_type', async () => {
    const ctx = makeAgenticCtx();
    writeFileSync(join(ctx.projectRoot, 'README.md'), '# Test Project\n\nEvolution runner evidence.\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Investigate evolution runner evidence in the project',
      params: {
        objective: 'Find evolution runner evidence',
        targets: [ctx.projectRoot],
        allow_legacy_fallback: true,
        budget: { max_files: 10, max_steps: 5 },
      },
    }, ctx);

    const probeResult = ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0];
    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(probeResult.probe_type).toBe('investigation');
    expect(probeResult.evidence.steps.some((step) => step.tool === 'keyword_search')).toBe(true);
  });

  it('infers keyword_search keywords from probe context', async () => {
    const ctx = makeAgenticCtx();
    const target = join(ctx.projectRoot, 'README.md');
    writeFileSync(target, '# Test Project\n\nPending decisions are visible.\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      description: 'Search for pending decisions',
      params: {
        probe_type: 'keyword_search',
        target,
        allow_legacy_fallback: true,
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('succeeded');
  });

  it('blocks probes against sensitive files before agent execution', async () => {
    const ctx = makeAgenticCtx();
    const target = join(ctx.projectRoot, '.env');
    writeFileSync(target, 'SECRET=hidden\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'file_exists',
        target,
        allow_legacy_fallback: true,
        hypothesis: 'sensitive file exists',
        success_signal: 'file exists',
        failure_signal: 'file missing',
        death_boundary: 'do not read sensitive files',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.status).toBe('blocked');
    expect(result.host_boundary_preflight).toBe(true);
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0].reason)
      .toMatch(/sensitive/);
  });

  it('keeps mixed-target probes local when any target violates the host read boundary', async () => {
    const ctx = makeAgenticCtx();
    const safeTarget = join(ctx.projectRoot, 'README.md');
    const sensitiveTarget = join(ctx.projectRoot, '.env');
    writeFileSync(safeTarget, '# Test Project\n', 'utf-8');
    writeFileSync(sensitiveTarget, 'SECRET=hidden\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'investigation',
        targets: [safeTarget, sensitiveTarget],
        death_boundary: 'do not read sensitive files',
      },
    }, ctx);

    const probeResult = ctx.host.intelligenceStore.readProbeResults({ limit: 5 })[0];
    expect(result.success).toBe(true);
    expect(result.host_boundary_preflight).toBe(true);
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(probeResult.evidence.steps.some((step) => step.status === 'blocked')).toBe(true);
    expect(JSON.stringify(probeResult)).not.toContain('SECRET=hidden');
  });
});

