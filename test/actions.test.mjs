import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  buildSubjectResourceSummary,
} from '../src/cli/utils/subjects.mjs';
import { applyRunSpecToAction, validateAgentRunSpec } from '../src/actions/agent-run-spec.mjs';
import { buildClaudeOptions, buildCursorOptions, buildReasonixOptions, buildReasonixRunBaseArgs, buildReasonixTurnInvocation } from '../src/actions/agent-adapter.mjs';
import {
  buildEvidenceContract,
  inferActionResource,
  RESOURCE_SCOPES,
} from '../src/actions/resource-registry.mjs';
import {
  buildLaneWorkBranch,
  checkLaneStatus,
  initializeLane,
  runLaneCommand,
  workBranchPrefixConflictsWithLane,
} from '../src/actions/lane-manager.mjs';
import { createBranchWorktree } from '../src/actions/worktree-manager.mjs';
import { parseSubjectRepoLane } from '../src/cli/utils/subjects.mjs';

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
const ORIGINAL_JEA_AGENT_RUN_LOG = process.env.JEA_AGENT_RUN_LOG;
const ORIGINAL_JEA_AGENT_RUN_JSONL = process.env.JEA_AGENT_RUN_JSONL;
const ORIGINAL_AGENTANK_TANK_KEY = process.env.AGENTANK_TANK_KEY;
const ORIGINAL_JEA_APPROVAL_MODE = process.env.JEA_APPROVAL_MODE;
const ORIGINAL_DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ORIGINAL_REASONIX_BIN = process.env.REASONIX_BIN;
const ORIGINAL_JEA_REASONIX_BIN_ARGS = process.env.JEA_REASONIX_BIN_ARGS;
const ORIGINAL_JEA_REASONIX_MODEL = process.env.JEA_REASONIX_MODEL;
const ORIGINAL_JEA_REASONIX_CONFIG = process.env.JEA_REASONIX_CONFIG;
const ORIGINAL_JEA_REASONIX_ALLOW_BASH = process.env.JEA_REASONIX_ALLOW_BASH;
const ORIGINAL_JEA_REASONIX_TIMEOUT_MS = process.env.JEA_REASONIX_TIMEOUT_MS;
const ORIGINAL_JEA_REASONIX_MAX_STEPS = process.env.JEA_REASONIX_MAX_STEPS;

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
        return typeof response === 'string' ? response : JSON.stringify(response);
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
  const logger = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
  return {
    ...ctx,
    host: {
      ...ctx.host,
      logger,
    },
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

function defaultCursorStreamEvents() {
  return [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Working on the task.' },
        ],
      },
    },
    {
      type: 'tool_call',
      call_id: 'call-read-1',
      name: 'Read',
      status: 'running',
      args: { path: 'src/index.mjs' },
    },
    {
      type: 'tool_call',
      call_id: 'call-read-1',
      name: 'Read',
      status: 'completed',
      result: 'file contents',
    },
  ];
}

function mockCursorSession(results, onCreate = null, streamEvents = null) {
  const prompts = [];
  const send = vi.fn(async (prompt) => {
    prompts.push(prompt);
    const result = typeof results === 'function' ? results(prompt, prompts.length) : results.shift();
    const events = typeof streamEvents === 'function'
      ? streamEvents(result, prompt, prompts.length)
      : (streamEvents ?? defaultCursorStreamEvents(result));
    return {
      id: result?.id,
      wait: vi.fn(async () => result),
      stream: vi.fn(async function* stream() {
        for (const event of events) yield event;
      }),
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

function fakeReasonixTaskReaderLines() {
  return [
    "function readReasonixTask() {",
    "  const args = process.argv.slice(2);",
    "  const runIdx = args.indexOf('run');",
    "  const tail = runIdx >= 0 ? args.slice(runIdx + 1) : args;",
    "  const positional = [];",
    "  for (let i = 0; i < tail.length; i += 1) {",
    "    const token = tail[i];",
    "    if (token === '--model') { i += 1; continue; }",
    "    if (token.startsWith('--')) continue;",
    "    positional.push(token);",
    "  }",
    "  if (positional.length) return positional.join(' ');",
    "  try { return readFileSync(0, 'utf-8'); } catch { return ''; }",
    "}",
    "const input = readReasonixTask();",
  ];
}

function installFakeReasonix(ctx, scriptBody) {
  const scriptPath = join(ctx.projectRoot, 'fake-reasonix.mjs');
  writeFileSync(scriptPath, scriptBody, 'utf-8');
  process.env.REASONIX_BIN = process.execPath;
  process.env.JEA_REASONIX_BIN_ARGS = scriptPath;
  process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
  process.env.JEA_REASONIX_FLAVOR = 'npm';
  return scriptPath;
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function installConfiguredActionProject(ctx) {
  mkdirSync(join(ctx.projectRoot, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(ctx.projectRoot, 'runtime', 'subjects', 'configured-test', 'data', 'config'), { recursive: true });
  writeJsonFile(join(ctx.projectRoot, 'policies', 'subjects.json'), {
    default_subject: 'configured-test',
    subjects: {
      'configured-test': {
        policy: 'subjects/configured-test.md',
        data_namespace: 'configured-test',
      },
    },
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

function installFakeAgentRunWorktree(ctx, path = join(ctx.projectRoot, '.worktrees', 'fake-agent-run')) {
  const createAgentRunWorktree = vi.fn(() => ({
    path,
    branch: 'jea/agentank/work/cycle-1/test-change',
    base_branch: 'jea/agentank/local',
    auto_created: true,
    created: true,
    cleanup_hint: [
      `git worktree remove "${path}"`,
      'git branch -D "jea/agentank/work/cycle-1/test-change"',
    ],
  }));
  ctx.host.createAgentRunWorktree = createAgentRunWorktree;
  return createAgentRunWorktree;
}

function mockLaneReady(ctx, targetRepo, lane = 'jea/agentank/local') {
  ctx.host.checkLaneStatus = () => ({
    configured: true,
    repoRoot: targetRepo,
    baseBranch: 'main',
    lane,
    workBranchPrefix: 'jea/agentank/work',
    exists: true,
    isGitRepo: true,
    gitRoot: targetRepo,
    currentBranch: 'main',
    baseBranchExists: true,
    laneBranchExists: true,
    dirty: false,
    ok: true,
    errors: [],
  });
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
  if (ORIGINAL_JEA_APPROVAL_MODE) {
    process.env.JEA_APPROVAL_MODE = ORIGINAL_JEA_APPROVAL_MODE;
  } else {
    delete process.env.JEA_APPROVAL_MODE;
  }
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
  delete process.env.JEA_AGENT_RUN_VERBOSE;
  delete process.env.FAKE_REASONIX_LOG;
  if (ORIGINAL_AGENTANK_TANK_KEY) {
    process.env.AGENTANK_TANK_KEY = ORIGINAL_AGENTANK_TANK_KEY;
  } else {
    delete process.env.AGENTANK_TANK_KEY;
  }
  if (ORIGINAL_DEEPSEEK_API_KEY) {
    process.env.DEEPSEEK_API_KEY = ORIGINAL_DEEPSEEK_API_KEY;
  } else {
    delete process.env.DEEPSEEK_API_KEY;
  }
  if (ORIGINAL_REASONIX_BIN) {
    process.env.REASONIX_BIN = ORIGINAL_REASONIX_BIN;
  } else {
    delete process.env.REASONIX_BIN;
  }
  if (ORIGINAL_JEA_REASONIX_BIN_ARGS) {
    process.env.JEA_REASONIX_BIN_ARGS = ORIGINAL_JEA_REASONIX_BIN_ARGS;
  } else {
    delete process.env.JEA_REASONIX_BIN_ARGS;
  }
  if (ORIGINAL_JEA_REASONIX_MODEL) {
    process.env.JEA_REASONIX_MODEL = ORIGINAL_JEA_REASONIX_MODEL;
  } else {
    delete process.env.JEA_REASONIX_MODEL;
  }
  if (ORIGINAL_JEA_REASONIX_CONFIG) {
    process.env.JEA_REASONIX_CONFIG = ORIGINAL_JEA_REASONIX_CONFIG;
  } else {
    delete process.env.JEA_REASONIX_CONFIG;
  }
  if (ORIGINAL_JEA_REASONIX_ALLOW_BASH) {
    process.env.JEA_REASONIX_ALLOW_BASH = ORIGINAL_JEA_REASONIX_ALLOW_BASH;
  } else {
    delete process.env.JEA_REASONIX_ALLOW_BASH;
  }
  if (ORIGINAL_JEA_REASONIX_TIMEOUT_MS) {
    process.env.JEA_REASONIX_TIMEOUT_MS = ORIGINAL_JEA_REASONIX_TIMEOUT_MS;
  } else {
    delete process.env.JEA_REASONIX_TIMEOUT_MS;
  }
  if (ORIGINAL_JEA_REASONIX_MAX_STEPS) {
    process.env.JEA_REASONIX_MAX_STEPS = ORIGINAL_JEA_REASONIX_MAX_STEPS;
  } else {
    delete process.env.JEA_REASONIX_MAX_STEPS;
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

  it('treats canonical standing memory as a subject runtime resource', () => {
    const resource = inferActionResource({
      type: 'agent_run',
      target: 'data/intelligence/memory/standing_memory.json',
    }, makeCtx());

    expect(resource.resourceKind).toBe('standing_memory');
    expect(resource.resourceScope).toBe('subject_runtime');
  });

  it('builds lane work branches with subject-scoped work prefix', () => {
    expect(buildLaneWorkBranch({
      subject: 'agentank',
      cycleId: 'cycle-1',
      slug: 'fix pathing',
      suffix: 'abc123',
    })).toBe('jea/agentank/work/cycle-1/fix-pathing/abc123');
  });

  it('detects nested work branch prefix under lane ref path', () => {
    expect(workBranchPrefixConflictsWithLane('jea/agentank/local', 'jea/agentank/local/work')).toBe(true);
    expect(workBranchPrefixConflictsWithLane('jea/agentank/local', 'jea/agentank/work')).toBe(false);
  });

  it('fails lane status when work prefix is nested under lane', () => {
    const status = checkLaneStatus({
      configured: true,
      repoRoot: join(tempDir || tmpdir(), 'missing-agentank'),
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/local/work',
    });

    expect(status.ok).toBe(false);
    expect(status.errors.some((error) => error.includes('nested under lane branch'))).toBe(true);
  });

  it('parses default work branch prefix from subject name', () => {
    const config = parseSubjectRepoLane([
      '## Subject Repo Lane',
      '- Repo: `D:\\target`',
      '- Lane: `jea/agentank/desktop-a`',
    ].join('\n'), { subject: 'agentank' });

    expect(config.workBranchPrefix).toBe('jea/agentank/work');
  });

  it('reports missing lane repo as not configured or missing', () => {
    const status = checkLaneStatus({
      configured: true,
      repoRoot: join(tempDir || tmpdir(), 'missing-agentank'),
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/work',
    });

    expect(status.ok).toBe(false);
    expect(status.errors[0]).toContain('repo does not exist');
  });

  it('initializes a missing lane branch from the configured base branch', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-init-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# lane test\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    const config = {
      configured: true,
      repoRoot: repo,
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/work',
    };
    const result = initializeLane(config);
    const status = checkLaneStatus(config);
    const second = initializeLane(config);

    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(status.ok).toBe(true);
    expect(second.success).toBe(true);
    expect(second.created).toBe(false);
  }, 60_000);

  it('runs lane commands in a dedicated lane worktree when the main checkout stays on main', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-command-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'marker.txt'), 'main\n', 'utf-8');
    execFileSync('git', ['add', 'marker.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-b', 'jea/agentank/local'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'marker.txt'), 'lane\n', 'utf-8');
    execFileSync('git', ['add', 'marker.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'lane'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['checkout', 'main'], { cwd: repo, stdio: 'ignore' });

    const config = {
      configured: true,
      repoRoot: repo,
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/work',
      laneWorktreeRoot: join(repo, '.worktrees', 'js-evolution-agent', 'lane-test'),
    };
    const result = runLaneCommand(config, { command: 'node -e "process.stdout.write(require(\'fs\').readFileSync(\'marker.txt\', \'utf8\'))"' });
    const mainBranch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf-8' }).trim();

    expect(result.success).toBe(true);
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe('lane\n');
    expect(result.checkoutKind).toBe('lane_worktree');
    expect(result.executionRoot).toContain('.worktrees');
    expect(result.worktreeCreated).toBe(true);
    expect(result.worktreeReused).toBe(false);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(mainBranch).toBe('main');
  }, 60_000);

  it('reuses the fixed lane worktree across lane commands', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-reuse-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# lane\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    const config = {
      configured: true,
      repoRoot: repo,
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/work',
      laneWorktreeRoot: join(repo, '.worktrees', 'js-evolution-agent', 'lane-test'),
    };
    initializeLane(config);
    const first = runLaneCommand(config, { command: 'node -e "process.stdout.write(process.cwd())"' });
    const second = runLaneCommand(config, { command: 'node -e "process.stdout.write(process.cwd())"' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.executionRoot).toBe(second.executionRoot);
    expect(first.worktreeCreated).toBe(true);
    expect(second.worktreeCreated).toBe(false);
    expect(second.worktreeReused).toBe(true);
  }, 60_000);

  it('fails lane commands when the dedicated lane worktree is dirty', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-dirty-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# lane\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    const config = {
      configured: true,
      repoRoot: repo,
      baseBranch: 'main',
      lane: 'jea/agentank/local',
      workBranchPrefix: 'jea/agentank/work',
      laneWorktreeRoot: join(repo, '.worktrees', 'js-evolution-agent', 'lane-test'),
    };
    initializeLane(config);
    const first = runLaneCommand(config, { command: 'node -e "process.stdout.write(\'ok\')"' });
    writeFileSync(join(first.executionRoot, 'dirty.txt'), 'dirty\n', 'utf-8');
    const second = runLaneCommand(config, { command: 'node -e "process.stdout.write(\'should-not-run\')"' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toContain('lane worktree is dirty');
    expect(second.stdout).toBe('');
  }, 60_000);

  it('creates worktree branches with non-nested prefix when lane branch exists', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-worktree-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# worktree\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['branch', 'jea/test/local', 'main'], { cwd: repo, stdio: 'ignore' });

    const worktreesRoot = join(repo, '.worktrees', 'js-evolution-agent');
    const workspace = createBranchWorktree({
      repoRoot: repo,
      baseBranch: 'jea/test/local',
      workBranchPrefix: 'jea/test/work',
      branch: 'jea/test/work/smoke',
      name: 'smoke',
      worktreeRoot: worktreesRoot,
    });

    expect(workspace.branch).toBe('jea/test/work/smoke');
    expect(workspace.path).toContain('smoke');

    execFileSync('git', ['worktree', 'remove', workspace.path], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['branch', '-D', workspace.branch], { cwd: repo, stdio: 'ignore' });
  });

  it('rejects nested work branch names when lane branch exists', () => {
    const repo = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-worktree-nested-')), 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# nested\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['branch', 'jea/test/local', 'main'], { cwd: repo, stdio: 'ignore' });

    expect(() => createBranchWorktree({
      repoRoot: repo,
      baseBranch: 'jea/test/local',
      workBranchPrefix: 'jea/test/local/work',
      branch: 'jea/test/local/work/bad',
      name: 'bad',
      worktreeRoot: join(repo, '.worktrees', 'js-evolution-agent'),
    })).toThrow();
  });

  it('resolves agent_run target_repo scope from subject repo lane', () => {
    const ctx = makeCtx();
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectRepoLane = {
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      baseBranch: 'main',
    };

    const validation = validateAgentRunSpec({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'target_repo',
          permission_profile: 'read_only',
          intent: 'Inspect the target repo.',
          context: { subject: 'agentank' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(validation.valid).toBe(true);
    expect(validation.spec.primary_cwd).toBe(targetRepo);
  });

  it('resolves lane_worktree scope from injected agent_run cwd', () => {
    const ctx = makeCtx();
    const worktreePath = join(ctx.projectRoot, 'lane-worktree');
    mkdirSync(worktreePath, { recursive: true });

    const validation = validateAgentRunSpec({
      type: 'agent_run',
      params: {
        cwd: worktreePath,
        resource_scope: RESOURCE_SCOPES.LANE_WORKTREE,
        run_spec: {
          primary_cwd: worktreePath,
          primary_cwd_kind: RESOURCE_SCOPES.LANE_WORKTREE,
          permission_profile: 'workspace_write',
          intent: 'Patch the target project.',
          context: { lane_execution: { worktree_path: worktreePath } },
          expected_output: ['diff summary'],
        },
      },
    }, ctx);

    expect(validation.valid).toBe(true);
    expect(validation.spec.primary_cwd).toBe(worktreePath);
    expect(validation.roots.rootResolutionSource).toBe('configured_execution_root');
  });

  it('maps lane_worktree agent_run specs to the same cwd in Claude and Cursor options', () => {
    const worktreePath = join(tempDir || mkdtempSync(join(tmpdir(), 'jea-lane-options-')), 'lane-worktree');
    mkdirSync(worktreePath, { recursive: true });
    const action = {
      type: 'agent_run',
      params: {
        cwd: worktreePath,
        resource_scope: RESOURCE_SCOPES.LANE_WORKTREE,
        run_spec: {
          primary_cwd: worktreePath,
          primary_cwd_kind: RESOURCE_SCOPES.LANE_WORKTREE,
          permission_profile: 'workspace_write',
          intent: 'Patch strategy code.',
          context: {
            lane_execution: {
              target_repo_root: 'D:\\github\\My\\target',
              lane_branch: 'jea/agentank/local',
              work_branch: 'jea/agentank/work/cycle-1/change',
              worktree_path: worktreePath,
            },
          },
          expected_output: ['diff summary'],
        },
      },
    };
    const ctx = makeCtx();
    const executionAction = applyRunSpecToAction(action, ctx);
    const claude = buildClaudeOptions(executionAction, ctx);
    const cursor = buildCursorOptions(executionAction, ctx);

    expect(claude.options.cwd).toBe(worktreePath);
    expect(cursor.options.local.cwd).toBe(worktreePath);
    expect(claude.rootMetadata.resource_scope).toBe(RESOURCE_SCOPES.LANE_WORKTREE);
  });

  it('prepares a lane-derived worktree for write agent_run on target_repo', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Applied a bounded patch in the lane worktree.',
      modified_files: ['src/strategy/foo.mjs'],
      evidence: { diff_summary: 'Updated strategy module.' },
    });
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectRepoLane = {
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      baseBranch: 'main',
      workBranchPrefix: 'jea/agentank/work',
    };
    mockLaneReady(ctx, targetRepo);
    const createWorktree = installFakeAgentRunWorktree(ctx);

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Patch target repo strategy',
      params: {
        run_spec: {
          primary_cwd_kind: 'target_repo',
          permission_profile: 'workspace_write',
          intent: 'Patch strategy code in the target repo.',
          context: { goal: 'improve candidate generation' },
          expected_output: ['diff summary', 'test results'],
        },
      },
    }, ctx);

    expect(createWorktree).toHaveBeenCalledOnce();
    expect(result.lane_workspace?.path).toContain('.worktrees');
    expect(result.lane_workspace?.lane_branch).toBe('jea/agentank/local');
    expect(result.lane_workspace?.target_repo_root).toBe(targetRepo);
    expect(result.run_spec.primary_cwd_kind).toBe(RESOURCE_SCOPES.LANE_WORKTREE);
    expect(result.execution_root).toContain('.worktrees');
  });

  it('does not create a lane worktree for read_only agent_run on target_repo', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Read-only inspection completed.',
      evidence: { observations: ['repo is ready'] },
    });
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectRepoLane = {
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      baseBranch: 'main',
    };
    mockLaneReady(ctx, targetRepo);
    const createWorktree = installFakeAgentRunWorktree(ctx);

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'target_repo',
          permission_profile: 'read_only',
          intent: 'Inspect the target repo.',
          context: { subject: 'agentank' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.lane_workspace ?? null).toBeNull();
    expect(result.run_spec.primary_cwd_kind).toBe('target_repo');
    expect(result.execution_root).toBe(targetRepo);
  });

  it('records resources_used on agent_run receipt and verifier value', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Read-only inspection completed.',
      evidence: { observations: ['repo is ready'] },
    });
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectResources = buildSubjectResourceSummary({
      items: {
        target_repo: {
          kind: 'repo',
          handle: targetRepo,
          note: 'Target repository.',
          fallback: 'Inspect manually.',
        },
        agentank_guide: {
          kind: 'document',
          handle: 'target_repo:docs/agent-guide.md',
          note: 'Guide document.',
          fallback: 'Use live guide URL.',
        },
      },
      roots: {
        target_repo: 'target_repo',
      },
      aliases: {
        agentank_evolver: 'target_repo',
      },
    });
    ctx.host.externalRoots = {
      target_repo: targetRepo,
      agentank_evolver: targetRepo,
    };

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'agentank_evolver',
          permission_profile: 'read_only',
          intent: 'Inspect the target repo.',
          context: { subject: 'agentank' },
          expected_output: ['summary'],
        },
      },
    }, ctx);
    const verification = actionVerifiers.agent_run.verify(null, result);

    expect(result.resources_used).toEqual([{
      scope: 'agentank_evolver',
      resource_id: 'target_repo',
      kind: 'repo',
      role: 'primary_cwd',
      handle: targetRepo,
      note: 'Target repository.',
    }]);
    expect(verification.value.resources_used).toEqual(result.resources_used);
  });

  it('reuses an explicit worktree for agent_run without auto-creating another one', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Used the provided worktree.',
      modified_files: ['README.md'],
    });
    const explicitWorktree = join(ctx.projectRoot, 'explicit-worktree');
    mkdirSync(explicitWorktree, { recursive: true });
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectRepoLane = {
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      baseBranch: 'main',
    };
    mockLaneReady(ctx, targetRepo);
    const createWorktree = installFakeAgentRunWorktree(ctx);

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        cwd: explicitWorktree,
        boundary: { worktree: explicitWorktree },
        run_spec: {
          primary_cwd: explicitWorktree,
          primary_cwd_kind: RESOURCE_SCOPES.LANE_WORKTREE,
          permission_profile: 'workspace_write',
          intent: 'Patch using explicit worktree.',
          context: { use_explicit_worktree: true },
          expected_output: ['diff summary'],
        },
      },
    }, ctx);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.lane_workspace ?? null).toBeNull();
    expect(result.execution_root).toBe(explicitWorktree);
  });

  it('blocks write agent_run when the subject repo lane is not ready', async () => {
    const ctx = makeAgenticCtx();
    const targetRepo = join(ctx.projectRoot, 'target-repo');
    mkdirSync(targetRepo, { recursive: true });
    ctx.host.subjectRepoLane = {
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      baseBranch: 'main',
    };
    ctx.host.checkLaneStatus = () => ({
      configured: true,
      repoRoot: targetRepo,
      lane: 'jea/agentank/local',
      ok: false,
      errors: ['lane branch not found: jea/agentank/local'],
    });
    const createWorktree = installFakeAgentRunWorktree(ctx);

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'target_repo',
          permission_profile: 'workspace_write',
          intent: 'Patch strategy code.',
          context: { goal: 'patch' },
          expected_output: ['diff summary'],
        },
      },
    }, ctx);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    expect(result.message).toContain('lane worktree');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('marks canonical and non-canonical standing memory path observations differently', () => {
    const canonical = buildEvidenceContract({
      executionRoot: '/runtime',
      resourceScope: 'subject_runtime',
      resourceKind: 'standing_memory',
      path: 'data/intelligence/memory/standing_memory.json',
      status: 'failed',
      observation: { exists: false },
    });
    const nonCanonical = buildEvidenceContract({
      executionRoot: '/runtime',
      resourceScope: 'subject_runtime',
      resourceKind: 'standing_memory',
      path: './standing_memory.json',
      status: 'failed',
      observation: { exists: false },
    });

    expect(canonical.boundary.is_canonical_path).toBe(true);
    expect(nonCanonical.boundary.is_canonical_path).toBe(false);
    expect(nonCanonical.boundary.canonical_path).toBe('data/intelligence/memory/standing_memory.json');
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

  it('normalizes nested agent_run receipts before validation', async () => {
    const ctx = makeAgenticCtx({
      receipt: {
        status: 'completed',
        summary: 'Nested receipt completed.',
        evidence: { observations: ['nested receipt evidence'] },
        outputs: { recommendation: 'continue' },
      },
    });

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect nested receipt',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify nested receipt normalization.',
          context: { why_now: 'verify nested receipt normalization' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.schema_status).toBe('valid');
    expect(result.execution_status).toBe('completed');
    expect(result.evidence.observations).toEqual(['nested receipt evidence']);
  });

  it('accepts an agent_run receipt embedded after explanatory text', async () => {
    const ctx = makeAgenticCtx(() => [
      'Verifying the work before returning the final receipt.',
      '',
      JSON.stringify({
        status: 'completed',
        summary: 'Embedded receipt completed.',
        evidence: { observations: ['embedded receipt evidence'] },
        outputs: { recommendation: 'continue' },
      }),
    ].join('\n'));

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect embedded receipt',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify embedded receipt extraction.',
          context: { why_now: 'verify embedded receipt extraction' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.schema_status).toBe('valid');
    expect(result.agent.raw_receipt_parse_mode).toBe('extracted_json');
    expect(result.agent.verification_hints).toContain('agent receipt parsed from embedded JSON object');
    expect(result.evidence.observations).toEqual(['embedded receipt evidence']);
  });

  it('selects the best receipt object from multiple embedded JSON snippets', async () => {
    const ctx = makeAgenticCtx(() => [
      JSON.stringify({ note: 'diagnostic context only' }),
      'Final receipt:',
      JSON.stringify({
        status: 'completed',
        summary: 'Best receipt selected.',
        evidence: { observations: ['selected receipt evidence'] },
        outputs: { recommendation: 'continue' },
      }),
    ].join('\n'));

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect multiple embedded receipts',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify best embedded receipt selection.',
          context: { why_now: 'verify embedded receipt selection' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toBe('Best receipt selected.');
    expect(result.evidence.observations).toEqual(['selected receipt evidence']);
  });

  it('does not accept natural language without a structured receipt', async () => {
    const ctx = makeAgenticCtx(() => 'I completed the work and everything looks good.');

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect unstructured receipt',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify unstructured receipt rejection.',
          context: { why_now: 'verify unstructured receipt rejection' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.schema_status).toBe('invalid');
    expect(result.schema_missing).toContain('status');
    expect(result.schema_missing).toContain('summary');
  });

  it('keeps completed execution separate from invalid receipt schema', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      evidence: { observations: ['execution evidence exists'] },
      outputs: { recommendation: 'fix schema only' },
    });

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect schema split',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify schema invalid does not erase execution result.',
          context: { why_now: 'verify schema status split' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);
    const verification = actionVerifiers.agent_run.verify(null, result);

    expect(result.success).toBe(false);
    expect(result.agent.execution_status).toBe('completed');
    expect(result.agent.schema_status).toBe('invalid');
    expect(result.acceptance_status).toBe('schema_invalid');
    expect(result.goal_progress_status).toBe('progressed');
    expect(result.status).toBe('completed');
    expect(verification.status).toBe('partial');
    expect(verification.value.schema_status).toBe('invalid');
    expect(verification.value.execution_status).toBe('completed');
  });

  it('normalizes evidence_summary into agent_run summary', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      evidence_summary: 'Evidence summary became the top-level summary.',
      evidence: { observations: ['summary normalized'] },
      outputs: { recommendation: 'continue' },
    });

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Inspect evidence_summary normalization',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify evidence_summary fallback.',
          context: { why_now: 'verify receipt normalization' },
          expected_output: ['summary', 'evidence'],
        },
      },
    }, ctx);

    expect(result.message).toBe('Evidence summary became the top-level summary.');
    expect(result.schema_status).toBe('valid');
    expect(result.success).toBe(true);
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
    delete process.env.JEA_APPROVAL_MODE;
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

  it('auto_guarded allows read_only approval-required agent_run without explicit approval', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Credential probe completed.',
      evidence: { observations: ['credential ok'] },
    });
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Periodic credential compliance probe',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify tank key visibility with redacted probe output.',
          context: { why_now: 'periodic guard task' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.ai.agentCalls.length).toBeGreaterThan(0);
    expect(result.auto_approval).toMatchObject({
      mode: 'auto_guarded',
      reason: 'read_only_agent_run',
    });
  });

  it('auto_guarded still blocks write-profile agent_run without explicit approval', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const ctx = makeAgenticCtx();

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Workspace write task',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'workspace_write',
          provider: 'llm_only',
          intent: 'Update local standing memory fields.',
          context: { why_now: 'maintenance task' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('approval_required');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('auto_guarded still blocks publish intent on read_only agent_run', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const ctx = makeAgenticCtx();
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Publish candidate remotely',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Publish candidate to remote tank after gate pass.',
          context: { why_now: 'release window' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('approval_required');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('auto_guarded does not bypass core_apply review policy', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    process.env.JEA_CORE_APPLY_POLICY = 'review';
    const ctx = makeAgenticCtx();

    const result = await actionHandlers.core_apply({
      type: 'core_apply',
      params: {
        target: 'src/actions/handlers.mjs',
        rationale: 'exercise the core apply protocol',
        boundary: { death_boundary: 'test-only mutation boundary' },
        acceptance: 'Return diff, tests, and rollback evidence.',
        death_boundary: 'Only test fixtures may fail.',
      },
    }, ctx);

    expect(result.requires_approval).toBe(true);
    expect(result.status).toBe('requires_human_review');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('auto_all allows workspace_write approval-required agent_run without explicit approval', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Workspace task completed.',
      evidence: { observations: ['done'] },
    });
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Workspace write task',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'workspace_write',
          provider: 'llm_only',
          intent: 'Update local standing memory fields.',
          context: { why_now: 'maintenance task' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(ctx.ai.agentCalls.length).toBeGreaterThan(0);
    expect(result.auto_approval).toMatchObject({
      mode: 'auto_all',
      reason: 'auto_all_mode',
    });
  });

  it('auto_all overrides post-execution agent approval requests', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Credential probe completed but agent requested review.',
      requires_approval: true,
      evidence: { observations: ['credential ok'] },
    });
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Periodic credential compliance probe',
      params: {
        requires_approval: true,
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify tank key visibility with redacted probe output.',
          context: { why_now: 'periodic guard task' },
          expected_output: ['summary'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.requires_approval).toBe(false);
    expect(result.acceptance_status).toBe('passed');
    expect(result.goal_progress_status).toBe('progressed');
    expect(result.auto_approval).toMatchObject({
      mode: 'auto_all',
      reason: 'auto_all_mode',
    });
  });

  it('auto_all bypasses core_apply review policy when not disabled', async () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    process.env.JEA_CORE_APPLY_POLICY = 'review';
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Applied core patch.',
      modified_files: ['src/actions/handlers.mjs'],
      test_results: [{ command: 'npm test', status: 'passed' }],
      evidence: {
        changed_files: ['src/actions/handlers.mjs'],
        diff_summary: 'Added auto_all support.',
        rollback_plan: 'Revert the patch.',
        death_boundary_result: 'No fixture damage.',
      },
    });
    const createCoreApplyWorktree = installFakeWorktree(ctx);

    const result = await actionHandlers.core_apply({
      type: 'core_apply',
      params: {
        target: 'src/actions/handlers.mjs',
        rationale: 'exercise auto_all core apply path',
        boundary: { death_boundary: 'test-only mutation boundary' },
        acceptance: 'Return diff, tests, and rollback evidence.',
        death_boundary: 'Only test fixtures may fail.',
      },
    }, ctx);

    expect(result.requires_approval).toBe(false);
    expect(result.success).toBe(true);
    expect(createCoreApplyWorktree).toHaveBeenCalledOnce();
    expect(ctx.ai.agentCalls.length).toBeGreaterThan(0);
  });

  it('blocks external credential checks from non-authoritative subject runtime scope', async () => {
    const ctx = makeAgenticCtx();
    const externalRoot = join(tempDir, 'agentank-evolver');
    mkdirSync(externalRoot, { recursive: true });
    ctx.host.runtimeRoot = join(ctx.projectRoot, 'runtime', 'subjects', 'agentank-tank');
    mkdirSync(ctx.host.runtimeRoot, { recursive: true });
    ctx.host.externalRoots = { agentank_evolver: externalRoot };

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Check whether AGENTANK_TANK_KEY is configured before syncing remote tank context.',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify AGENTANK_TANK_KEY visibility for the remote sync capability.',
          context: { why_now: 'credential gate before remote sync' },
          expected_output: ['redacted credential visibility'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.error).toBe('non_authoritative_execution_scope');
    expect(result.evidence.warnings[0]).toContain('env:AGENTANK_TANK_KEY requires authoritative scope agentank_evolver');
    expect(ctx.ai.agentCalls).toHaveLength(0);
  });

  it('allows external credential checks from the authoritative external scope', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Checked redacted credential visibility from the external tool root.',
      evidence: { credential_visibility: 'present_redacted' },
      outputs: { recommendation: 'sync can proceed through configured external action' },
    });
    const externalRoot = join(tempDir, 'agentank-evolver');
    mkdirSync(externalRoot, { recursive: true });
    ctx.host.externalRoots = { agentank_evolver: externalRoot };

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Check whether AGENTANK_TANK_KEY is configured before syncing remote tank context.',
      params: {
        run_spec: {
          primary_cwd_kind: 'agentank_evolver',
          permission_profile: 'read_only',
          provider: 'llm_only',
          intent: 'Verify AGENTANK_TANK_KEY visibility for the remote sync capability without printing the value.',
          context: { why_now: 'credential gate before remote sync' },
          expected_output: ['redacted credential visibility'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.execution_root).toBe(externalRoot);
    expect(ctx.ai.agentCalls).toHaveLength(1);
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

  it('runs linked external actions with cwd set to the resolved link root', async () => {
    const ctx = makeCtx();
    installConfiguredActionProject(ctx);
    const linkRepo = join(ctx.projectRoot, 'linked-tool');
    mkdirSync(join(linkRepo, 'src'), { recursive: true });
    const repolinkImport = pathToFileURL(join(import.meta.dirname, '..', 'node_modules', 'js-repolink', 'src', 'index.mjs')).href;
    writeFileSync(join(ctx.projectRoot, 'repolink.config.mjs'), `import { defineLinks } from '${repolinkImport}';
export const links = defineLinks({
  test_link: {
    envVar: 'TEST_LINK_PATH',
    runtime: 'node',
    entry: 'src/cli.mjs',
  },
});
`, 'utf-8');
    writeFileSync(join(ctx.projectRoot, '.env'), `TEST_LINK_PATH=${linkRepo.replace(/\\/g, '/')}\n`, 'utf-8');
    writeFileSync(join(linkRepo, 'src', 'cli.mjs'), [
      'const cmd = process.argv[2];',
      'if (cmd === "sync") {',
      '  console.log(JSON.stringify({ success: true, status: "completed", cwd: process.cwd() }));',
      '}',
      '',
    ].join('\n'), 'utf-8');
    writeJsonFile(join(ctx.projectRoot, 'runtime', 'subjects', 'configured-test', 'data', 'config', 'actions.json'), {
      external_tools: {
        test_tool: { link: 'test_link', entry: 'src/cli.mjs' },
      },
      actions: [
        {
          name: 'configured_sync',
          tool: 'test_tool',
          command: 'sync',
          description: 'Sync configured test context via link',
          defaultRisk: 'low',
          defaultPriority: 'high',
          layer: 'probe',
          params: { allowed: ['limit'] },
        },
      ],
    });

    const result = await runConfiguredExternalAction({ type: 'configured_sync' }, ctx);

    expect(result.success).toBe(true);
    expect(result.resolution).toBe('link');
    expect(result.cwd.replace(/\\/g, '/')).toBe(linkRepo.replace(/\\/g, '/'));
  });

  it('loads configured external action env from the tool root, overriding stale process env for tool-defined keys', async () => {
    const ctx = makeCtx();
    installConfiguredActionProject(ctx);
    const toolRoot = join(ctx.projectRoot, 'tool');
    mkdirSync(toolRoot, { recursive: true });
    writeFileSync(join(toolRoot, '.env'), [
      'AGENTANK_TANK_KEY=tool-root-key',
      'HOST_ONLY_FROM_TOOL=tool-value',
      '',
    ].join('\n'), 'utf-8');
    process.env.AGENTANK_TANK_KEY = 'host-key';

    ctx.host.configuredExternalRunner = vi.fn(async ({ env }) => {
      return {
        success: true,
        status: 'checked',
        hostKeyVisible: env.AGENTANK_TANK_KEY,
        toolOnlyVisible: env.HOST_ONLY_FROM_TOOL,
      };
    });

    const result = await runConfiguredExternalAction({ type: 'configured_sync' }, ctx);

    expect(result.hostKeyVisible).toBe('tool-root-key');
    expect(result.toolOnlyVisible).toBe('tool-value');
    expect(process.env.AGENTANK_TANK_KEY).toBe('host-key');
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

    expect(source).toContain('Legacy bounded read-only investigation');
    expect(source).not.toContain('sandboxed read-only probe');
    expect(source).toContain('prefer agent_run');
  });

  it('registry marks run_probe and agent_execute as compatibility actions', () => {
    const source = readFileSync(new URL('../src/actions/registry.mjs', import.meta.url), 'utf-8');

    expect(source).toContain("name: 'run_probe'");
    expect(source).toContain('[COMPAT');
    expect(source).toContain("name: 'agent_execute'");
    expect(source).toContain('[PRIMARY EXECUTION]');
    expect(source).toContain('[RECORDING ONLY]');
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

  it('does not silently fallback when agent observation writes are missing', async () => {
    const ctx = makeAgenticCtx({
      status: 'completed',
      summary: 'Agent completed without observation writes.',
      writes: {},
    });

    const result = await actionHandlers.record_observation({
      type: 'record_observation',
      params: {
        provider: 'llm_only',
        source: 'test',
        subject: 'missing-writes',
        content: 'should not be written via fallback',
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.fallback_used).not.toBe(true);
    expect(result.verification_hints.join(' ')).toMatch(/agent_run/);
    expect(ctx.host.intelligenceStore.readRecentIntel({ days: 1, limit: 5 })).toEqual([]);
  });

  it('requires bounded probe fields before recording a probe', async () => {
    const ctx = makeAgenticCtx();
    await expect(actionHandlers.propose_probe({
      type: 'propose_probe',
      params: { hypothesis: 'too little data' },
    }, ctx)).rejects.toThrow(/missing required field/);
  });

  it('records probe proposals locally without starting an agent', async () => {
    const ctx = makeAgenticCtx();
    const result = await actionHandlers.propose_probe({
      type: 'propose_probe',
      id: 'probe-bootstrap-1',
      params: {
        target: 'self-evolution workflow',
        hypothesis: 'A record-only first cycle proves the integration path.',
        success_signal: 'Receipts appear under the active subject runtime.',
        failure_signal: 'Any action modifies external projects.',
        death_boundary: 'Do not write outside the active subject runtime.',
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('local');
    expect(result.probe_id).toBe('probe-bootstrap-1');
    expect(ctx.ai.agentCalls).toHaveLength(0);
    expect(result.verification_hints.join(' ')).toMatch(/agent_run/);
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
    expect(result.compatibility_action).toBe(true);
    expect(result.agent.outputs.recommendation).toBe('inspect queue receipts');
    expect(result.boundary_risk).toMatchObject({
      boundary_contract: 'present',
      boundary_model: 'soft_contract_only',
      sandbox_backing: ['none'],
    });
    expect(verification.status).toBe('improved');
    expect(verification.value.compatibility_action).toBe(true);
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

  it('logs Cursor SDK run stream details to host logger during agent_execute', async () => {
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    mockCursorSession([
      { id: 'cursor-log-initial', status: 'finished', result: 'Initial work.' },
      {
        id: 'cursor-log-final',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Cursor logging test completed.',
        }),
      },
    ]);

    const ctx = makeAgentProviderCtx('Inspect queue for logging test.');
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Verify agent run logging',
        mode: 'observe',
      }),
    }, ctx);

    expect(result.success).toBe(true);
    const infoCalls = ctx.host.logger.info.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((msg) => msg.includes('[agent:cursor]'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('run_bound') && msg.includes('cursor-log-initial'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('tool_started') && msg.includes('Read'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('tool_finished') && msg.includes('Read'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('assistant_segment'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('turn_finished'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('provider_finished'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('jsonl_path'))).toBe(true);

    const jsonlPath = join(ctx.host.dataRoot, 'evolution', 'agent-runs', 'test-cycle.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const rows = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.some((row) => row.event === 'tool_started' && row.name === 'Read')).toBe(true);
    expect(rows.some((row) => row.event === 'tool_finished' && row.name === 'Read')).toBe(true);
    expect(rows.some((row) => row.event === 'assistant_segment')).toBe(true);
    expect(rows.filter((row) => row.event === 'assistant_text')).toHaveLength(0);
    expect(rows.some((row) => row.event === 'provider_finished')).toBe(true);
    expect(rows.every((row) => row.cycle_id === 'test-cycle')).toBe(true);
  });

  it('logs Claude SDK assistant and tool_use events to host logger', async () => {
    process.env.JEA_AGENT_PROVIDER = 'claude_code_sdk';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(claudeQuery)
      .mockImplementationOnce(() => streamMessages([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Reading relevant files.' },
              { type: 'tool_use', name: 'Grep', input: { pattern: 'pending' } },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-log-session',
          result: 'Completed initial Claude work.',
        },
      ]))
      .mockImplementationOnce(() => streamMessages([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'claude-log-session',
          result: JSON.stringify({
            status: 'completed',
            summary: 'Claude logging test completed.',
          }),
        },
      ]));

    const ctx = makeAgentProviderCtx();
    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Verify Claude agent run logging',
      }),
    }, ctx);

    expect(result.success).toBe(true);
    const infoCalls = ctx.host.logger.info.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((msg) => msg.includes('[agent:claude]'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('tool_started') && msg.includes('Grep'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('assistant_segment'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('session_bound'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('provider_finished'))).toBe(true);

    const jsonlPath = join(ctx.host.dataRoot, 'evolution', 'agent-runs', 'test-cycle.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const rows = readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.some((row) => row.event === 'tool_started' && row.name === 'Grep')).toBe(true);
    expect(rows.some((row) => row.event === 'capability_gap' && row.feature === 'tool_lifecycle')).toBe(true);
  });

  it('respects JEA_AGENT_RUN_JSONL=0 and skips JSONL persistence', async () => {
    process.env.JEA_AGENT_RUN_JSONL = '0';
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    mockCursorSession([
      { id: 'cursor-no-jsonl-initial', status: 'finished', result: 'Initial work.' },
      {
        id: 'cursor-no-jsonl-final',
        status: 'finished',
        result: JSON.stringify({ status: 'completed', summary: 'No JSONL test.' }),
      },
    ]);

    const ctx = makeAgentProviderCtx();
    await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'JSONL disabled test',
        mode: 'observe',
      }),
    }, ctx);

    expect(ctx.host.logger.info).toHaveBeenCalled();
    const jsonlPath = join(ctx.host.dataRoot, 'evolution', 'agent-runs', 'test-cycle.jsonl');
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it('respects JEA_AGENT_RUN_LOG=0 and suppresses agent run detail logs', async () => {
    process.env.JEA_AGENT_RUN_LOG = '0';
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    mockCursorSession([
      { id: 'cursor-silent-initial', status: 'finished', result: 'Silent initial.' },
      {
        id: 'cursor-silent-final',
        status: 'finished',
        result: JSON.stringify({ status: 'completed', summary: 'Silent test.' }),
      },
    ]);

    const ctx = makeAgentProviderCtx();
    await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'cursor_sdk',
        objective: 'Silent logging test',
        mode: 'observe',
      }),
    }, ctx);

    expect(ctx.host.logger.info).not.toHaveBeenCalled();
    const jsonlPath = join(ctx.host.dataRoot, 'evolution', 'agent-runs', 'test-cycle.jsonl');
    expect(existsSync(jsonlPath)).toBe(false);
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

  it('ignores model-provided run_spec provider and uses configured default provider', async () => {
    process.env.JEA_AGENT_PROVIDER = 'cursor_sdk';
    process.env.CURSOR_API_KEY = 'cursor-test-key';
    const ctx = makeAgentProviderCtx();
    mockCursorSession([
      { id: 'cursor-run-spec-initial', status: 'finished', result: 'Started run spec provider test.' },
      {
        id: 'cursor-run-spec-final',
        status: 'finished',
        result: JSON.stringify({
          status: 'completed',
          summary: 'Cursor handled run_spec despite model provider field.',
          evidence: { provider_boundary: 'run_spec provider ignored' },
        }),
      },
    ]);

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'source_root',
          permission_profile: 'read_only',
          provider: 'claude_code_sdk',
          intent: 'Use host configured provider even if model emitted provider.',
          context: { why_now: 'verify provider control boundary' },
          expected_output: ['strict JSON receipt'],
        },
      },
    }, ctx);

    expect(result.provider).toBe('cursor_sdk');
    expect(result.agent.outputs.cursor.run_id).toBe('cursor-run-spec-final');
    expect(Agent.create).toHaveBeenCalledOnce();
    expect(claudeQuery).not.toHaveBeenCalled();
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

  it('supports Reasonix CLI as the configured default provider', async () => {
    process.env.JEA_AGENT_PROVIDER = 'reasonix';
    const ctx = makeAgentProviderCtx('Reasonix translated task.');
    const logPath = join(ctx.projectRoot, 'reasonix-calls.jsonl');
    process.env.FAKE_REASONIX_LOG = logPath;
    installFakeReasonix(ctx, [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      ...fakeReasonixTaskReaderLines(),
      "appendFileSync(process.env.FAKE_REASONIX_LOG, `${JSON.stringify({ argv: process.argv.slice(2), input })}\\n`);",
      "if (input.includes('verification_attempt: 1')) {",
      "  console.log(JSON.stringify({ status: 'completed', summary: 'Reasonix CLI completed.', outputs: { recommendation: 'keep provider' } }));",
      "} else {",
      "  console.log('Initial Reasonix work complete.');",
      "}",
      '',
    ].join('\n'));

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        objective: 'Use Reasonix as the configured default provider',
      }),
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('reasonix_cli');
    expect(result.agent.summary).toBe('Reasonix CLI completed.');
    expect(result.agent.outputs.reasonix.run_results).toHaveLength(2);
    expect(result.agent.outputs.reasonix.capability_gaps).toContain('tool_trace');
    const calls = readFileSync(logPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls[0].argv).toContain('run');
    expect(calls[0].argv).not.toContain('--config');
    expect(calls[0].argv.some((arg) => arg.includes('Reasonix translated task.'))).toBe(true);
    expect(calls[0].argv.some((arg) => arg.includes('Reasonix CLI host constraints'))).toBe(true);
    expect(calls[0].input).toContain('Reasonix translated task.');
    expect(calls[1].input).toContain('verification_attempt: 1/3');
    const infoCalls = ctx.host.logger.info.mock.calls.map(([msg]) => String(msg));
    expect(infoCalls.some((msg) => msg.includes('[agent:reasonix]'))).toBe(true);
    expect(infoCalls.some((msg) => msg.includes('capability_gap') && msg.includes('tool_trace'))).toBe(true);
  });

  it('extracts embedded Reasonix CLI JSON receipts during verification', async () => {
    const ctx = makeAgentProviderCtx('Reasonix embedded JSON task.');
    installFakeReasonix(ctx, [
      "import { readFileSync } from 'node:fs';",
      ...fakeReasonixTaskReaderLines(),
      "if (input.includes('verification_attempt: 1')) {",
      "  console.log('Done. ' + JSON.stringify({ status: 'completed', summary: 'Embedded Reasonix JSON parsed.', evidence: { observations: ['ok'] } }));",
      "} else {",
      "  console.log('Initial work complete.');",
      "}",
      '',
    ].join('\n'));

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      params: {
        provider: 'deepseek_reasonix',
        run_spec: {
          primary_cwd_kind: 'source_root',
          permission_profile: 'read_only',
          intent: 'Exercise Reasonix embedded receipt parsing.',
          context: { why_now: 'provider integration test' },
          expected_output: ['strict JSON receipt'],
        },
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.provider).toBe('reasonix_cli');
    expect(result.agent.raw_receipt_parse_mode).toBe('extracted_json');
    expect(result.agent.verification_hints).toContain('agent receipt parsed from embedded JSON object');
  });

  it('defers Reasonix CLI provider when the binary cannot start', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    const ctx = makeAgentProviderCtx();
    process.env.REASONIX_BIN = join(ctx.projectRoot, 'missing-reasonix-bin');

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'reasonix_cli',
        objective: 'Try Reasonix without an installed binary',
      }),
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.provider).toBe('reasonix_cli');
    expect(result.error).toMatch(/ENOENT|not found|no such file/i);
    expect(result.evidence.provider_failure).toMatchObject({
      provider: 'reasonix_cli',
      phase: 'cli_spawn_error',
    });
  });

  it('passes Reasonix task via argv for npm flavor and stdin for oversized go prompts', () => {
    const base = buildReasonixRunBaseArgs({
      binaryArgs: ['fake.mjs'],
      model: 'deepseek-flash',
      maxSteps: 12,
      flavor: 'npm',
    });
    expect(base).toEqual(['fake.mjs', 'run', '--model', 'deepseek-flash']);
    expect(buildReasonixRunBaseArgs({
      binaryArgs: ['reasonix'],
      model: 'deepseek-flash',
      maxSteps: 12,
      flavor: 'go',
    })).toEqual(['reasonix', 'run', '--model', 'deepseek-flash', '--max-steps', '12']);

    const npmInvocation = buildReasonixTurnInvocation(base, 'hello npm task', 'npm');
    expect(npmInvocation.args.at(-1)).toBe('hello npm task');
    expect(npmInvocation.stdinText).toBeNull();

    const goInvocation = buildReasonixTurnInvocation(base, 'x'.repeat(8000), 'go');
    expect(goInvocation.args).toEqual(base);
    expect(goInvocation.stdinText?.length).toBe(8000);
  });

  it('builds conservative Reasonix config from permission profiles', () => {
    const ctx = makeCtx();
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    const readOnly = buildReasonixOptions({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'reasonix_cli',
        cwd: ctx.projectRoot,
        mode: 'observe',
      }),
    }, ctx);
    const readOnlyConfig = readFileSync(readOnly.configPath, 'utf-8');
    expect(readOnlyConfig).toContain('mode = "deny"');
    expect(readOnlyConfig).toContain('"bash(*)"');
    expect(readOnlyConfig).toContain('"read_file"');
    expect(readOnlyConfig).not.toContain('"write_file", "edit_file"');
    readOnly.generatedConfig.cleanup();

    process.env.JEA_REASONIX_ALLOW_BASH = '1';
    const writeProfile = buildReasonixOptions({
      type: 'agent_run',
      params: {
        provider: 'reasonix_cli',
        run_spec: {
          primary_cwd: ctx.projectRoot,
          permission_profile: 'workspace_write',
          intent: 'Patch inside the configured workspace.',
          context: { why_now: 'test config generation' },
          expected_output: ['changed files'],
        },
      },
    }, ctx);
    const writeConfig = readFileSync(writeProfile.configPath, 'utf-8');
    expect(writeConfig).toContain('mode = "allow"');
    expect(writeConfig).toContain('"write_file"');
    expect(writeConfig).toContain('"bash"');
    expect(writeConfig).toContain(`workspace_root = ${JSON.stringify(ctx.projectRoot)}`);
    writeProfile.generatedConfig.cleanup();
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
    expect(result.status).toBe('completed');
    expect(result.agent.execution_status).toBe('completed');
    expect(result.agent.schema_status).toBe('invalid');
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
    expect(captured[0].options.systemPrompt.append).toContain('standing_memory_canonical_path: data/intelligence/memory/standing_memory.json');
    expect(captured[0].options.systemPrompt.append).toContain('./standing_memory.json missing at execution_cwd root is only a missing alias');
    expect(captured[1].prompt).toContain('Please self-check');
    expect(captured[1].options.resume).toBe('claude-session-1');
    expect(captured[0].options.permissionMode).toBe('bypassPermissions');
    expect(captured[0].options.allowDangerouslySkipPermissions).toBe(true);
    expect(captured[0].options.persistSession).toBe(true);
    expect(captured[0].options.settingSources).toEqual(['user', 'project', 'local']);
    expect(captured[0].options.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(verification.status).toBe('improved');
  });

  it('loads Claude SDK execution env from the execution cwd, overriding stale process env for execution-defined keys', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AGENTANK_TANK_KEY = 'host-key';
    const ctx = makeAgentProviderCtx('Please verify execution environment visibility.');
    const executionRoot = join(ctx.projectRoot, 'subject-runtime');
    mkdirSync(executionRoot, { recursive: true });
    writeFileSync(join(executionRoot, '.env'), [
      'AGENTANK_TANK_KEY=execution-root-key',
      'EXECUTION_ONLY_TOKEN=execution-only',
      '',
    ].join('\n'), 'utf-8');

    const seenEnv = [];
    vi.mocked(claudeQuery).mockImplementation((args) => {
      seenEnv.push({
        agentank: args.options?.env?.AGENTANK_TANK_KEY ?? process.env.AGENTANK_TANK_KEY,
        executionOnly: args.options?.env?.EXECUTION_ONLY_TOKEN ?? process.env.EXECUTION_ONLY_TOKEN,
      });
      if (seenEnv.length === 1) {
        return streamMessages([
          { type: 'result', subtype: 'success', session_id: 'env-session', result: 'Environment inspected.' },
        ]);
      }
      return streamMessages([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'env-session',
          result: JSON.stringify({
            status: 'completed',
            summary: 'Execution env was visible.',
          }),
        },
      ]);
    });

    const result = await actionHandlers.agent_execute({
      type: 'agent_execute',
      params: directAgentParams({
        provider: 'claude_code_sdk',
        objective: 'Inspect execution environment',
        cwd: executionRoot,
      }),
    }, ctx);

    expect(result.success).toBe(true);
    expect(seenEnv).toEqual([
      { agentank: 'execution-root-key', executionOnly: 'execution-only' },
      { agentank: 'execution-root-key', executionOnly: 'execution-only' },
    ]);
    expect(process.env.AGENTANK_TANK_KEY).toBe('host-key');
    expect(process.env.EXECUTION_ONLY_TOKEN).toBeUndefined();
    expect(vi.mocked(claudeQuery).mock.calls[0][0].options.env.AGENTANK_TANK_KEY).toBe('execution-root-key');
    expect(vi.mocked(claudeQuery).mock.calls[0][0].options.env.EXECUTION_ONLY_TOKEN).toBe('execution-only');
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

  it('preserves Claude SDK exception diagnostics in agent_run receipts', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(claudeQuery).mockImplementation(() => {
      throw new Error('provider transport disconnected');
    });

    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Exercise Claude provider failure observability',
      params: {
        provider: 'claude_code_sdk',
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: 'Run a lightweight diagnostic.',
          context: { why_now: 'verify provider failure diagnostics' },
          expected_output: ['provider failure diagnostic'],
        },
      },
    }, makeAgentProviderCtx('Translated diagnostic task prompt.'));

    expect(result.success).toBe(false);
    expect(result.execution_status).toBe('failed');
    expect(result.error).toContain('provider transport disconnected');
    expect(result.evidence.provider_failure).toMatchObject({
      provider: 'claude_code_sdk',
      phase: 'sdk_query_exception',
      message: 'provider transport disconnected',
    });
    expect(result.outputs.provider_failure.translated_prompt_chars).toBeGreaterThan(0);
    expect(result.verification_hints).toContain('provider failure phase: sdk_query_exception');
  });

  it('preserves Claude SDK result error diagnostics in agent_run receipts', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.mocked(claudeQuery).mockImplementation(() => streamMessages([
      {
        type: 'result',
        subtype: 'error',
        session_id: 'claude-error-session',
        result: 'model overloaded before tool use',
      },
    ]));

    const ctx = makeAgentProviderCtx('Translated diagnostic task prompt.');
    const result = await actionHandlers.agent_run({
      type: 'agent_run',
      description: 'Exercise Claude result error observability',
      params: {
        provider: 'claude_code_sdk',
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: 'Run another lightweight diagnostic.',
          context: { why_now: 'verify result subtype diagnostics' },
          expected_output: ['provider result diagnostic'],
        },
      },
    }, ctx);

    expect(result.success).toBe(false);
    expect(result.execution_status).toBe('failed');
    expect(result.evidence.provider_failure).toMatchObject({
      provider: 'claude_code_sdk',
      phase: 'initial_query_result_error',
      sdk_result_subtype: 'error',
      session_id: 'claude-error-session',
      message: 'model overloaded before tool use',
    });
    expect(result.outputs.provider_failure.run_results_count).toBe(1);
    expect(result.outputs.claude.provider_failure.phase).toBe('initial_query_result_error');
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
    expect(result.compatibility_action).toBe(true);
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

  it('finds nested diary files via keyword search under hierarchical diaries layout', () => {
    const ctx = makeCtx();
    ctx.host.runtimeRoot = join(ctx.projectRoot, 'runtime', 'subjects', 'test');
    const diaryPath = join(
      ctx.host.runtimeRoot,
      'data',
      'evolution',
      'diaries',
      '2026',
      '05',
      '2026-05-25',
      'exec-20260525-100536.md',
    );
    mkdirSync(dirname(diaryPath), { recursive: true });
    writeFileSync(diaryPath, '# diary\nunique-nested-marker-12345\n', 'utf-8');

    const result = runReadOnlyProbe({
      type: 'run_probe',
      params: {
        objective: 'Find nested diary marker unique-nested-marker-12345',
        targets: ['data/evolution/diaries/'],
        keywords: ['unique-nested-marker-12345'],
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.evidence.matches_found).toBeGreaterThan(0);
    expect(result.evidence.steps.some((step) => step.tool === 'keyword_search' && step.status === 'succeeded')).toBe(true);
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

  it('warns when read_only agent_run asks to persist files', () => {
    const ctx = makeCtx();
    const validation = validateAgentRunSpec({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'source_root',
          permission_profile: 'read_only',
          intent: 'Read remote state and persist a sanitized summary.',
          context: { constraints: ['只持久化脱敏摘要'] },
          expected_output: ['write data/sync/remote_state_sanitized.json'],
        },
      },
    }, ctx);

    expect(validation.valid).toBe(true);
    expect(validation.warnings).toContain('read_only run_spec mentions writing, saving, or persistence');

    const writable = validateAgentRunSpec({
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'source_root',
          permission_profile: 'workspace_write',
          intent: 'Read remote state and persist a sanitized summary.',
          context: { constraints: ['只持久化脱敏摘要'] },
          expected_output: ['write data/sync/remote_state_sanitized.json'],
        },
      },
    }, ctx);
    expect(writable.warnings).not.toContain('read_only run_spec mentions writing, saving, or persistence');
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

