import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  AcpRuntime,
  decideHeadlessPermission,
} from '../src/actions/agent-adapter/acp/index.mjs';
import { runAgenticAction } from '../src/actions/agent-adapter/index.mjs';
import { actionHandlers } from '../src/actions/handlers/builtin.mjs';
import { DecisionQueue, ExecutionPipeline } from '../src/engine/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fakeAgent = join(here, 'fixtures', 'fake-acp-agent.mjs');
const provider = 'acp:fake';
let tempDirs = [];

function tempDir(prefix = 'jea-acp-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function framework() {
  return {
    id: 'fake',
    provider,
    command: process.execPath,
    args: [fakeAgent],
    versionArgs: ['--version'],
    credentialEnv: [],
  };
}

function collector() {
  const events = [];
  const open = new Map();
  return {
    events,
    openTools: open,
    buffer: null,
    emit(event, fields = {}, level = 'info') { events.push({ event, fields, level }); },
    emitJsonlPath() {},
    noteNativeType(type) { events.push({ event: 'native_event', fields: { native_type: type } }); },
    beginTurn() {
      this.buffer = { appendAssistant() {}, flushAssistant() {} };
    },
    endTurn(fields) {
      events.push({ event: 'turn_finished', fields });
      this.buffer = null;
    },
    markToolStarted(id, name) {
      open.set(id, name);
      events.push({ event: 'tool_started', fields: { id, name } });
    },
    markToolFinished(id, name, status) {
      open.delete(id);
      events.push({ event: 'tool_finished', fields: { id, name, status } });
    },
  };
}

function permissionRequest(kind, path) {
  return {
    toolCall: {
      toolCallId: 'tool',
      kind,
      title: `${kind} ${path ?? ''}`,
      locations: path ? [{ path }] : [],
      rawInput: path ? { path } : {},
    },
    options: [
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ],
  };
}

function agentAction(cwd, chosenProvider = provider) {
  return {
    id: 'acp-action',
    type: 'agent_execute',
    params: {
      provider: chosenProvider,
      cwd,
      mode: 'observe',
      boundary: { cwd },
      objective: 'Inspect the fixture and return evidence.',
      acceptance: 'Return a strict receipt.',
      escape_hatch_reason: 'ACP adapter integration test',
      permission_profile: 'read_only',
    },
  };
}

function runContext(cwd, env = {}) {
  return {
    projectRoot: cwd,
    cycleId: 'cycle-acp',
    env: { ...process.env, ...env },
    ai: { chatMessages: async () => 'Inspect the fixture and return the required strict JSON receipt.' },
    host: {
      sourceRoot: cwd,
      acpFrameworkRegistry: new Map([[provider, framework()]]),
      logger: { info() {}, warning() {}, error() {} },
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('ACP headless permissions', () => {
  it('denies writes for read_only and limits workspace_write to roots', () => {
    const root = tempDir();
    const inside = join(root, 'inside.txt');
    const outside = join(dirname(root), 'outside.txt');
    expect(decideHeadlessPermission({
      request: permissionRequest('edit', inside),
      permissionProfile: 'read_only',
      roots: [root],
    })).toMatchObject({ allowed: false, reason: 'read_only_write_denied' });
    expect(decideHeadlessPermission({
      request: permissionRequest('edit', inside),
      permissionProfile: 'workspace_write',
      roots: [root],
    })).toMatchObject({ allowed: true, reason: 'workspace_write_inside_roots' });
    expect(decideHeadlessPermission({
      request: permissionRequest('edit', outside),
      permissionProfile: 'workspace_write',
      roots: [root],
    }).allowed).toBe(false);
    expect(decideHeadlessPermission({
      request: permissionRequest('execute'),
      permissionProfile: 'workspace_write',
      roots: [root],
    }).allowed).toBe(false);
    expect(decideHeadlessPermission({
      request: permissionRequest('fetch', 'https://example.com'),
      permissionProfile: 'workspace_write',
      roots: [root],
    }).reason).toBe('remote_access_default_deny');
  });
});

describe('ACP stdio runtime', () => {
  it('runs initialize/session/prompt/permission/events/close lifecycle', async () => {
    const cwd = tempDir();
    const log = join(cwd, 'fake.jsonl');
    const obs = collector();
    const runtime = new AcpRuntime({
      framework: framework(),
      cwd,
      permissionProfile: 'read_only',
      env: {
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_PERMISSION_KIND: 'edit',
        FAKE_ACP_PERMISSION_PATH: join(cwd, 'denied.txt'),
      },
      observer: obs,
      timeoutMs: 2_000,
      killGraceMs: 100,
    });
    await runtime.start();
    const turn = await runtime.prompt('work', { timeoutMs: 2_000 });
    await runtime.close();

    expect(turn.response.stopReason).toBe('end_turn');
    const records = readFileSync(log, 'utf-8').trim().split('\n').map(JSON.parse);
    expect(records.map((item) => item.event)).toEqual(expect.arrayContaining([
      'initialize', 'session_new', 'prompt', 'session_close',
    ]));
    expect(obs.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'permission_decision', fields: expect.objectContaining({ allowed: false }) }),
      expect.objectContaining({ event: 'tool_started' }),
      expect.objectContaining({ event: 'tool_finished' }),
    ]));
  });

  it('cancels timed-out prompts and escalates cleanup to SIGKILL', async () => {
    const cwd = tempDir();
    const log = join(cwd, 'timeout.jsonl');
    const runtime = new AcpRuntime({
      framework: framework(),
      cwd,
      env: {
        ...process.env,
        FAKE_ACP_LOG: log,
        FAKE_ACP_HANG: '1',
        FAKE_ACP_IGNORE_CANCEL: '1',
        FAKE_ACP_IGNORE_SIGTERM: '1',
      },
      observer: collector(),
      timeoutMs: 80,
      killGraceMs: 50,
    });
    await runtime.start();
    await expect(runtime.prompt('hang', { timeoutMs: 80 })).rejects.toMatchObject({ code: 'acp_timeout' });
    await runtime.close();
    expect(runtime.child.signalCode).toBe('SIGKILL');
    expect(readFileSync(log, 'utf-8')).toContain('"event":"cancel"');
  });
});

describe('ACP Phase 2 provider', () => {
  it('reuses one session across receipt verification attempts', async () => {
    const cwd = tempDir();
    const result = await runAgenticAction(agentAction(cwd), runContext(cwd, {
      FAKE_ACP_INVALID_FIRST_VERIFY: '1',
    }));
    expect(result.success).toBe(true);
    expect(result.provider).toBe(provider);
    expect(result.agent.schema_status).toBe('valid');
    expect(result.agent.outputs.agent_loop).toMatchObject({
      verification_attempts: 2,
      same_session: true,
    });
    expect(result.agent.outputs.acp.run_results.map((turn) => turn.turn)).toEqual([
      'initial', 'verify-1', 'verify-2',
    ]);
  });

  it('propagates unavailable ACP as deferred through agent_run handler', async () => {
    const cwd = tempDir();
    const receipts = [];
    const action = {
      id: 'deferred-acp',
      type: 'agent_run',
      params: {
        provider: 'acp:missing',
        run_spec: {
          primary_cwd: cwd,
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: 'Inspect runtime state',
          context: { reason: 'test' },
          expected_output: { evidence: true },
        },
      },
    };
    const result = await actionHandlers.agent_run(action, {
      projectRoot: cwd,
      cycleId: 'cycle-deferred',
      ai: { chatMessages: async () => 'translated task' },
      host: {
        sourceRoot: cwd,
        dataRoot: cwd,
        intelligenceStore: {
          recordActionReceipt(_action, receipt) { receipts.push(receipt); },
          ingestObservation() { return 0; },
        },
      },
    });
    expect(result).toMatchObject({
      success: false,
      deferred: true,
      provider: 'acp:missing',
    });
    expect(receipts.at(-1)?.deferred).toBe(true);
  });

  it('releases deferred agent decisions without consuming retry attempts', async () => {
    const cwd = tempDir();
    const queue = new DecisionQueue({ dataDir: cwd });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-release',
      actions: [{
        type: 'agent_run',
        description: 'deferred ACP',
        params: { run_spec: { permission_profile: 'read_only' } },
      }],
    });
    const pipeline = new ExecutionPipeline({
      projectRoot: cwd,
      decisionQueue: queue,
      cycleId: 'cycle-release',
      agentBudget: 1,
      agentConcurrency: 1,
      host: {
        basePath: cwd,
        actionHandlers: {
          agent_run: async () => ({ success: false, deferred: true, provider: 'acp:missing' }),
        },
      },
    });
    const execution = await pipeline.run();
    const id = execution.executed[0].id;
    expect(execution.agent_waves[0].outcomes[0].status).toBe('deferred');
    expect(queue.getById(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it.skipIf(process.env.JEA_LIVE_ACP_CLAUDE_CODE !== '1')('runs the real Claude ACP agent when explicitly enabled', async () => {
    const cwd = tempDir();
    const result = await runAgenticAction(agentAction(cwd, 'acp:claude-code'), {
      ...runContext(cwd),
      env: process.env,
      host: { sourceRoot: process.cwd(), logger: { info() {}, warning() {}, error() {} } },
    });
    expect(result.provider).toBe('acp:claude-code');
    expect(result.success).toBe(true);
  });
});

