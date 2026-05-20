import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { runReadOnlyProbe } from '../src/actions/probe-runner.mjs';
import * as configuredActions from '../src/actions/configured-actions.mjs';
import { runConfiguredExternalAction } from '../src/actions/configured-external-runner.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  parseSubjectExternalRoots,
  parseSubjectResourceRules,
} from '../src/cli/utils/subjects.mjs';

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
      create: vi.fn(),
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

function makeAgentProviderCtx(taskPrompt = 'Human task prompt for the code agent.') {
  const ctx = makeCtx();
  const translationCalls = [];
  return {
    ...ctx,
    ai: {
      translationCalls,
      async chatMessages(messages) {
        translationCalls.push(messages);
        return taskPrompt;
      },
      parseJsonFromText(text) {
        return JSON.parse(text);
      },
    },
  };
}

function mockCursorSession(results, onCreate = null) {
  const prompts = [];
  const send = vi.fn(async (prompt) => {
    prompts.push(prompt);
    const result = typeof results === 'function' ? results(prompt, prompts.length) : results.shift();
    return {
      id: result?.id,
      wait: vi.fn(async () => result),
    };
  });
  const dispose = vi.fn(async () => {});
  vi.mocked(Agent.create).mockImplementation((options) => {
    onCreate?.(options);
    return {
      send,
      [Symbol.asyncDispose]: dispose,
    };
  });
  return { prompts, send, dispose };
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function installConfiguredActionProject(ctx) {
  mkdirSync(join(ctx.projectRoot, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(ctx.projectRoot, 'runtime', 'subjects', 'configured-test', 'data', 'config'), { recursive: true });
  writeJsonFile(join(ctx.projectRoot, 'policies', 'active-subject.json'), {
    active: 'configured-test',
    policy: 'subjects/configured-test.md',
    data_namespace: 'configured-test',
  });
  writeFileSync(join(ctx.projectRoot, 'policies', 'subjects', 'configured-test.md'), '# configured test\n', 'utf-8');
  writeJsonFile(join(ctx.projectRoot, 'runtime', 'subjects', 'configured-test', 'data', 'config', 'actions.json'), {
    external_tools: {
      test_tool: { root: join(ctx.projectRoot, 'tool'), entry: 'src/cli.mjs' },
    },
    actions: [
      {
        name: 'configured_sync',
        tool: 'test_tool',
        command: 'sync',
        description: 'Sync configured test context',
        defaultRisk: 'low',
        defaultPriority: 'high',
        layer: 'probe',
        params: { allowed: ['limit'] },
      },
      {
        name: 'configured_challenge_request',
        tool: 'test_tool',
        command: 'challenge-request',
        description: 'Record configured challenge request',
        defaultRisk: 'high',
        defaultPriority: 'medium',
        layer: 'core',
        params: { allowed: ['opponentTankId', 'map'] },
      },
    ],
  });
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
  it('parses external resource roots from subject policy text', () => {
    const roots = parseSubjectExternalRoots([
      '- 外部项目 root 是 `D:\\github\\My\\external-project`；处理资源时使用 `resource_scope=strategy_repo`。',
      '- Runtime uses `resource_scope=subject_runtime` and host uses `resource_scope=source_root`.',
    ].join('\n'));

    expect(roots).toEqual({
      strategy_repo: 'D:\\github\\My\\external-project',
    });
  });

  it('parses external resource rules from subject policy text', () => {
    const rules = parseSubjectResourceRules([
      '- 外部资源映射：`data/candidates/**`、`data/scores/**` 属于 `resource_scope=strategy_repo`。',
    ].join('\n'));

    expect(rules).toEqual([
      { kind: 'strategy_repo_candidates', scope: 'strategy_repo', patterns: ['data/candidates/**'] },
      { kind: 'strategy_repo_scores', scope: 'strategy_repo', patterns: ['data/scores/**'] },
    ]);
  });

  it('runs an agent_run action through the unified agent receipt path', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Inspected the selected runtime and produced a recommendation.',
      evidence: {
        observations: ['runtime queue is ready'],
      },
      outputs: {
        recommendation: 'continue with one focused run',
      },
      confidence: 0.8,
    });

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect runtime readiness',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Inspect whether the runtime is ready for the next cycle.',
          context: { why_now: 'verify agent_run receipt path' },
          expected_output: ['summary', 'evidence', 'recommendation'],
        },
      },
    }, ctx);
    const verification = actionVerifiers.agent_run.verify(null, result);

    expect(result.success).toBe(true);
    expect(result.run_spec.primary_cwd_kind).toBe('subject_runtime');
    expect(result.run_spec.permission_profile).toBe('read_only');
    expect(result.evidence.observations).toEqual(['runtime queue is ready']);
    expect(verification.status).toBe('improved');
    expect(ctx.host.intelligenceStore.readActionReceipts({ limit: 1 })[0].action_type)
      .toBe('agent_run');
  });

  it('blocks agent_run before agent execution when the execution package is incomplete', async () => {
    const ctx = makeAgenticCtx();
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect missing package',
      params: {
        run_spec: {
          primary_cwd_kind: 'unknown_external',
          permission_profile: 'read_only',
          intent: 'Inspect an external project without a configured root.',
          expected_output: ['summary'],
          context: { why_now: 'test' },
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.agent_status).toBe('not_started');
    expect(result.acceptance_status).toBe('blocked');
    expect(result.error).toBe('invalid agent_run execution package');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('passes a human-readable execution package with the full Phase 1 report to the agent', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Report-aware run completed.',
      evidence: { observations: ['used phase1 report'] },
      outputs: { done: true },
      confidence: 0.9,
    });
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Use report context',
      serves_goal: 'bootstrap',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Inspect the subject runtime using the prior report.',
          context: {
            why_now: 'the prior report identified a blocker',
            relevant_evidence: ['receipt-1'],
            do_not_repeat: ['do not inspect the host source root'],
            phase1_report_markdown: '# 情报报告\n\n完整上下文。',
          },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    const promptText = ctx.ai.agentCalls[0].map((message) => message.content).join('\n');
    expect(promptText).toContain('本轮任务');
    expect(promptText).toContain('Phase 1 情报报告全文');
    expect(promptText).toContain('完整上下文');
    expect(promptText).toContain('do not inspect the host source root');
  });

  it('blocks approval-required agent_run before agent execution when approval is absent', async () => {
    const ctx = makeAgenticCtx();
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Approval-gated task',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'workspace_write',
          provider: 'llm_only',
          intent: 'Perform an approval-gated workspace task.',
          context: { why_now: 'test approval gate' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('approval_required');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('runs configured external actions through a subject-local runner config', async () => {
    const ctx = makeCtx();
    installConfiguredActionProject(ctx);
    ctx.host.configuredExternalRunner = vi.fn(async ({ command, args, tool }) => ({
      success: true,
      status: 'synced',
      command,
      tool,
      args,
      evidence: { tankName: 'Test Tank' },
      writes: {
        observations: [{
          source: 'agentank-evolver',
          subject: 'agentank-tank',
          kind: 'agentank_evolution',
          content: 'synced remote context without secrets',
        }],
      },
    }));

    const result = await runConfiguredExternalAction({
      type: 'configured_sync',
      params: { limit: 3, secret: 'must-not-forward' },
    }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.host.configuredExternalRunner).toHaveBeenCalledOnce();
    expect(result.tool).toBe('test_tool');
    expect(result.args).toContain('--limit');
    expect(result.args).toContain('3');
    expect(result.args).not.toContain('--secret');
  });

  it('does not expose handlers for unconfigured external actions', () => {
    const spy = vi.spyOn(configuredActions, 'getConfiguredExternalAction').mockReturnValue(null);
    expect(actionHandlers.agentank_sync_context).toBeUndefined();
    expect(actionHandlers.agentank_unconfigured_action).toBeUndefined();
    spy.mockRestore();
  });

  it('keeps configured challenge requests on the configured external runner path', async () => {
    const ctx = makeCtx();
    installConfiguredActionProject(ctx);
    ctx.host.configuredExternalRunner = vi.fn(async ({ command, tool }) => ({
      success: true,
      status: 'requires_human_review',
      requires_approval: true,
      command,
      tool,
      message: 'Recorded challenge request only; no real challenge was executed.',
      request: { opponentTankId: 42, mapId: 'classic' },
    }));

    const result = await runConfiguredExternalAction({
      type: 'configured_challenge_request',
      params: { opponentTankId: 42, map: 'classic' },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(true);
    expect(result.command).toBe('challenge-request');
    expect(result.tool).toBe('test_tool');
  });

  it('describes run_probe boundaries as contracts, not provider sandboxes', () => {
    const source = readFileSync(new URL('../src/actions/registry.mjs', import.meta.url), 'utf-8');

    expect(source).toContain('bounded read-only probe');
    expect(source).not.toContain('sandboxed read-only probe');
    expect(source).toContain('does not prove provider-level isolation');
  });

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
    expect(result.provider).toBe('local');
    expect(ctx.ai.agentCalls).toHaveLength(0);
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
        provider: 'llm_only',
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
        provider: 'llm_only',
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
    expect(result.boundary_risk).toMatchObject({
      boundary_contract: 'present',
      boundary_model: 'soft_contract_only',
      sandbox_backing: ['none'],
    });
    expect(verification.status).toBe('improved');
    expect(ctx.host.intelligenceStore.readActionReceipts({ limit: 5 })[0].action_type)
      .toBe('agent_execute');
  });

  it('records boundary risk for sensitive agent execution paths', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Touched a sensitive path in the receipt metadata.',
      modified_files: ['.env'],
    });

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Exercise boundary risk summary',
      }),
    }, ctx);
    const event = ctx.host.intelligenceStore.readEvolutionEvents({ limit: 1 })[0];

    expect(result.boundary_risk).toMatchObject({
      sandbox_backing: ['none'],
      sensitive_path_signal: true,
      review_recommended: true,
    });
    expect(event.boundary_risk.sensitive_path_signal).toBe(true);
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
    let capturedOptions = null;
    const cursor = mockCursorSession([
      {
        id: 'cursor-run-prepare',
        status: 'finished',
        result: 'Inspected the requested context and prepared a recommendation.',
        model: { id: 'composer-2' },
        durationMs: 800,
      },
      {
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
      },
    ], (options) => {
      capturedOptions = options;
    });

    const ctx = makeAgentProviderCtx('Please inspect the execution queue like a human engineer.');
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
    expect(ctx.ai.translationCalls[0][1].content).toContain('Translation task');
    expect(cursor.prompts[0]).toContain('Please inspect the execution queue');
    expect(cursor.prompts[1]).toContain('Please self-check');
    expect(result.agent.outputs.agent_loop.same_session).toBe(true);
    expect(capturedOptions.apiKey).toBe('cursor-test-key');
    expect(capturedOptions.model).toEqual({ id: 'composer-2' });
    expect(capturedOptions.local.cwd).toBe(ctx.projectRoot);
    expect(capturedOptions.local.settingSources).toEqual(['project', 'user']);
    expect(verification.status).toBe('improved');
  });

  it('uses JEA_AGENT_PROVIDER as the default agent provider', async () => {
    process.env.JEA_AGENT_PROVIDER = 'cursor_sdk';
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    mockCursorSession([
      { id: 'cursor-run-default-initial', status: 'finished', result: 'Started default provider work.' },
      {
        id: 'cursor-run-default',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Cursor default provider completed.',
        }),
      },
    ]);

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Use the configured default provider',
      }),
    }, makeAgentProviderCtx());

    expect(result.success).toBe(true);
    expect(result.provider).toBe('cursor_sdk');
    expect(result.agent.outputs.cursor.run_id).toBe('cursor-run-default');
    expect(Agent.create).toHaveBeenCalledOnce();
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
    vi.mocked(claudeQuery)
      .mockImplementationOnce(() => streamMessages([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-default-session',
          result: 'Completed the requested Claude default work.',
        },
      ]))
      .mockImplementationOnce(() => streamMessages([
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
    }, makeAgentProviderCtx());

    expect(result.success).toBe(true);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.agent.outputs.claude.session_id).toBe('claude-default-session');
    expect(claudeQuery).toHaveBeenCalledTimes(2);
    expect(vi.mocked(claudeQuery).mock.calls[1][0].options.resume).toBe('claude-default-session');
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
    vi.mocked(Agent.create).mockImplementation(() => {
      throw new CursorAgentError('temporary outage', { isRetryable: true });
    });

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Run Cursor despite a startup failure',
      }),
    }, makeAgentProviderCtx());

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

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/executionRoot|cwd/);
    expect(Agent.create).not.toHaveBeenCalled();
  });

  it('keeps Cursor follow-ups in one session until a valid receipt is delivered', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    const cursor = mockCursorSession([
      { id: 'cursor-loop-initial', status: 'finished', result: 'Initial work done.' },
      {
        id: 'cursor-loop-incomplete',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          outputs: { note: 'missing summary so the host should ask again' },
        }),
      },
      {
        id: 'cursor-loop-final',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Cursor completed the follow-up loop.',
          outputs: { recommendation: 'ship the receipt' },
        }),
      },
    ]);

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Exercise the Cursor verification loop',
      }),
    }, makeAgentProviderCtx('Run the task and wait for a self-check prompt before final JSON.'));

    expect(result.success).toBe(true);
    expect(cursor.send).toHaveBeenCalledTimes(3);
    expect(cursor.prompts[1]).toContain('current receipt is missing: receipt');
    expect(cursor.prompts[2]).toContain('current receipt is missing: summary');
    expect(result.agent.outputs.agent_loop.verification_attempts).toBe(2);
    expect(result.agent.outputs.agent_loop.final_validation.valid).toBe(true);
  });

  it('returns partial when agent receipt validation fails after three attempts', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    const cursor = mockCursorSession([
      { id: 'cursor-fail-initial', status: 'finished', result: 'Initial work done.' },
      { id: 'cursor-fail-1', status: 'finished', result: JSON.stringify({ status: 'completed' }) },
      { id: 'cursor-fail-2', status: 'finished', result: JSON.stringify({ status: 'completed' }) },
      { id: 'cursor-fail-3', status: 'finished', result: JSON.stringify({ status: 'completed' }) },
    ]);

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Fail receipt validation repeatedly',
      }),
    }, makeAgentProviderCtx());

    expect(result.success).toBe(false);
    expect(result.status).toBe('partial');
    expect(cursor.send).toHaveBeenCalledTimes(4);
    expect(result.agent.outputs.agent_loop.final_validation).toMatchObject({
      valid: false,
      missing: ['summary'],
    });
    expect(result.verification_hints[0]).toContain('summary');
  });

  it('delegates execution to Claude Code SDK and normalizes the receipt', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const captured = [];
    vi.mocked(claudeQuery).mockImplementation((args) => {
      captured.push(args);
      if (captured.length === 1) {
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
            result: 'Initial agent work completed.',
          },
        ]);
      }
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

    const ctx = makeAgentProviderCtx('Please use Claude Code to inspect the project and recommend execution.');
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
    expect(captured[0].prompt).toContain('Please use Claude Code');
    expect(captured[1].prompt).toContain('Please self-check');
    expect(captured[1].options.resume).toBe('claude-session-1');
    expect(captured[0].options.permissionMode).toBe('bypassPermissions');
    expect(captured[0].options.allowDangerouslySkipPermissions).toBe(true);
    expect(captured[0].options.persistSession).toBe(true);
    expect(captured[0].options.settingSources).toEqual(['user', 'project', 'local']);
    expect(captured[0].options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(verification.status).toBe('improved');
  });

  it('maps sandbox_patch to Claude editing tools while preserving overrides', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const captured = [];
    vi.mocked(claudeQuery).mockImplementation((args) => {
      captured.push(args);
      if (captured.length === 1) {
        return streamMessages([
          {
            type: 'result',
            subtype: 'success',
            session_id: 'claude-sandbox-session',
            result: 'Sandbox patch applied, ready for final audit.',
          },
        ]);
      }
      return streamMessages([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-sandbox-session',
          result: JSON.stringify({
            status: 'completed',
            summary: 'Sandbox patch completed.',
            modified_files: ['src/example.mjs'],
            test_results: [{ command: 'npm test', status: 'passed' }],
          }),
        },
      ]);
    });

    const ctx = makeAgentProviderCtx('Patch only inside the sandbox and report the audit evidence.');
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
    expect(captured[0].options.cwd).toBe(sandbox);
    expect(captured[0].options.permissionMode).toBe('bypassPermissions');
    expect(captured[0].options.allowDangerouslySkipPermissions).toBe(true);
    expect(captured[0].options.persistSession).toBe(true);
    expect(captured[0].options.allowedTools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
    expect(captured[0].options.maxTurns).toBe(3);
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
        cwd: ctx.projectRoot,
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

  it('blocks local file probes that omit an execution root', async () => {
    const ctx = makeAgenticCtx();
    const target = join(ctx.projectRoot, 'README.md');
    writeFileSync(target, '# Test Project\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        probe_type: 'file_exists',
        target,
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('missing executionRoot');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('resolves read-only probe targets from params.cwd instead of host projectRoot', () => {
    const ctx = makeCtx();
    const externalRoot = join(tempDir, 'agentank-evolver');
    const hostCandidateDir = join(ctx.projectRoot, 'data', 'candidates');
    const externalCandidateDir = join(externalRoot, 'data', 'candidates');
    mkdirSync(hostCandidateDir, { recursive: true });
    mkdirSync(externalCandidateDir, { recursive: true });
    writeFileSync(join(hostCandidateDir, 'candidate-host.json'), '{"hash":"host"}', 'utf-8');
    writeFileSync(join(externalCandidateDir, 'candidate-external.json'), '{"hash":"external"}', 'utf-8');

    const result = runReadOnlyProbe({
      type: 'run_probe',
      params: {
        cwd: externalRoot,
        objective: 'Inspect candidate files',
        targets: ['data/candidates'],
      },
    }, ctx);

    const entries = result.evidence.steps[0].evidence.entries.map((entry) => entry.path);
    expect(result.execution_root).toBe(externalRoot);
    expect(result.evidence.execution_root).toBe(externalRoot);
    expect(entries).toContain(join('data', 'candidates', 'candidate-external.json'));
    expect(entries).not.toContain(join('data', 'candidates', 'candidate-host.json'));
  });

  it('derives subject runtime root for diary probes without explicit cwd', () => {
    const ctx = makeCtx();
    ctx.host.runtimeRoot = join(ctx.projectRoot, 'runtime', 'subjects', 'test');
    const diariesDir = join(ctx.host.runtimeRoot, 'data', 'evolution', 'diaries');
    mkdirSync(diariesDir, { recursive: true });
    writeFileSync(join(diariesDir, 'exec-test.md'), '# diary\n', 'utf-8');

    const result = runReadOnlyProbe({
      type: 'run_probe',
      params: {
        objective: 'List diary files',
        targets: ['data/evolution/diaries/'],
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.execution_root).toBe(ctx.host.runtimeRoot);
    expect(result.resource_kind).toBe('evolution_diary');
    expect(result.resource_scope).toBe('subject_runtime');
    expect(result.evidence.root_resolution_source).toBe('subject_runtime');
    expect(result.evidence.steps[0].evidence.entries.map((entry) => entry.name))
      .toContain('exec-test.md');
  });

  it('blocks diary probes whose cwd points at the evolver root', async () => {
    const ctx = makeAgenticCtx();
    ctx.host.runtimeRoot = join(ctx.projectRoot, 'runtime', 'subjects', 'test');
    const evolverRoot = join(tempDir, 'agentank-evolver');
    mkdirSync(join(ctx.host.runtimeRoot, 'data', 'evolution', 'diaries'), { recursive: true });
    mkdirSync(evolverRoot, { recursive: true });

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        cwd: evolverRoot,
        objective: 'Check diaries',
        targets: ['data/evolution/diaries/'],
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('root_mismatch');
    expect(result.evidence.resource_kind).toBe('evolution_diary');
    expect(result.evidence.resource_scope).toBe('subject_runtime');
    expect(result.evidence.root_mismatch.provided_root).toBe(evolverRoot);
    expect(result.evidence.root_mismatch.expected_root).toBe(ctx.host.runtimeRoot);
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('keeps external candidate probes in the configured subject resource root', () => {
    const ctx = makeCtx();
    const externalRoot = join(tempDir, 'external-project');
    ctx.host.externalRoots = { strategy_repo: externalRoot };
    ctx.host.resourceRules = [
      { kind: 'strategy_candidate', scope: 'strategy_repo', patterns: ['data/candidates/**'] },
    ];
    const candidateDir = join(externalRoot, 'data', 'candidates');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, 'candidate-external.json'), '{"hash":"external"}', 'utf-8');

    const result = runReadOnlyProbe({
      type: 'run_probe',
      params: {
        objective: 'Inspect candidate files',
        targets: ['data/candidates/'],
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.execution_root).toBe(externalRoot);
    expect(result.resource_kind).toBe('strategy_candidate');
    expect(result.resource_scope).toBe('strategy_repo');
    expect(result.evidence.steps[0].evidence.entries.map((entry) => entry.name))
      .toContain('candidate-external.json');
  });

  it('records resource metadata on probe receipts', async () => {
    const ctx = makeAgenticCtx();
    ctx.host.runtimeRoot = join(ctx.projectRoot, 'runtime', 'subjects', 'test');
    const diariesDir = join(ctx.host.runtimeRoot, 'data', 'evolution', 'diaries');
    mkdirSync(diariesDir, { recursive: true });
    writeFileSync(join(diariesDir, 'exec-test.md'), '# diary\n', 'utf-8');

    const result = await actionHandlers.run_probe({
      type: 'run_probe',
      params: {
        objective: 'Inspect diary files',
        targets: ['data/evolution/diaries/'],
        allow_legacy_fallback: true,
      },
    }, ctx);

    const receipt = ctx.host.intelligenceStore.readActionReceipts({ limit: 1 })[0];
    expect(result.resource_kind).toBe('evolution_diary');
    expect(receipt.result.resource_kind).toBe('evolution_diary');
    expect(receipt.result.resource_scope).toBe('subject_runtime');
    expect(receipt.result.relative_targets).toEqual(['data/evolution/diaries/']);
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
        cwd: ctx.projectRoot,
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
        cwd: ctx.projectRoot,
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
        cwd: ctx.projectRoot,
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
        cwd: ctx.projectRoot,
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
        cwd: ctx.projectRoot,
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
    expect(result.message).toContain('host preflight');
    expect(result.boundary_risk).toMatchObject({
      preflight_result: 'blocked_local_probe',
      provider_isolation_proven: false,
      sensitive_path_signal: true,
    });
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
        cwd: ctx.projectRoot,
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

