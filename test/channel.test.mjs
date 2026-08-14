import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { enqueueTask, pendingTasksPath } from '../src/daemon/daemon-tasks.mjs';
import { enqueueChannelTask, readChannelTaskQueue, channelPendingTasksPath } from '../src/channel/task-queue.mjs';
import {
  writePendingInbound,
  writeOutboxMessage,
  listOutboxPending,
  markOutboxSent,
  cooldownActive,
  readPresenceState,
  readJsonFile,
  reconcilePendingSpeechGeneration,
  trackPendingSpeechGeneration,
} from '../src/channel/state.mjs';
import { createIntelligenceStore, mergeDeliverableDeliveryStatus } from '../src/intelligence/store.mjs';
import { isPresenceInteractionRecord } from '../src/channel/presence-memory.mjs';
import { resolvePresenceAffordances } from '../src/channel/presence-affordances.mjs';
import { readChannelEvents, recordChannelEvent } from '../src/channel/audit.mjs';
import { drainChannelInbound, runChannelInboundTask, runChannelTask, runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { runChannelAgentRunTask } from '../src/channel/agent-runner.mjs';
import {
  persistChannelDeliverable,
  resolveDeliverablePath,
  extractDeliverableTldr,
  createDeliverableStore,
} from '../src/channel/deliverable.mjs';
import {
  renderDeliveryToOutbox,
  resolveDeliveryItems,
  hasRichFormatting,
} from '../src/channel/delivery-renderer.mjs';
import { FeishuSender } from '../src/channel/adapters/feishu/sender.mjs';
import { planDocumentInsertions } from '../src/channel/adapters/feishu/client.mjs';
import { bridgeIntentDir } from '../src/channel/adapters/bridge-intent/index.mjs';
import { runChannelClassifierTask } from '../src/channel/classifier.mjs';
import { claimNextChannelTask } from '../src/channel/task-queue.mjs';
import { resolveChannelWorkerTaskTypes, taskTypesForChannelRole, DEFAULT_CHANNEL_ROLES } from '../src/channel/channel-roles.mjs';
import { collectAttentionSignals } from '../src/channel/notify.mjs';
import { readPendingOperatorBriefs } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { runChannelTick } from '../src/channel/dispatch.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import {
  requestExpressionRecompute,
  PRESENCE_REACTOR_IDEMPOTENCY,
} from '../src/channel/wake.mjs';
import { cancelDeprecatedChannelTasks } from '../src/channel/queue-cleanup.mjs';
import {
  appendChannelEvent,
  listPendingChannelEvents,
  markChannelEventsFailed,
  summarizeChannelEventQueue,
} from '../src/channel/event-queue.mjs';
import { runChannelSpeechGenerationTask, runPresenceReactor } from '../src/channel/presence-reactor.mjs';
import { buildPresenceContext } from '../src/channel/presence-context.mjs';
import { buildExpressionCandidates } from '../src/channel/expression-candidates.mjs';
import {
  planPresence,
  planPresenceDeterministic,
  planPresenceOperatorBriefFastAck,
  planPresenceWithLlm,
} from '../src/channel/presence-planner.mjs';
import { executePresenceDecisionPlan } from '../src/channel/presence-decision-executor.mjs';
import { resolvePresenceConfig } from '../src/channel/presence-config.mjs';
import { resolveSubjectReplyIdentity } from '../src/channel/subject-identity.mjs';
import { CHANNEL_TASK_DEFAULT_PRIORITY } from '../src/channel/types.mjs';
import { parseControlRequestFromText } from '../src/channel/control-actions.mjs';
import { classifyChannelEnvelope, decisionFromClassifierItem } from '../src/channel/ingest.mjs';
import { buildSpeechGenerationEventPayload, speechIntentFromDeterministic } from '../src/channel/speech-intent.mjs';
import { resolveEvolutionMode } from '../src/daemon/evolution-mode.mjs';
import { channelCommand } from '../src/cli/commands/channel.mjs';
import { readPendingCycleStartRequest } from '../src/daemon/cycle-start-requests.mjs';
import {
  createChannelRoleWorkerState,
  initChannelCoordinatorState,
  readChannelWorkerState,
  requestChannelWorkerStop,
} from '../src/channel/worker-state.mjs';
import {
  inferDeterministicUnderstanding,
  normalizeUnderstanding,
  candidateNeedsImmediateAction,
  candidateEligibleForDeterministicAgent,
} from '../src/channel/classifier-understanding.mjs';

let tempDir = null;

function makeRoot({
  channelTarget = 'oc_test',
  feishu = {},
  presence = { enabled: true, planner: 'deterministic' },
  classifier = {
    enabled: true,
    mode: 'deterministic',
    interval_ms: 30_000,
    batch_size: 5,
  },
  additionalChannels = {},
  policyText = null,
} = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(tempDir, 'policies', 'subjects', 'alpha.md'),
    policyText ?? '# alpha\n\n## Subject\nalpha 是测试主体。\n\n## Persona\n本主体名为「小测」，表达风格简洁克制。',
    'utf-8',
  );
  const channels = {
    feishu: { default_chat_id: channelTarget, mock: true, ...feishu },
    presence,
    classifier,
    ...additionalChannels,
  };
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels,
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'intelligence'), { recursive: true });
  return tempDir;
}

function writeOperatorBinding(root, subject, openId = 'ou_operator') {
  const { runtimeRoot } = runtimeForSubject(root, subject);
  writeJsonFile(join(runtimeRoot, 'data', 'channel', 'feishu-operator-binding.json'), {
    schema_version: 1,
    subject,
    open_id: openId,
    bound_at: new Date().toISOString(),
  });
}

async function captureConsoleLog(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('channel domain', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  describe('task domain', () => {
    it('claimNextChannelTask filters by types array', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', { type: 'channel_notify', idempotencyKey: 'n1', priority: 10 });
      enqueueChannelTask(root, 'alpha', { type: 'channel_classifier', idempotencyKey: 'c1', priority: 50 });
      const notifyClaim = claimNextChannelTask(root, 'alpha', {
        workerId: 'notify-worker',
        types: taskTypesForChannelRole('notify'),
      });
      expect(notifyClaim.task?.type).toBe('channel_notify');
      const classifierClaim = claimNextChannelTask(root, 'alpha', {
        workerId: 'classifier-worker',
        types: taskTypesForChannelRole('classifier'),
      });
      expect(classifierClaim.task?.type).toBe('channel_classifier');
    });

    it('--channel-task-types resolves to custom task filters', () => {
      const taskTypes = resolveChannelWorkerTaskTypes({
        'channel-task-types': 'channel_presence,channel_classifier',
      }, 'custom');
      expect(taskTypes).toEqual(['channel_presence', 'channel_classifier']);
    });

    it('default channel roles include control worker', () => {
      expect(DEFAULT_CHANNEL_ROLES).toContain('control');
      expect(DEFAULT_CHANNEL_ROLES).toContain('agent');
      expect(taskTypesForChannelRole('control')).toEqual(['channel_control_action']);
      expect(taskTypesForChannelRole('agent')).toEqual(['channel_agent_run']);
    });

    it('channel_control_action priority is higher than channel_presence', () => {
      expect(CHANNEL_TASK_DEFAULT_PRIORITY.channel_control_action)
        .toBeLessThan(CHANNEL_TASK_DEFAULT_PRIORITY.channel_presence);
      expect(CHANNEL_TASK_DEFAULT_PRIORITY.channel_agent_run)
        .toBeLessThan(CHANNEL_TASK_DEFAULT_PRIORITY.channel_presence);
    });

    it('claimNextChannelTask can claim channel_control_action for control role', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', {
        type: 'channel_control_action',
        idempotencyKey: 'ctrl1',
        priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_control_action,
        input: { request: { action_id: 'daemon_evolution_mode_show' } },
      });
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      expect(claim.task?.type).toBe('channel_control_action');
    });

    it('claimNextChannelTask can claim channel_agent_run for agent role', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', {
        type: 'channel_agent_run',
        idempotencyKey: 'agent1',
        priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_agent_run,
        input: {
          request: {
            channel_agent_run_id: 'channel-agent-test-1',
            objective: 'Summarize recent channel events',
            mode: 'observe',
            permission_profile: 'read_only',
          },
        },
      });
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'agent-worker',
        types: taskTypesForChannelRole('agent'),
      });
      expect(claim.task?.type).toBe('channel_agent_run');
    });

    it('uses a separate queue from cycle tasks', () => {
      const root = makeRoot();
      enqueueTask(root, 'alpha', { type: 'run_cycle', idempotencyKey: 'cycle-task' });
      enqueueChannelTask(root, 'alpha', { type: 'channel_presence', idempotencyKey: 'channel-task' });

      expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
      expect(existsSync(channelPendingTasksPath(root, 'alpha'))).toBe(true);
      expect(pendingTasksPath(root, 'alpha')).not.toBe(channelPendingTasksPath(root, 'alpha'));
      expect(readChannelTaskQueue(root, 'alpha').tasks.map((task) => task.type)).toEqual(['channel_presence']);
    });

    it('runChannelTask routes channel_agent_run and delivers result to outbox', async () => {
      const previousProvider = process.env.JEA_AGENT_PROVIDER;
      delete process.env.JEA_AGENT_PROVIDER;
      const root = makeRoot();
      const { task } = enqueueChannelTask(root, 'alpha', {
        type: 'channel_agent_run',
        idempotencyKey: 'agent-route',
        input: {
          request: {
            channel_agent_run_id: 'channel-agent-route',
            candidate_id: 'reply:message:agent-route',
            reply_to_message_id: 'agent-route',
            objective: 'Summarize recent channel events',
            mode: 'observe',
            permission_profile: 'read_only',
          },
          mock_result: {
            success: true,
            status: 'completed',
            provider: 'mock',
            message: 'channel agent completed',
            agent: {
              raw_response: JSON.stringify({
                status: 'completed',
                deliverable: {
                  type: 'document',
                  title: '排名调研结果',
                  content: '# 调研结果\n\nagentank 当前排名稳定。\n\n## 详情\n\n基于最近三轮情报，rank 无显著变化。',
                  summary: '排名稳定，无需动作',
                },
                sources: [{ file: 'data/intelligence/memory/standing_memory.json', what: 'rank 基线' }],
                confidence: 0.7,
              }),
            },
          },
        },
      });
      const result = await runChannelTask(root, 'alpha', task);
      expect(result.ok).toBe(true);
      expect(result.deliverable?.deliverable_id).toMatch(/^delivery-/);
      expect(result.deliverable.type).toBe('document');
      expect(existsSync(result.deliverable.md_path)).toBe(true);
      expect(result.dispatch?.count).toBeGreaterThan(0);

      const events = readChannelEvents(root, 'alpha', { limit: 20 });
      expect(events.some((event) =>
        event.type === 'channel_agent_run_started'
        && event.channel_agent_run_id === 'channel-agent-route'
        && event.provider === 'llm_only')).toBe(true);
      expect(events.some((event) =>
        event.type === 'channel_deliverable_persisted'
        && event.channel_agent_run_id === 'channel-agent-route')).toBe(true);
      expect(events.some((event) =>
        event.type === 'channel_deliverable_dispatched'
        && event.outbox_count >= 1)).toBe(true);
      expect(events.some((event) =>
        event.type === 'channel_agent_run_completed'
        && event.channel_agent_run_id === 'channel-agent-route'
        && event.deliverable_type === 'document'
        && event.delivered === true)).toBe(true);
      expect(listPendingChannelEvents(root, 'alpha', { type: 'expression_recompute_requested' }).length).toBeGreaterThan(0);

      const outbox = listOutboxPending(root, 'alpha').map((file) => readJsonFile(file));
      expect(outbox.some((message) => message.document && message.metadata?.channel_deliverable)).toBe(true);

      // Delivered agent runs are dispatched directly; presence must not re-speak them.
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.expression.candidates.some((candidate) =>
        candidate.kind === 'reply.agent_run')).toBe(false);
      if (previousProvider == null) delete process.env.JEA_AGENT_PROVIDER;
      else process.env.JEA_AGENT_PROVIDER = previousProvider;
    });

    it('runChannelAgentRunTask reports validation failures without executing an agent', async () => {
      const root = makeRoot();
      const result = await runChannelAgentRunTask(root, 'alpha', {
        request: {
          channel_agent_run_id: 'channel-agent-invalid',
          objective: 'Mutate files',
          mode: 'sandbox_patch',
          permission_profile: 'workspace_write',
        },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unsupported_agent_mode');
      expect(readChannelEvents(root, 'alpha', { limit: 5 }).some((event) =>
        event.type === 'channel_agent_run_failed' && event.channel_agent_run_id === 'channel-agent-invalid')).toBe(true);
    });

    it('runChannelAgentRunTask uses subject runtime .env over global agent env', async () => {
      const root = makeRoot();
      const { runtimeRoot } = runtimeForSubject(root, 'alpha');
      writeFileSync(
        join(runtimeRoot, '.env'),
        [
          'JEA_AGENT_PROVIDER=llm_only',
          'JEA_FORCE_MOCK=1',
        ].join('\n'),
        'utf-8',
      );
      const previousProvider = process.env.JEA_AGENT_PROVIDER;
      process.env.JEA_AGENT_PROVIDER = 'cursor_sdk';
      try {
        const result = await runChannelAgentRunTask(root, 'alpha', {
          request: {
            channel_agent_run_id: 'channel-agent-runtime-env',
            objective: 'Summarize recent channel events',
            mode: 'observe',
            permission_profile: 'read_only',
          },
        });
        expect(result.ok).toBe(true);
        expect(result.result.provider).toBe('llm_only');
        const events = readChannelEvents(root, 'alpha', { limit: 10 });
        expect(events.some((event) =>
          event.type === 'channel_agent_run_started'
          && event.channel_agent_run_id === 'channel-agent-runtime-env'
          && event.provider === 'llm_only'
          && event.runtime_env?.exists === true)).toBe(true);
        expect(events.some((event) =>
          event.type === 'channel_agent_run_completed'
          && event.channel_agent_run_id === 'channel-agent-runtime-env'
          && event.provider === 'llm_only'
          && event.status === 'ok')).toBe(true);
      } finally {
        if (previousProvider == null) delete process.env.JEA_AGENT_PROVIDER;
        else process.env.JEA_AGENT_PROVIDER = previousProvider;
      }
    });

    it('persistChannelDeliverable writes raw agent output as Markdown plus index and observation', () => {
      const root = makeRoot();
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir, timezone: 'Asia/Shanghai' });
      const deliverable = persistChannelDeliverable(root, 'alpha', {
        channel_agent_run_id: 'channel-agent-persist',
        reply_to_message_id: 'om_request',
        objective: '调研 agentank 排名',
      }, {
        success: true,
        status: 'completed',
        provider: 'cursor_sdk',
        message: 'short summary',
        agent: { raw_response: '# 调研结果\n\n详细分析正文。', confidence: 0.8 },
      }, { store });

      expect(deliverable.deliverable_id).toMatch(/^delivery-/);
      expect(existsSync(deliverable.md_path)).toBe(true);
      const md = readFileSync(deliverable.md_path, 'utf-8');
      expect(md).toContain('deliverable_id:');
      expect(md).toContain('channel_agent_run_id: "channel-agent-persist"');
      // Body is the agent raw output verbatim, not a template rewrite.
      expect(md).toContain('# 调研结果\n\n详细分析正文。');

      const index = store.readChannelDeliverables({ limit: 5 });
      expect(index.some((record) =>
        record.deliverable_id === deliverable.deliverable_id
        && record.md_path === deliverable.md_path
        && record.status === 'completed'
        && record.provider === 'cursor_sdk')).toBe(true);

      const observations = store.engine.readSource('intel_observations', { limit: 10 });
      expect(observations.some((obs) =>
        obs.kind === 'channel_deliverable'
        && obs.metadata?.deliverable_id === deliverable.deliverable_id)).toBe(true);
    });

    it('persistChannelDeliverable parses a structured deliverable contract from the agent receipt', () => {
      const root = makeRoot();
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir, timezone: 'Asia/Shanghai' });
      const deliverable = persistChannelDeliverable(root, 'alpha', {
        channel_agent_run_id: 'channel-agent-structured',
        objective: '查询当前 rank',
      }, {
        success: true,
        status: 'completed',
        provider: 'cursor_sdk',
        agent: {
          raw_response: JSON.stringify({
            status: 'completed',
            deliverable: {
              type: 'message',
              title: '当前排名',
              content: '当前排名为第 12 位。',
              summary: '排名第 12 位',
            },
            sources: [{ file: 'data/intelligence/memory/standing_memory.json', what: 'rank 基线' }],
            confidence: 0.9,
            follow_up_hint: '如需历史趋势可提交 brief 让下一轮验证',
          }),
        },
      }, { store });

      expect(deliverable.type).toBe('message');
      expect(deliverable.title).toBe('当前排名');
      expect(deliverable.body).toBe('当前排名为第 12 位。');
      expect(deliverable.summary).toBe('排名第 12 位');
      expect(deliverable.confidence).toBe(0.9);
      expect(deliverable.sources).toEqual([{ file: 'data/intelligence/memory/standing_memory.json', what: 'rank 基线' }]);
      expect(deliverable.follow_up_hint).toContain('下一轮验证');
      const md = readFileSync(deliverable.md_path, 'utf-8');
      expect(md).toContain('deliverable_type: "message"');
      expect(md).toContain('当前排名为第 12 位。');

      const index = store.readChannelDeliverables({ limit: 5 });
      expect(index.some((record) =>
        record.deliverable_id === deliverable.deliverable_id
        && record.deliverable_type === 'message'
        && record.title === '当前排名'
        && record.confidence === 0.9)).toBe(true);
    });

    it('persistChannelDeliverable skips the .md file for a none deliverable but still indexes it', () => {
      const root = makeRoot();
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir, timezone: 'Asia/Shanghai' });
      const deliverable = persistChannelDeliverable(root, 'alpha', {
        channel_agent_run_id: 'channel-agent-none',
        objective: '查询不存在的数据',
      }, {
        success: true,
        status: 'no_data',
        provider: 'cursor_sdk',
        agent: {
          raw_response: JSON.stringify({
            status: 'no_data',
            deliverable: {
              type: 'none',
              summary: '未找到相关信息',
            },
          }),
        },
      }, { store });

      expect(deliverable.type).toBe('none');
      expect(deliverable.md_path).toBeNull();

      const index = store.readChannelDeliverables({ limit: 5 });
      expect(index.some((record) =>
        record.deliverable_id === deliverable.deliverable_id
        && record.deliverable_type === 'none'
        && record.delivery_status === 'skipped'
        && record.md_path === null)).toBe(true);

      const observations = store.engine.readSource('intel_observations', { limit: 10 });
      expect(observations.some((obs) =>
        obs.kind === 'channel_deliverable'
        && obs.metadata?.deliverable_id === deliverable.deliverable_id
        && obs.metadata?.deliverable_type === 'none')).toBe(true);
    });

    it('channel deliverables CLI lists records and shows Markdown content', async () => {
      const root = makeRoot();
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir, timezone: 'Asia/Shanghai' });
      const deliverable = persistChannelDeliverable(root, 'alpha', {
        channel_agent_run_id: 'channel-agent-cli',
        objective: 'CLI 检索测试',
      }, {
        success: true,
        status: 'completed',
        provider: 'cursor_sdk',
        agent: { raw_response: '# CLI 交付\n\n完整 Markdown 正文。' },
      }, { store });

      const listed = await captureConsoleLog(() => channelCommand({
        subcommand: 'deliverables',
        args: ['list'],
        flags: {},
        root,
      }));
      expect(listed.result).toBe(0);
      expect(listed.output).toContain(deliverable.deliverable_id);
      expect(listed.output).toContain('CLI 检索测试');

      const shown = await captureConsoleLog(() => channelCommand({
        subcommand: 'deliverables',
        args: ['show', 'channel-agent-cli'],
        flags: {},
        root,
      }));
      expect(shown.result).toBe(0);
      expect(shown.output).toContain('# CLI 交付');
      expect(shown.output).toContain('完整 Markdown 正文。');
    });

    it('resolveDeliverablePath lays deliverables out by date and extractDeliverableTldr summarizes', () => {
      const root = makeRoot();
      const path = resolveDeliverablePath(root, 'alpha', 'delivery-20260604-192200-abcd', {
        createdAt: '2026-06-04T11:22:00.000Z',
      });
      expect(path.replace(/\\/g, '/')).toContain('channel/deliverables/2026/06/2026-06-04/delivery-20260604-192200-abcd.md');
      expect(extractDeliverableTldr('# Title\n\nFirst line.\nSecond line.')).toBe('Title First line. Second line.');
    });

    it('renderDeliveryToOutbox emits a Feishu document delivery for document deliverables', async () => {
      const root = makeRoot();
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-short',
        channel_agent_run_id: 'channel-agent-doc',
        type: 'document',
        title: '调研排名',
        objective: '调研排名',
        status: 'completed',
        provider: 'cursor_sdk',
        body: '排名稳定，无需动作。',
        tldr: '排名稳定',
      }, { reply_to_message_id: 'om_x' });
      expect(rendered.format).toBe('document');
      expect(rendered.messages).toHaveLength(1);
      expect(rendered.messages[0].card).toBeNull();
      expect(rendered.messages[0].document.title).toBe('调研排名');
      expect(rendered.messages[0].document.markdown).toContain('排名稳定，无需动作。');
      expect(rendered.messages[0].metadata.channel_deliverable).toBe(true);
      expect(rendered.messages[0].metadata.deliverable_type).toBe('document');
      expect(rendered.messages[0].metadata.part).toBe('document');
      expect(rendered.target).toBe('oc_test');
    });

    it('renderDeliveryToOutbox sends a plain text message for a short message deliverable', async () => {
      const root = makeRoot();
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-msg',
        channel_agent_run_id: 'channel-agent-msg',
        type: 'message',
        title: '快速回答',
        status: 'completed',
        provider: 'cursor_sdk',
        body: '当前排名为第 12 位，较昨日无变化。',
        summary: '排名第 12 位',
      });
      expect(rendered.format).toBe('text');
      expect(rendered.messages).toHaveLength(1);
      expect(rendered.messages[0].document).toBeNull();
      expect(rendered.messages[0].text).toContain('当前排名为第 12 位');
      expect(rendered.messages[0].metadata.deliverable_type).toBe('message');
      expect(rendered.messages[0].idempotency_key).toBe('channel-deliverable:alpha:channel-agent-msg:text:0');
    });

    it('renderDeliveryToOutbox upgrades a long message deliverable to a document', async () => {
      const root = makeRoot();
      const body = 'A'.repeat(3000);
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-medium',
        type: 'message',
        title: '长报告',
        status: 'completed',
        provider: 'cursor_sdk',
        body,
        tldr: 'long',
      });
      expect(rendered.format).toBe('document');
      expect(rendered.messages).toHaveLength(1);
      expect(rendered.messages[0].document.markdown).toContain(body);
      expect(rendered.messages[0].metadata.delivery_format).toBe('document');
      // Renderer is the authority: a declared message with rich content is
      // upgraded to a document and the override is surfaced for auditing.
      expect(rendered.declared_type).toBe('message');
      expect(rendered.resolved_medium).toBe('document');
      expect(rendered.type_overridden).toBe(true);
    });

    it('renderDeliveryToOutbox sends a link deliverable as a text message with the url', async () => {
      const root = makeRoot();
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-link',
        channel_agent_run_id: 'channel-agent-link',
        type: 'link',
        title: '查看 viewer',
        status: 'completed',
        provider: 'cursor_sdk',
        summary: '已生成在线视图',
        url: 'https://example.com/viewer#cycle-1',
        body: '',
      });
      expect(rendered.format).toBe('text');
      expect(rendered.messages).toHaveLength(1);
      expect(rendered.messages[0].document).toBeNull();
      expect(rendered.messages[0].text).toContain('https://example.com/viewer#cycle-1');
      expect(rendered.messages[0].text).toContain('已生成在线视图');
    });

    it('renderDeliveryToOutbox emits no messages for a none deliverable', async () => {
      const root = makeRoot();
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-none',
        channel_agent_run_id: 'channel-agent-none',
        type: 'none',
        status: 'no_data',
        provider: 'cursor_sdk',
        body: '',
        summary: '',
      });
      expect(rendered.messages).toHaveLength(0);
      expect(rendered.reason).toBe('no_delivery_items');
    });

    it('renderDeliveryToOutbox uses stable channel_agent_run_id for delivery idempotency keys', async () => {
      const root = makeRoot();
      const rendered = await renderDeliveryToOutbox(root, 'alpha', {
        deliverable_id: 'delivery-random-a',
        channel_agent_run_id: 'channel-agent-stable',
        type: 'document',
        title: '长报告',
        status: 'completed',
        provider: 'cursor_sdk',
        body: 'A'.repeat(3000),
        tldr: 'long',
      });
      expect(rendered.messages.map((message) => message.idempotency_key)).toEqual([
        'channel-deliverable:alpha:channel-agent-stable:document:0',
      ]);
      expect(rendered.messages[0].metadata.deliverable_id).toBe('delivery-random-a');
      expect(rendered.messages[0].metadata.channel_agent_run_id).toBe('channel-agent-stable');
    });

    it('resolveDeliveryItems and hasRichFormatting route by type and content', () => {
      expect(hasRichFormatting('short answer')).toBe(false);
      expect(hasRichFormatting('```\ncode\n```')).toBe(true);
      expect(hasRichFormatting('# A\n\n## B\n\ntext')).toBe(true);

      const messageItems = resolveDeliveryItems({ type: 'message', body: 'hi there' });
      expect(messageItems).toHaveLength(1);
      expect(messageItems[0].medium).toBe('text');

      const docItems = resolveDeliveryItems({ type: 'document', body: '# Report', title: 'R' });
      expect(docItems[0].medium).toBe('document');

      const noneItems = resolveDeliveryItems({ type: 'none', summary: '' });
      expect(noneItems).toHaveLength(0);
    });

    it('mergeDeliverableDeliveryStatus overlays sent/failed/partial onto the index', () => {
      const deliverables = [
        { deliverable_id: 'd-sent', delivery_status: 'pending' },
        { deliverable_id: 'd-failed', delivery_status: 'pending' },
        { deliverable_id: 'd-partial', delivery_status: 'pending' },
        { deliverable_id: 'd-untouched', delivery_status: 'pending' },
      ];
      const statuses = [
        { deliverable_id: 'd-sent', item_index: 0, delivery_status: 'sent', delivery_channel: 'feishu', delivery_format: 'document', delivery_message_id: 'om_1', recorded_at: '2026-06-05T00:00:00Z' },
        { deliverable_id: 'd-failed', item_index: 0, delivery_status: 'failed', delivery_format: 'document', error: 'HTTP 400', recorded_at: '2026-06-05T00:00:01Z' },
        { deliverable_id: 'd-partial', item_index: 0, delivery_status: 'sent', delivery_format: 'text', delivery_message_id: 'om_2', recorded_at: '2026-06-05T00:00:02Z' },
        { deliverable_id: 'd-partial', item_index: 1, delivery_status: 'failed', delivery_format: 'document', error: 'boom', recorded_at: '2026-06-05T00:00:03Z' },
      ];
      const merged = mergeDeliverableDeliveryStatus(deliverables, statuses);
      const byId = Object.fromEntries(merged.map((m) => [m.deliverable_id, m]));

      expect(byId['d-sent'].delivery_status).toBe('sent');
      expect(byId['d-sent'].delivery_format).toBe('document');
      expect(byId['d-sent'].delivery_message_id).toBe('om_1');
      expect(byId['d-sent'].delivery_error).toBeNull();

      expect(byId['d-failed'].delivery_status).toBe('failed');
      expect(byId['d-failed'].delivery_error).toBe('HTTP 400');

      expect(byId['d-partial'].delivery_status).toBe('partial');
      expect(byId['d-partial'].delivery_items).toHaveLength(2);

      // No status records -> left unchanged.
      expect(byId['d-untouched'].delivery_status).toBe('pending');
      expect(byId['d-untouched'].delivery_items).toBeUndefined();
    });

    it('mergeDeliverableDeliveryStatus keeps the latest status per item (last write wins)', () => {
      const merged = mergeDeliverableDeliveryStatus(
        [{ deliverable_id: 'd1', delivery_status: 'pending' }],
        [
          { deliverable_id: 'd1', item_index: 0, delivery_status: 'failed', error: 'transient', recorded_at: '2026-06-05T00:00:00Z' },
          { deliverable_id: 'd1', item_index: 0, delivery_status: 'sent', delivery_format: 'document', delivery_message_id: 'om_retry', recorded_at: '2026-06-05T00:01:00Z' },
        ],
      );
      expect(merged[0].delivery_status).toBe('sent');
      expect(merged[0].delivery_message_id).toBe('om_retry');
    });

    it('runChannelNotifyTask records delivery outcome merged into the deliverable index', async () => {
      const root = makeRoot();
      const store = createDeliverableStore(root, 'alpha');
      // Seed a deliverable index record (as persistChannelDeliverable would).
      store.recordChannelDeliverable({
        deliverable_id: 'delivery-notify-1',
        channel_agent_run_id: 'car-notify-1',
        title: 'Notify 验证',
        deliverable_type: 'document',
        status: 'completed',
        delivery_status: 'pending',
      });
      // Queue a deliverable outbox message (mock send so no real Feishu call).
      writeOutboxMessage(root, 'alpha', {
        channel: 'feishu',
        target: 'oc_test',
        text: '交付物已生成',
        document: { title: 'Notify 验证', markdown: '# body', message_text: '交付物已生成' },
        idempotency_key: 'channel-deliverable:alpha:car-notify-1:document:0',
        metadata: {
          channel_deliverable: true,
          deliverable_id: 'delivery-notify-1',
          channel_agent_run_id: 'car-notify-1',
          delivery_format: 'document',
          delivery_item: 'document',
          item_index: 0,
          mock: true,
        },
      });

      const notify = await runChannelNotifyTask(root, 'alpha', { limit: 5 });
      expect(notify.sent).toHaveLength(1);

      const merged = store.readChannelDeliverables({ limit: 10 });
      const record = merged.find((d) => d.deliverable_id === 'delivery-notify-1');
      expect(record.delivery_status).toBe('sent');
      expect(record.delivery_format).toBe('document');
      expect(record.delivery_channel).toBe('feishu');
    });

    it('runChannelNotifyTask can route outbox messages to bridge-intent adapter', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_transport: 'bridge-intent',
        },
        additionalChannels: {
          'bridge-intent': { target: 'jea-alpha' },
        },
      });
      writeOutboxMessage(root, 'alpha', {
        channel: 'bridge-intent',
        target: 'jea-alpha',
        text: 'Alpha 完成了一次表达意图。',
        subject: 'alpha',
        idempotency_key: 'bridge-intent-test-1',
        metadata: { presence: true },
      });

      const notify = await runChannelNotifyTask(root, 'alpha', { limit: 5 });
      expect(notify.sent).toHaveLength(1);
      expect(notify.failed).toHaveLength(0);

      const pendingDir = join(bridgeIntentDir(root, 'alpha'), 'pending');
      const files = readdirSync(pendingDir).filter((name) => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      const intent = JSON.parse(readFileSync(join(pendingDir, files[0]), 'utf-8'));
      expect(intent.type).toBe('channel_outbound_intent');
      expect(intent.subject).toBe('alpha');
      expect(intent.target).toBe('jea-alpha');
      expect(intent.outbound.text).toContain('Alpha 完成');
    });

    it('writeOutboxMessage deduplicates idempotency keys across pending and sent outbox', () => {
      const root = makeRoot();
      const first = writeOutboxMessage(root, 'alpha', {
        channel: 'feishu',
        target: 'oc_test',
        text: 'first',
        idempotency_key: 'outbox-key-1',
      });
      expect(first.created).toBe(true);
      const pendingDuplicate = writeOutboxMessage(root, 'alpha', {
        channel: 'feishu',
        target: 'oc_test',
        text: 'duplicate pending',
        idempotency_key: 'outbox-key-1',
      });
      expect(pendingDuplicate.created).toBe(false);
      expect(pendingDuplicate.duplicate).toBe(true);
      expect(pendingDuplicate.existing_status).toBe('pending');

      markOutboxSent(root, 'alpha', first.file, {
        outbound: first.message,
        send_result: { ok: true },
      });
      const sentDuplicate = writeOutboxMessage(root, 'alpha', {
        channel: 'feishu',
        target: 'oc_test',
        text: 'duplicate sent',
        idempotency_key: 'outbox-key-1',
      });
      expect(sentDuplicate.created).toBe(false);
      expect(sentDuplicate.duplicate).toBe(true);
      expect(sentDuplicate.existing_status).toBe('sent');
      expect(listOutboxPending(root, 'alpha')).toHaveLength(0);
    });

    it('FeishuSender creates a document and sends its link for deliverables', async () => {
      const calls = [];
      const sender = new FeishuSender({
        async createDocumentFromMarkdown(payload) {
          calls.push(['createDocumentFromMarkdown', payload]);
          return {
            success: true,
            documentId: 'docx_test',
            title: payload.title,
            url: 'https://example.feishu.cn/docx/docx_test',
          };
        },
        async sendText(payload) {
          calls.push(['sendText', payload]);
          return { success: true, messageId: 'om_doc_link' };
        },
      }, { docFolderToken: 'fld_test' });

      const result = await sender.sendDocumentDelivery('oc_test', {
        title: '测试交付',
        markdown: '# 正文',
      });

      expect(result.document.documentId).toBe('docx_test');
      expect(calls[0][0]).toBe('createDocumentFromMarkdown');
      expect(calls[0][1].folderToken).toBe('fld_test');
      expect(calls[1][0]).toBe('sendText');
      expect(calls[1][1].text).toContain('https://example.feishu.cn/docx/docx_test');
    });

    it('planDocumentInsertions keeps nested table blocks as descendants (no orphan 400)', () => {
      // Simulates docx convert output for markdown containing a table: a
      // first-level table container plus its nested row/cell/text children.
      const converted = {
        first_level_block_ids: ['h1', 'tbl'],
        blocks: [
          { block_id: 'page', parent_id: null, block_type: 1, children: ['h1', 'tbl'] },
          { block_id: 'h1', parent_id: 'page', block_type: 3, heading1: {} },
          {
            block_id: 'tbl',
            parent_id: 'page',
            block_type: 31,
            table: { property: { column_size: 2, row_size: 1, column_width: [365, 365], merge_info: [{ col_span: 1, row_span: 1 }] } },
            children: ['cell1', 'cell2'],
          },
          { block_id: 'cell1', parent_id: 'tbl', block_type: 32, table_cell: {}, children: ['t1'] },
          { block_id: 'cell2', parent_id: 'tbl', block_type: 32, table_cell: {}, children: ['t2'] },
          { block_id: 't1', parent_id: 'cell1', block_type: 2, text: {} },
          { block_id: 't2', parent_id: 'cell2', block_type: 2, text: {} },
        ],
      };

      const batches = planDocumentInsertions(converted);
      expect(batches).toHaveLength(1);
      const [batch] = batches;
      expect(batch.children_id).toEqual(['h1', 'tbl']);
      expect(batch.index).toBe(0);

      const ids = batch.descendants.map((b) => b.block_id);
      // The whole table subtree must be present so the container is not orphaned.
      expect(ids).toEqual(expect.arrayContaining(['h1', 'tbl', 'cell1', 'cell2', 't1', 't2']));
      // The page/root block must NOT be inserted.
      expect(ids).not.toContain('page');
      // parent_id is stripped, but block_id + children wiring is preserved.
      expect(batch.descendants.every((b) => !('parent_id' in b))).toBe(true);
      const table = batch.descendants.find((b) => b.block_id === 'tbl');
      expect(table.children).toEqual(['cell1', 'cell2']);
      // Read-only table props must be stripped or Feishu rejects with 1770001.
      expect(table.table.property).toEqual({ column_size: 2, row_size: 1 });
      expect(table.table.property).not.toHaveProperty('column_width');
      expect(table.table.property).not.toHaveProperty('merge_info');
    });

    it('planDocumentInsertions chunks first-level blocks and keeps order', () => {
      const ids = Array.from({ length: 5 }, (_, i) => `b${i}`);
      const converted = {
        first_level_block_ids: ids,
        blocks: ids.map((id) => ({ block_id: id, parent_id: 'page', block_type: 2, text: {} })),
      };
      const batches = planDocumentInsertions(converted, { batchSize: 2 });
      expect(batches.map((b) => b.children_id)).toEqual([['b0', 'b1'], ['b2', 'b3'], ['b4']]);
      expect(batches.map((b) => b.index)).toEqual([0, 2, 4]);
    });

    it('planDocumentInsertions returns empty for unusable convert output', () => {
      expect(planDocumentInsertions({})).toEqual([]);
      expect(planDocumentInsertions({ blocks: [], first_level_block_ids: [] })).toEqual([]);
      expect(planDocumentInsertions({ blocks: [{ block_id: 'x', block_type: 2 }] })).toEqual([]);
    });

    it('purges pending deprecated tasks from queue', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', { type: 'channel_ingest', idempotencyKey: 'purge-ingest' });
      enqueueChannelTask(root, 'alpha', { type: 'channel_watch', idempotencyKey: 'purge-watch' });
      const result = cancelDeprecatedChannelTasks(root, 'alpha');
      expect(result.cancelled.length).toBe(2);
      const queue = readChannelTaskQueue(root, 'alpha');
      expect(queue.tasks.filter((t) => t.status === 'pending' && t.type === 'channel_ingest')).toHaveLength(0);
    });

    it('rejects deprecated channel_reply, channel_watch, and channel_ingest tasks', async () => {
      const root = makeRoot();
      for (const type of ['channel_reply', 'channel_ingest']) {
        const { task } = enqueueChannelTask(root, 'alpha', {
          type,
          idempotencyKey: `deprecated-${type}`,
        });
        await expect(runChannelTask(root, 'alpha', task)).rejects.toThrow(/Deprecated channel task type/);
      }
    });

    it('reports multi-role channel worker state without aggregate zombie false positive', () => {
      const root = makeRoot();
      initChannelCoordinatorState(root, 'alpha', {
        pid: process.pid,
        roles: ['notify', 'presence'],
        tickMs: 300_000,
        staleMs: 60_000,
      });
      createChannelRoleWorkerState(root, 'alpha', {
        role: 'notify',
        workerId: 'notify-worker',
        pid: process.pid,
        staleMs: 60_000,
      });
      createChannelRoleWorkerState(root, 'alpha', {
        role: 'presence',
        workerId: 'presence-worker',
        pid: process.pid,
        staleMs: 60_000,
      });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.workers.running_count).toBe(2);
      expect(projection.health.ok).toBe(true);
      expect(projection.health.reasons.join('\n')).not.toMatch(/zombie/i);
    });

    it('clears aggregate stop marker when coordinator starts again', () => {
      const root = makeRoot();
      initChannelCoordinatorState(root, 'alpha', {
        pid: process.pid,
        roles: ['presence'],
        tickMs: 300_000,
      });
      createChannelRoleWorkerState(root, 'alpha', {
        role: 'presence',
        workerId: 'presence-worker',
        pid: process.pid,
      });
      requestChannelWorkerStop(root, 'alpha');
      expect(readChannelWorkerState(root, 'alpha').stop_requested_at).toBeTruthy();
      initChannelCoordinatorState(root, 'alpha', {
        pid: process.pid,
        roles: ['presence'],
        tickMs: 300_000,
      });
      createChannelRoleWorkerState(root, 'alpha', {
        role: 'presence',
        workerId: 'presence-worker-2',
        pid: process.pid,
        allowedTaskTypes: ['channel_presence'],
      });
      const state = readChannelWorkerState(root, 'alpha');
      expect(state.stop_requested_at).toBeNull();
      expect(state.workers.presence.stop_requested_at).toBeNull();
      expect(state.workers.presence.status).toBe('running');
    });
  });

  describe('inbound classifier', () => {
    it('turns approval messages into operator briefs via channel_classifier', async () => {
      const root = makeRoot();
      writePendingInbound(root, 'alpha', {
        messageId: 'm-approval-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        chatType: 'group',
        content: '同意发布这个候选',
        contentType: 'text',
      });

      const result = await runChannelClassifierTask(root, 'alpha');
      expect(result.classified).toBe(1);
      const runtime = runtimeForSubject(root, 'alpha');
      const briefs = readPendingOperatorBriefs(runtime.runtimeRoot, { limit: 5 }).briefs;
      expect(briefs).toHaveLength(1);
      expect(briefs[0].kind).toBe('approval_request');
    });

    it('deduplicates inbound message ids', async () => {
      const root = makeRoot();
      const payload = {
        messageId: 'm-dupe-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '请下一轮核实 A',
      };
      writePendingInbound(root, 'alpha', payload);
      await runChannelClassifierTask(root, 'alpha');
      writePendingInbound(root, 'alpha', payload);

      const result = await runChannelClassifierTask(root, 'alpha');
      expect(result.mechanical).toBe(1);
      expect(result.classified).toBe(0);
    });

    it('respects batch_size and leaves overflow for next batch', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
      });
      for (let i = 0; i < 7; i += 1) {
        writePendingInbound(root, 'alpha', {
          messageId: `m-batch-${i}`,
          chatId: 'oc_test',
          content: `消息 ${i}`,
        });
      }
      const first = await runChannelClassifierTask(root, 'alpha');
      expect(first.classified).toBe(5);
      const second = await runChannelClassifierTask(root, 'alpha');
      expect(second.classified).toBe(2);
    });

    it('downgrades LLM ignore for ordinary direct text to observation by default', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'm-ignore-direct-text-downgrade',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        chatType: 'p2p',
        content: '我刚看到一条消息',
        contentType: 'text',
      });
      const result = await runChannelClassifierTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            items: [{
              message_id: 'm-ignore-direct-text-downgrade',
              classification: 'ignore',
              confidence: 'high',
              summary: 'Ordinary direct text.',
              rationale: 'not an operator action',
            }],
          }),
        },
      });
      expect(result.classified).toBe(1);
      expect(result.processed[0].ingest_result.kind).toBe('observation');
      expect(result.processed[0].ingest_result.record.content).toBe('我刚看到一条消息');
      expect(result.processed[0].ingest_result.record.metadata.downgrade_reason)
        .toBe('ignore_default_observation');
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.new_messages.map((m) => m.message_id)).toContain('m-ignore-direct-text-downgrade');
      expect(ctx.expression.candidates.map((candidate) => candidate.id))
        .toContain('reply:message:m-ignore-direct-text-downgrade');
    });

    it('keeps explicit LLM ignore as context-only for non-conversation noise', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'm-ignore-noise',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        chatType: 'p2p',
        content: 'noop',
        contentType: 'text',
      });
      const result = await runChannelClassifierTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            items: [{
              message_id: 'm-ignore-noise',
              classification: 'ignore',
              confidence: 'high',
              summary: 'noop',
              rationale: 'test noise',
            }],
          }),
        },
      });
      expect(result.classified).toBe(1);
      expect(result.processed[0].ingest_result.kind).toBe('ignore');
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.ignored_messages.map((m) => m.message_id)).toContain('m-ignore-noise');
      expect(ctx.expression.candidates.map((candidate) => candidate.id)).not.toContain('reply:message:m-ignore-noise');
    });
  });

  describe('attention signals', () => {
    it('collects cycle completion and long-idle proactive signals', () => {
      const root = makeRoot();
      const now = new Date('2026-06-02T01:00:00.000Z');
      const signals = collectAttentionSignals(root, 'alpha', {
        projection: {
          generated_at: now.toISOString(),
          evolution_mode: 'on_demand',
          health: { status: 'idle', ok: true, reasons: [] },
          tasks: {},
          cycles: {
            drift_steps: [],
            last_closed_cycle_id: 'cycle-done-1',
            last_closed_at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
            pending_cycle_start_request: null,
          },
        },
      });
      expect(signals.some((signal) => signal.type === 'cycle_completed')).toBe(true);
      expect(signals.some((signal) => signal.type === 'long_idle')).toBe(true);
    });

    it('plans proactive send for task_failed via presence', () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.attention_signals = [{
        type: 'task_failed',
        severity: 'medium',
        title: 'Task failed: intel',
        summary: 'boom',
        key: 'task_failed:task-1',
        presence_signal_key: 'task_failed:task-1',
        presence_handled: false,
      }];
      ctx.expression.candidates = buildExpressionCandidates(ctx);
      const plan = planPresenceDeterministic(ctx);
      expect(plan.kind).toBe('speak');
      expect(plan.intents.some((a) => a.type === 'speech_intent' && a.reason === 'proactive_signal')).toBe(true);
    });
  });

  describe('projection and identity', () => {
    it('projects channel health and flags deprecated queue tasks', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', { type: 'channel_watch', idempotencyKey: 'channel-health' });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.tasks.deprecated).toHaveLength(1);
      expect(projection.tasks.deprecated[0].type).toBe('channel_watch');
      expect(projection.health.ok).toBe(false);
    });

    it('exposes presence config without feishu reply block', () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', max_actions_per_tick: 3 },
      });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.presence.config).toMatchObject({
        enabled: true,
        planner: 'llm',
        max_actions_per_tick: 3,
      });
      expect(projection.feishu.reply).toBeUndefined();
    });

    it('loads subject persona for channel prompts', () => {
      const root = makeRoot();
      const identity = resolveSubjectReplyIdentity(root, 'alpha');
      expect(identity.subject).toBe('alpha');
      expect(identity.subject_description).toContain('测试主体');
      expect(identity.persona).toContain('小测');
    });
  });

  describe('presence loop', () => {
    function readPresenceIntel(root) {
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({
        baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
        timezone: 'Asia/Shanghai',
      });
      return store.readRecentIntel({ days: 7, limit: 50 }).filter(isPresenceInteractionRecord);
    }

    it('builds presence context without requiring feishu-only modules', () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_presence_only',
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.subject).toBe('alpha');
      expect(ctx.identity.persona).toContain('小测');
      expect(ctx.presence.enabled).toBe(true);
      expect(ctx.channel.new_messages).toEqual([]);
      expect(ctx.channel.background_messages).toEqual([]);
      expect(ctx.channel.ignored_messages).toEqual([]);
      expect(ctx.affordances.operator_commands.length).toBeGreaterThan(0);
      expect(ctx.channel.recent_presence_interactions).toEqual([]);
    });

    it('exposes grounded affordances with evolution-mode CLI', () => {
      const root = makeRoot({ presence: { enabled: true } });
      const affordances = resolvePresenceAffordances(root, 'alpha');
      const cmd = affordances.operator_commands.find((c) => c.id === 'daemon_evolution_mode_continuous');
      expect(cmd.cmd).toContain('daemon evolution-mode set continuous');
      expect(cmd.cmd).toContain('--subject alpha');
    });

    it('runChannelTick wakes presence reactor via event queue', () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
      });
      const tick = runChannelTick(root, 'alpha');
      expect(tick.enqueued.some((item) => item.reactor_created || item.reactor_task?.type === 'channel_presence')).toBe(true);
      expect(listPendingChannelEvents(root, 'alpha', { type: 'expression_recompute_requested' }).length).toBeGreaterThan(0);
      const queue = readChannelTaskQueue(root, 'alpha');
      expect(queue.tasks.filter((t) => t.type === 'channel_presence').length).toBeLessThanOrEqual(1);
      expect(queue.tasks.some((t) => t.idempotency_key === PRESENCE_REACTOR_IDEMPOTENCY('alpha'))).toBe(true);
    });

    it('multiple wakes merge into one reactor task', () => {
      const root = makeRoot({ presence: { enabled: true } });
      requestExpressionRecompute(root, 'alpha', { reason: 'a', payload_summary: { event_ref: 'm1' } });
      requestExpressionRecompute(root, 'alpha', { reason: 'b', payload_summary: { event_ref: 'm2' } });
      const queue = readChannelTaskQueue(root, 'alpha');
      const presenceTasks = queue.tasks.filter((t) => t.type === 'channel_presence');
      expect(presenceTasks.length).toBe(1);
      expect(listPendingChannelEvents(root, 'alpha').length).toBeGreaterThanOrEqual(2);
    });

    it('raw inbound events are not claimed directly by presence', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      appendChannelEvent(root, 'alpha', {
        type: 'feishu_message_received',
        reason: 'legacy_raw_inbound',
        event_ref: 'om_raw',
      });
      appendChannelEvent(root, 'alpha', {
        type: 'manual_inbox_added',
        reason: 'legacy_manual_inbound',
        event_ref: 'om_manual',
      });

      const result = await runPresenceReactor(root, 'alpha');
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no_pending_events');
      expect(listPendingChannelEvents(root, 'alpha', { type: 'feishu_message_received' })).toHaveLength(1);
      expect(listPendingChannelEvents(root, 'alpha', { type: 'manual_inbox_added' })).toHaveLength(1);
    });

    it('channel_inbound task queues classifier instead of presence', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      const file = join(tempDir, 'manual-inbound.json');
      writeFileSync(file, JSON.stringify({
        messageId: 'om_inbound_routes_classifier',
        chatId: 'oc_operator',
        content: '同意发布',
        contentType: 'text',
      }), 'utf-8');

      const result = await runChannelInboundTask(root, 'alpha', { files: [file], label: 'test' });
      expect(result.queued).toBe(1);
      expect(result.classifier_created).toBe(true);
      const queue = readChannelTaskQueue(root, 'alpha');
      expect(queue.tasks.some((t) => t.type === 'channel_classifier')).toBe(true);
      expect(queue.tasks.some((t) => t.type === 'channel_presence')).toBe(false);
    });

    it('decision phase queues speech_intent without writing outbox', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_decision_only',
        chatId: 'oc_operator',
        content: '同意发布',
        contentType: 'text',
      });
      const { executePresenceDecisionPlan } = await import('../src/channel/presence-decision-executor.mjs');
      const { buildPresenceContext } = await import('../src/channel/presence-context.mjs');
      const { planPresenceDeterministic } = await import('../src/channel/presence-planner.mjs');
      await runChannelClassifierTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      await executePresenceDecisionPlan(root, 'alpha', plan, { presenceConfig: ctx.presence, context: ctx });
      expect(listOutboxPending(root, 'alpha', { limit: 5 }).length).toBe(0);
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBeGreaterThan(0);
    });

    it('acks approval via presence loop and writes outbox', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_operator',
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_presence_approval',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '同意发布候选',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      const result = await runChannelPresenceTask(root, 'alpha');
      expect(result.plan.kind).toBe('speak');
      expect(result.execution.applied).toBeGreaterThan(0);
      expect(listOutboxPending(root, 'alpha', { limit: 5 }).length).toBeGreaterThan(0);
      expect(Object.keys(readPresenceState(root, 'alpha').handled_candidates ?? {})
        .some((id) => id.includes('om_presence_approval'))).toBe(true);
      const intel = readPresenceIntel(root);
      expect(intel.some((r) => r.source === 'channel_presence' && r.interaction_kind === 'send_message')).toBe(true);
    });

    it('does not reply again to handled inbound messages', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_operator',
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_presence_dedup',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '同意发布',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      const first = await runChannelPresenceTask(root, 'alpha');
      expect(first.plan.kind).toBe('speak');
      const outboxAfterFirst = listOutboxPending(root, 'alpha', { limit: 10 }).length;
      expect(outboxAfterFirst).toBeGreaterThan(0);
      const second = await runChannelPresenceTask(root, 'alpha');
      expect(second.plan.kind).toBe('no_op');
      expect(second.plan.reason).toBe('no_expression_candidates');
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(outboxAfterFirst);
    });

    it('records silence when there is nothing to express', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      const execution = await executePresenceDecisionPlan(root, 'alpha', plan, { context: ctx });
      expect(plan.kind).toBe('no_op');
      expect(execution.skipped).toBe(0);
    });

    it('buildPresenceContext exposes cycle_memory and channel_memory with legacy fields', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.schema_version).toBe(3);
      expect(ctx.cycle_memory).toBeDefined();
      expect(ctx.channel_memory).toBeDefined();
      expect(ctx.cycle_memory).toHaveProperty('operator_briefs');
      expect(ctx.cycle_memory).toHaveProperty('intel_summary');
      expect(ctx.cycle_memory.recent_channel_presence).toHaveProperty('recent_said');
      expect(ctx.channel_memory).toHaveProperty('new_messages');
      expect(ctx.channel_memory.cooldowns).toBeDefined();
      expect(ctx.operator_briefs).toEqual(ctx.cycle_memory.operator_briefs);
      expect(ctx.intel_summary).toBe(ctx.cycle_memory.intel_summary);
      expect(ctx.channel.recent_presence_interactions)
        .toEqual(ctx.cycle_memory.recent_channel_presence.all);
    });

    it('speech intent payload carries reason_summary and tone_hint', () => {
      const intent = speechIntentFromDeterministic({
        subject: 'alpha',
        candidate_id: 'reply:message:om_test',
        target: 'channel_default',
        reason: 'operator_brief_fast_ack',
        kind: 'approval_ack',
        summary: '同意发布',
      });
      const payload = buildSpeechGenerationEventPayload(intent, { planReason: 'fast_ack' });
      expect(payload.reason_summary).toBeTruthy();
      expect(payload.tone_hint).toBeTruthy();
      expect(payload.source_refs).toContain('expression:reply:message:om_test');
      expect(payload.memory_effect).toBe('record_said');
    });

    it('classifyChannelEnvelope maps follow-up phrases to verification_request', () => {
      const decision = classifyChannelEnvelope({
        message_id: 'om_followup',
        chat_id: 'oc_test',
        content: '发布后告诉我 rank 变化',
      });
      expect(decision.kind).toBe('operator_brief');
      expect(decision.brief.kind).toBe('verification_request');
      expect(decision.brief.metadata?.follow_up).toBe(true);
    });

    it('send_message presence observation uses structured why and summary', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_struct_obs',
        chatId: 'oc_operator',
        content: '同意发布',
      });
      await runChannelClassifierTask(root, 'alpha');
      await runChannelPresenceTask(root, 'alpha');
      await runChannelSpeechGenerationTask(root, 'alpha');
      const intel = readPresenceIntel(root);
      const sent = intel.find((r) => r.interaction_kind === 'send_message');
      expect(sent).toBeDefined();
      expect(sent.content).toMatch(/interaction=send_message/);
      expect(sent.content).toMatch(/content_summary=/);
      expect(sent.content).toMatch(/why=/);
    });

    it('decision phase speech_generation_requested payload includes deliberation fields', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_payload_fields',
        chatId: 'oc_operator',
        content: '同意发布',
      });
      await runChannelClassifierTask(root, 'alpha');
      const { executePresenceDecisionPlan } = await import('../src/channel/presence-decision-executor.mjs');
      const { planPresenceDeterministic } = await import('../src/channel/presence-planner.mjs');
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      await executePresenceDecisionPlan(root, 'alpha', plan, { presenceConfig: ctx.presence, context: ctx });
      const events = listPendingChannelEvents(root, 'alpha', { type: 'speech_generation_requested' });
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].payload.reason_summary).toBeTruthy();
      expect(events[0].payload.tone_hint).toBeTruthy();
    });

    it('recent_presence_interactions come from unified intelligence', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_operator',
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_intel_memory',
        chatId: 'oc_operator',
        content: '同意发布',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      await runChannelPresenceTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.recent_presence_interactions.length).toBeGreaterThan(0);
      expect(Object.keys(readPresenceState(root, 'alpha').handled_candidates ?? {})
        .some((id) => id.includes('om_intel_memory'))).toBe(true);
    });

    it('builds expression candidates for plain observations', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_plain_observation',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '聊聊你自己',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.new_messages.map((m) => m.message_id)).toContain('om_plain_observation');
      expect(ctx.expression.candidates).toContainEqual(expect.objectContaining({
        id: 'reply:message:om_plain_observation',
        kind: 'reply.message',
        recommended_intent: 'custom',
        summary: '聊聊你自己',
      }));
    });

    it('llm planner can reply to plain observations', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.channel.new_messages = [{
        message_id: 'om_llm_obs',
        channel: 'test',
        content: '说说你自己',
        ingest_kind: 'observation',
        presence_handled: false,
      }];
      ctx.channel.background_messages = [];
      ctx.expression.candidates = [{
        id: 'reply:message:om_llm_obs',
        kind: 'reply.message',
        source: 'observation',
        priority: 'low',
        target: 'channel_default',
        reply_to_message_id: 'om_llm_obs',
        recommended_intent: 'custom',
        summary: '说说你自己',
      }];
      ctx.presence = resolvePresenceConfig(root, 'alpha');
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            kind: 'speak',
            reason: 'intro',
            candidate_ids: ['reply:message:om_llm_obs'],
            intents: [{
              candidate_id: 'reply:message:om_llm_obs',
              target: 'channel_default',
              content_requirements: { kind: 'custom', text_hint: '我是小测，alpha 的外部接口。' },
              reason: 'casual_intro',
              reply_to_message_id: 'om_llm_obs',
            }],
          }),
        },
      });
      expect(plan.kind).toBe('speak');
      expect(plan.intents[0].content_requirements?.text_hint).toContain('小测');
    });

    it('llm planner can write operator brief actions for follow-ups', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
          fast_ack_operator_brief: false,
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.expression.candidates = [{
        id: 'reply:message:om_followup_llm',
        kind: 'reply.message',
        source: 'observation',
        priority: 'medium',
        target: 'channel_default',
        reply_to_message_id: 'om_followup_llm',
        recommended_intent: 'custom',
        summary: '跑完后帮我看 rank',
      }];
      ctx.presence = resolvePresenceConfig(root, 'alpha');
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            kind: 'act',
            reason: 'followup_needs_cycle',
            candidate_ids: ['reply:message:om_followup_llm'],
            actions: [{
              type: 'write_operator_brief',
              kind: 'verification_request',
              summary: '跑完后帮我看 rank',
              priority: 'medium',
            }],
          }),
        },
      });
      expect(plan.kind).toBe('act');
      expect(plan.actions[0].type).toBe('write_operator_brief');
      await executePresenceDecisionPlan(root, 'alpha', plan, { context: ctx });
      const runtime = runtimeForSubject(root, 'alpha');
      const pending = readPendingOperatorBriefs(runtime.runtimeRoot, { limit: 10 });
      expect(pending.briefs.some((brief) => brief.summary === '跑完后帮我看 rank')).toBe(true);
      const request = readPendingCycleStartRequest(root, 'alpha');
      expect(request?.reasons).toContain('channel_presence_operator_brief');
    });

    it('llm planner can request async agent and keep acknowledgement speech', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.expression.candidates = [{
        id: 'reply:message:om_agent_llm',
        kind: 'reply.message',
        source: 'observation',
        priority: 'medium',
        target: 'channel_default',
        reply_to_message_id: 'om_agent_llm',
        recommended_intent: 'custom',
        summary: '帮我异步查一下最近失败原因',
      }];
      ctx.presence = resolvePresenceConfig(root, 'alpha');
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            kind: 'act',
            reason: 'needs_async_agent',
            candidate_ids: ['reply:message:om_agent_llm'],
            actions: [{
              type: 'start_agent_async',
              candidate_id: 'reply:message:om_agent_llm',
              reply_to_message_id: 'om_agent_llm',
              objective: 'Investigate the latest channel/cycle failure signals and summarize likely causes.',
              mode: 'observe',
              permission_profile: 'read_only',
            }, {
              type: 'speech_intent',
              candidate_id: 'reply:message:om_agent_llm',
              target: 'channel_default',
              reason: 'agent_started_ack',
              reply_to_message_id: 'om_agent_llm',
              content_requirements: {
                kind: 'custom',
                text_hint: '告知用户已启动异步 agent，完成后会通知。',
              },
            }],
          }),
        },
      });
      expect(plan.actions.map((action) => action.type)).toContain('start_agent_async');
      expect(plan.actions.map((action) => action.type)).toContain('speech_intent');
      expect(plan.actions.find((action) => action.type === 'start_agent_async')?.permission_profile).toBe('read_only');
    });

    it('llm planner preserves agent run result evidence for reply.agent_run candidates', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.expression.candidates = [{
        id: 'reply:agent_run:channel-agent-result',
        kind: 'reply.agent_run',
        source: 'channel_agent_run',
        priority: 'medium',
        target: 'operator',
        recommended_intent: 'custom',
        summary: 'Agent completed report',
        agent_result: {
          ok: true,
          channel_agent_run_id: 'channel-agent-result',
          provider: 'cursor_sdk',
          status: 'completed',
          summary: 'Agent completed report',
          deferred: false,
        },
        source_ref: 'channel:agent_run:channel-agent-result',
      }];
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            kind: 'speak',
            reason: 'report_agent_result',
            candidate_ids: ['reply:agent_run:channel-agent-result'],
            intents: [{
              candidate_id: 'reply:agent_run:channel-agent-result',
              target: 'channel_default',
              reason: 'custom_agent_result',
              content_requirements: {
                kind: 'custom',
                summary: '调研完成，向操作者交付结果。',
              },
            }],
          }),
        },
      });
      expect(plan.actions[0].content_requirements.kind).toBe('agent_run_result');
      expect(plan.actions[0].content_requirements.summary.agent_result.channel_agent_run_id)
        .toBe('channel-agent-result');
      expect(plan.actions[0].source_refs).toContain('channel:agent_run:channel-agent-result');
    });

    it('presence executor queues async agent and acknowledgement speech without touching cycle queue', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      const plan = {
        kind: 'act',
        reason: 'manual_agent_test',
        candidate_ids: ['reply:message:om_agent_exec'],
        planner: 'test',
        actions: [{
          type: 'start_agent_async',
          candidate_id: 'reply:message:om_agent_exec',
          reply_to_message_id: 'om_agent_exec',
          target: 'channel_default',
          objective: 'Read recent channel state and summarize next diagnostic step.',
          mode: 'observe',
          permission_profile: 'read_only',
          boundary: { write_allowed: false },
          reason: 'needs_async_agent',
        }],
      };
      const ctx = buildPresenceContext(root, 'alpha');
      const execution = await executePresenceDecisionPlan(root, 'alpha', plan, { context: ctx });
      expect(execution.results.some((result) => result.action?.type === 'start_agent_async' && result.queued)).toBe(true);
      expect(readChannelTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'channel_agent_run')).toBe(true);
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBeGreaterThan(0);
      expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(false);
    });

    it('presence speech rate limit does not block async agent action', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_operator',
          max_messages_per_hour: 1,
        },
      });
      recordChannelEvent(root, 'alpha', {
        type: 'channel_speech_generated',
        status: 'ok',
        intent_id: 'recent-speech',
      });
      const plan = {
        kind: 'act',
        reason: 'rate_limited_agent_test',
        candidate_ids: ['reply:message:om_agent_rate_limited'],
        planner: 'test',
        actions: [{
          type: 'start_agent_async',
          candidate_id: 'reply:message:om_agent_rate_limited',
          target: 'channel_default',
          objective: 'Read recent channel state.',
          mode: 'observe',
          permission_profile: 'read_only',
          reason: 'needs_async_agent',
        }, {
          type: 'speech_intent',
          candidate_id: 'reply:message:om_agent_rate_limited',
          target: 'channel_default',
          reason: 'agent_started_ack',
          content_requirements: {
            kind: 'custom',
            text_hint: '已启动异步 agent。',
          },
        }],
      };
      const execution = await executePresenceDecisionPlan(root, 'alpha', plan, { context: buildPresenceContext(root, 'alpha') });
      expect(execution.results.some((result) => result.action?.type === 'start_agent_async' && result.queued)).toBe(true);
      expect(execution.results.some((result) => result.action?.type === 'speech_intent' && result.skipped && result.reason === 'rate_limited'))
        .toBe(true);
      expect(readChannelTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'channel_agent_run')).toBe(true);
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBe(0);
    });

    it('presence executor binds agent started speech to a real queued agent task', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      const plan = {
        kind: 'act',
        reason: 'llm_agent_ack_test',
        candidate_ids: ['reply:message:om_agent_bound'],
        planner: 'test',
        actions: [{
          type: 'speech_intent',
          candidate_id: 'reply:message:om_agent_bound',
          target: 'channel_default',
          reason: 'agent_started_ack',
          reply_to_message_id: 'om_agent_bound',
          content_requirements: {
            kind: 'custom',
            text_hint: '已启动异步调研任务，完成后通知。',
          },
        }, {
          type: 'start_agent_async',
          candidate_id: 'reply:message:om_agent_bound',
          reply_to_message_id: 'om_agent_bound',
          target: 'channel_default',
          objective: 'Read recent evolution history and summarize it.',
          mode: 'observe',
          permission_profile: 'read_only',
          reason: 'needs_async_agent',
        }],
      };
      await executePresenceDecisionPlan(root, 'alpha', plan, { context: buildPresenceContext(root, 'alpha') });
      const events = listPendingChannelEvents(root, 'alpha', { type: 'speech_generation_requested' });
      const payload = events[0]?.payload;
      expect(payload?.content_requirements?.kind).toBe('agent_started_ack');
      expect(payload?.content_requirements?.summary?.channel_agent_run_id).toMatch(/^channel-agent-run-/);
      expect(payload?.source_refs).toContain(`channel_agent_run:${payload.content_requirements.summary.channel_agent_run_id}`);
    });

    it('presence executor downgrades agent start claims without queued agent evidence', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      const plan = {
        kind: 'speak',
        reason: 'llm_false_agent_ack_test',
        candidate_ids: ['reply:message:om_agent_false'],
        planner: 'test',
        actions: [{
          type: 'speech_intent',
          candidate_id: 'reply:message:om_agent_false',
          target: 'channel_default',
          reason: 'agent_started_ack',
          reply_to_message_id: 'om_agent_false',
          content_requirements: {
            kind: 'custom',
            text_hint: '已重新启动异步调研任务，但 cursor_sdk deferred。',
          },
        }],
      };
      await executePresenceDecisionPlan(root, 'alpha', plan, { context: buildPresenceContext(root, 'alpha') });
      expect(readChannelTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'channel_agent_run')).toBe(false);
      const events = listPendingChannelEvents(root, 'alpha', { type: 'speech_generation_requested' });
      expect(events[0]?.payload?.content_requirements?.kind).toBe('agent_not_started_ack');
    });

    it('presence executor keeps audited agent result speech without same-plan start action', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      const plan = {
        kind: 'speak',
        reason: 'agent_result_ack',
        candidate_ids: ['reply:agent:completed'],
        planner: 'test',
        actions: [{
          type: 'speech_intent',
          candidate_id: 'reply:agent:completed',
          target: 'channel_default',
          reason: 'agent_run_result',
          content_requirements: {
            kind: 'agent_run_result',
            summary: {
              agent_result: {
                ok: false,
                deferred: true,
                provider: 'cursor_sdk',
                channel_agent_run_id: 'channel-agent-completed',
                reason: 'provider_deferred',
              },
            },
          },
        }],
      };
      await executePresenceDecisionPlan(root, 'alpha', plan, { context: buildPresenceContext(root, 'alpha') });
      const events = listPendingChannelEvents(root, 'alpha', { type: 'speech_generation_requested' });
      expect(events[0]?.payload?.content_requirements?.kind).toBe('agent_run_result');
      expect(events[0]?.payload?.content_requirements?.summary?.agent_result?.channel_agent_run_id)
        .toBe('channel-agent-completed');
    });

    it('presence executor rejects high-risk async agent parameters', async () => {
      const root = makeRoot();
      const plan = {
        kind: 'act',
        reason: 'reject_high_risk_agent',
        candidate_ids: ['reply:message:om_agent_reject'],
        planner: 'test',
        actions: [{
          type: 'start_agent_async',
          candidate_id: 'reply:message:om_agent_reject',
          objective: 'Publish the release',
          mode: 'sandbox_patch',
          permission_profile: 'workspace_write',
          approval_granted: true,
        }],
      };
      const execution = await executePresenceDecisionPlan(root, 'alpha', plan, { context: buildPresenceContext(root, 'alpha') });
      expect(execution.results[0].skipped).toBe(true);
      expect(readChannelTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'channel_agent_run')).toBe(false);
    });

    it('llm planner can silence plain observations and mark them handled', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
          fast_ack_operator_brief: false,
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_llm_silence_obs',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '嗯',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            items: [{
              message_id: 'om_llm_silence_obs',
              classification: 'observation',
              confidence: 'medium',
              summary: '嗯',
              rationale: 'short acknowledgement',
            }],
          }),
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            kind: 'silence',
            reason: 'short_ack_needs_no_reply',
            candidate_ids: ['reply:message:om_llm_silence_obs'],
            intents: [],
          }),
        },
      });
      expect(plan.kind).toBe('silence');
      await executePresenceDecisionPlan(root, 'alpha', plan, { context: ctx });
      const handled = readPresenceState(root, 'alpha').handled_candidates ?? {};
      expect(handled['reply:message:om_llm_silence_obs']?.outcome).toBe('silenced');
      const nextCtx = buildPresenceContext(root, 'alpha');
      expect(nextCtx.expression.candidates.some((c) => c.id === 'reply:message:om_llm_silence_obs')).toBe(false);
    });

    it('skips expression when presence.enabled is false', async () => {
      const root = makeRoot({ presence: { enabled: false } });
      const result = await runChannelPresenceTask(root, 'alpha', { skip_speech_generation: true });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('presence_disabled');
    });
  });

  describe('presence config', () => {
    it('decision_timeout_ms is at least llm timeout', () => {
      const root = makeRoot({ presence: { planner: 'llm', llm: { timeout: 25 } } });
      const cfg = resolvePresenceConfig(root, 'alpha');
      expect(cfg.decision_timeout_ms).toBeGreaterThanOrEqual(25_000);
      expect(cfg.decision_timeout_ms).toBeGreaterThanOrEqual(cfg.llm.timeout * 1000);
      expect(cfg.timeout_ms).toBeGreaterThanOrEqual(cfg.decision_timeout_ms);
    });

    it('raises default decision timeout above legacy 15s floor', () => {
      const root = makeRoot({ presence: { planner: 'llm' } });
      const cfg = resolvePresenceConfig(root, 'alpha');
      expect(cfg.decision_timeout_ms).toBeGreaterThanOrEqual(30_000);
    });
  });

  describe('ignore presence boundary', () => {
    function llmClassifierClient(itemsByMessageId) {
      return {
        chatMessages: () => Promise.resolve(JSON.stringify({ items: Object.values(itemsByMessageId) })),
      };
    }

    it('places classifier ignore in ignored_messages not new_messages', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctx_ignore',
        chatId: 'oc_test',
        content: 'noop',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: llmClassifierClient([{
          message_id: 'om_ctx_ignore',
          classification: 'ignore',
          confidence: 'medium',
          summary: 'noop',
          rationale: 'test',
        }]),
      });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.recent_ingested.some((m) => m.message_id === 'om_ctx_ignore')).toBe(true);
      expect(ctx.channel.ignored_messages.map((m) => m.message_id)).toContain('om_ctx_ignore');
      expect(ctx.channel.new_messages).toEqual([]);
    });

    it('ignore-only does not queue speech or mark ignore handled on silence', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ignore_silence',
        chatId: 'oc_test',
        content: '随便噪音',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: llmClassifierClient([{
          message_id: 'om_ignore_silence',
          classification: 'ignore',
          confidence: 'medium',
          summary: '随便噪音',
          rationale: 'test',
        }]),
      });
      appendChannelEvent(root, 'alpha', { type: 'expression_recompute_requested', reason: 'test' });
      const result = await runPresenceReactor(root, 'alpha', { force: true });
      expect(result.plan.kind).toBe('no_op');
      expect(result.plan.reason).toBe('no_expression_candidates');
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBe(0);
      expect(Object.keys(readPresenceState(root, 'alpha').handled_candidates ?? {})
        .some((id) => id.includes('om_ignore_silence'))).toBe(false);
      const runtime = runtimeForSubject(root, 'alpha');
      const store = createIntelligenceStore({
        baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
        timezone: 'Asia/Shanghai',
      });
      const intel = store.readRecentIntel({ days: 7, limit: 50 }).filter(isPresenceInteractionRecord);
      expect(intel.some((r) => r.interaction_kind === 'silence')).toBe(false);
    });

    it('still wakes presence when batch is ignore-only', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ignore_wake',
        chatId: 'oc_test',
        content: 'noop',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: llmClassifierClient([{
          message_id: 'om_ignore_wake',
          classification: 'ignore',
          confidence: 'medium',
          summary: 'noop',
          rationale: 'test',
        }]),
      });
      const queue = readChannelTaskQueue(root, 'alpha');
      expect(queue.tasks.some((t) => t.type === 'channel_presence')).toBe(true);
      expect(listPendingChannelEvents(root, 'alpha', { type: 'expression_recompute_requested' }).length).toBeGreaterThan(0);
    });

    it('ignore does not block proactive signal reply', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.channel.new_messages = [];
      ctx.channel.ignored_messages = [{
        message_id: 'om_ignore_bg',
        ingest_kind: 'ignore',
        content: '回句话',
        presence_eligible: false,
        presence_handled: false,
      }];
      ctx.attention_signals = [{
        type: 'task_failed',
        severity: 'medium',
        title: 'Task failed: intel',
        summary: 'boom',
        key: 'task_failed:task-1',
        presence_signal_key: 'task_failed:task-1',
        presence_handled: false,
      }];
      ctx.expression.candidates = buildExpressionCandidates(ctx);
      const plan = planPresenceDeterministic(ctx);
      expect(plan.kind).toBe('speak');
      expect(plan.intents.some((a) => a.reason === 'proactive_signal')).toBe(true);
      expect(plan.candidate_ids.some((id) => id.includes('om_ignore_bg'))).toBe(false);
    });

    it('fast ack targets brief only when ignore and brief share a batch', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'llm', interval_ms: 30_000, batch_size: 5 },
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ignore_mix',
        chatId: 'oc_operator',
        content: 'noop',
        contentType: 'text',
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_brief_mix',
        chatId: 'oc_operator',
        content: '同意发布',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: llmClassifierClient([
          {
            message_id: 'om_ignore_mix',
            classification: 'ignore',
            confidence: 'medium',
            summary: 'noop',
            rationale: 'test',
          },
          {
            message_id: 'om_brief_mix',
            classification: 'approval_request',
            confidence: 'high',
            summary: '同意发布',
            rationale: 'test',
          },
        ]),
      });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.ignored_messages.map((m) => m.message_id)).toContain('om_ignore_mix');
      expect(ctx.channel.new_messages.map((m) => m.message_id)).toContain('om_brief_mix');
      const plan = await planPresence(ctx);
      expect(plan.planner).toBe('deterministic_fast_ack');
      expect(plan.candidate_ids).toEqual(['reply:approval_request:om_brief_mix']);
      expect(plan.candidate_ids.some((id) => id.includes('om_ignore_mix'))).toBe(false);
    });

    it('strips LLM actions that reply_to ignored message ids', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'llm' } });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.channel.new_messages = [];
      ctx.channel.ignored_messages = [{
        message_id: 'om_llm_ignore',
        ingest_kind: 'ignore',
        content: '回句话',
        presence_eligible: false,
        presence_handled: false,
      }];
      ctx.attention_signals = [{
        type: 'task_failed',
        severity: 'medium',
        title: 'Task failed',
        summary: 'boom',
        key: 'task_failed:t1',
        presence_signal_key: 'task_failed:t1',
        presence_handled: false,
      }];
      ctx.expression.candidates = buildExpressionCandidates(ctx);
      const client = {
        chatMessages: () => Promise.resolve(JSON.stringify({
          kind: 'speak',
          reason: 'bad',
          candidate_ids: ['reply:ignore:om_llm_ignore'],
          intents: [{
            candidate_id: 'reply:ignore:om_llm_ignore',
            target: 'operator',
            content_requirements: { kind: 'custom', text_hint: 'reply to ignore' },
            reply_to_message_id: 'om_llm_ignore',
            reason: 'should_drop',
          }],
        })),
      };
      const plan = await planPresenceWithLlm(ctx, { aiClient: client });
      expect(plan.candidate_ids.every((id) => !id.includes('om_llm_ignore'))).toBe(true);
    });
  });

  describe('async reactor', () => {
    it('presence reactor does not drain inbound (classifier owns ingest)', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_no_drain',
        chatId: 'oc_test',
        content: '同意发布',
      });
      const result = await runPresenceReactor(root, 'alpha', { force: true, allow_empty_claim: true });
      expect(result.skipped).toBeFalsy();
      const pending = (await import('../src/channel/state.mjs')).listAllPendingInbound(root, 'alpha');
      expect(pending.length).toBe(1);
    });

    it('presence reactor claims inbound_classified wake after classifier completes', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_classified_wake',
        chatId: 'oc_operator',
        content: '同意发布候选',
      });
      await runChannelClassifierTask(root, 'alpha');
      expect(listPendingChannelEvents(root, 'alpha', { type: 'expression_recompute_requested' })).toHaveLength(1);
      const result = await runPresenceReactor(root, 'alpha');
      expect(result.claimed_events).toBe(1);
      expect(result.plan.kind).toBe('speak');
    });

    it('presence reactor does not claim speech generation events', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-boundary',
          target: 'channel_default',
          reason: 'boundary',
          content_requirements: { kind: 'greeting_ack' },
        },
      });
      appendChannelEvent(root, 'alpha', {
        type: 'expression_recompute_requested',
        payload_summary: { tick_id: 'boundary-tick' },
      });

      const result = await runPresenceReactor(root, 'alpha');
      expect(result.claimed_events).toBe(1);
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBe(1);

      const gen = await runChannelSpeechGenerationTask(root, 'alpha');
      expect(gen.generated).toBeGreaterThan(0);
    });

    it('llm planner fast-acks operator_brief without calling slow LLM', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_fast_ack',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '同意发布',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      let llmCalled = false;
      const slowClient = {
        chatMessages: () => {
          llmCalled = true;
          return new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({
            stance: 'speak',
            reason: 'late',
            actions: [],
          })), 500));
        },
      };
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = await planPresence(ctx, { aiClient: slowClient });
      expect(llmCalled).toBe(false);
      expect(plan.planner).toBe('deterministic_fast_ack');
      expect(plan.kind).toBe('speak');
      expect(plan.intents.some((a) => a.content_requirements?.kind === 'approval_ack')).toBe(true);
    });

    it('planPresenceOperatorBriefFastAck returns null for ignore-only inbound', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'llm' } });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.channel.new_messages = [];
      ctx.channel.ignored_messages = [{
        message_id: 'om_ignore_only',
        ingest_kind: 'ignore',
        brief_kind: null,
        content: '回句话',
        presence_handled: false,
        presence_eligible: false,
      }];
      expect(planPresenceOperatorBriefFastAck(ctx)).toBeNull();
    });

    it('decision timeout applies deterministic fallback ack for operator_brief', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
          llm: { timeout: 0.001 },
          decision_timeout_ms: 1,
          fast_ack_operator_brief: false,
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_timeout_fallback_ack',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '同意发布',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      appendChannelEvent(root, 'alpha', {
        type: 'expression_recompute_requested',
        reason: 'test',
        event_ref: 'om_timeout_fallback_ack',
      });

      const slowClient = {
        chatMessages: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({
          stance: 'speak',
          reason: 'late',
          actions: [{
            type: 'speech_intent',
            target: 'channel_default',
            content_requirements: { kind: 'custom', text_hint: 'late reply' },
            reason: 'late_ack',
            reply_to_message_id: 'om_timeout_fallback_ack',
          }],
        })), 200)),
      };

      const result = await runPresenceReactor(root, 'alpha', { aiClient: slowClient, force: true });
      expect(result.timeout).toBe(true);
      expect(result.fallback_applied).toBe(true);
      expect(result.plan.planner).toBe('deterministic_fallback');
      expect(result.plan.kind).toBe('speak');
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(listOutboxPending(root, 'alpha', { limit: 5 }).length).toBe(0);
    });

    it('decision timeout on observation does not apply late LLM speech side effects', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          default_target: 'oc_operator',
          llm: { timeout: 0.001 },
          decision_timeout_ms: 1,
          fast_ack_operator_brief: false,
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_timeout_no_apply',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '随便记录一下当前没有明确指令',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      appendChannelEvent(root, 'alpha', {
        type: 'expression_recompute_requested',
        reason: 'test',
        event_ref: 'om_timeout_no_apply',
      });

      const slowClient = {
        chatMessages: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({
          stance: 'speak',
          reason: 'late',
          actions: [{
            type: 'speech_intent',
            target: 'channel_default',
            content_requirements: { kind: 'custom', text_hint: 'late' },
            reason: 'late_ack',
            reply_to_message_id: 'om_timeout_no_apply',
          }],
        })), 200)),
      };

      const result = await runPresenceReactor(root, 'alpha', { aiClient: slowClient, force: true });
      expect(result.timeout).toBe(true);
      expect(result.fallback_applied).toBe(true);
      expect(result.plan.kind).toBe('silence');
      expect(result.plan.candidate_ids).toContain('reply:message:om_timeout_no_apply');
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBe(0);
      expect(readPresenceState(root, 'alpha').handled_candidates?.['reply:message:om_timeout_no_apply']?.outcome)
        .toBe('silenced');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(listOutboxPending(root, 'alpha', { limit: 5 })).toHaveLength(0);
    });

    it('speech generation writes outbox after decision', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-test-1',
          target: 'channel_default',
          reason: 'test_ack',
          content_requirements: { kind: 'greeting_ack' },
          idempotency_key: 'presence:test:greeting',
        },
      });
      const gen = await runChannelSpeechGenerationTask(root, 'alpha');
      expect(gen.generated).toBeGreaterThan(0);
      expect(listOutboxPending(root, 'alpha', { limit: 5 }).length).toBeGreaterThan(0);
    });

    it('speech generation rejects unevidenced agent deferred claims in custom text', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-agent-false-deferred',
          target: 'channel_default',
          reason: 'custom_reply',
          content_requirements: { kind: 'custom', summary: '普通回复' },
          idempotency_key: 'presence:test:false-deferred',
        },
      });
      const gen = await runChannelSpeechGenerationTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            text: '已重新启动异步调研任务，但 agent provider cursor_sdk 再次 deferred。',
          }),
        },
      });
      expect(gen.generated).toBeGreaterThan(0);
      const pending = listOutboxPending(root, 'alpha', { limit: 5 });
      expect(readJsonFile(pending[0])?.text).toBe('alpha: 已收到并记录。');
    });

    it('speech generation allows evidenced deferred provider result', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-agent-evidenced-deferred',
          target: 'channel_default',
          reason: 'agent_run_result',
          content_requirements: {
            kind: 'agent_run_result',
            summary: {
              agent_result: {
                ok: false,
                deferred: true,
                provider: 'cursor_sdk',
                channel_agent_run_id: 'channel-agent-deferred',
                reason: 'provider_deferred',
              },
            },
          },
          idempotency_key: 'presence:test:evidenced-deferred',
        },
      });
      const gen = await runChannelSpeechGenerationTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            text: 'agent provider cursor_sdk deferred，任务未完成。',
          }),
        },
      });
      expect(gen.generated).toBeGreaterThan(0);
      const pending = listOutboxPending(root, 'alpha', { limit: 5 });
      expect(readJsonFile(pending[0])?.text).toContain('cursor_sdk deferred');
    });

    it('speech generation rejects unevidenced agent completion claims in custom text', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', default_target: 'oc_operator' },
      });
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-agent-false-complete',
          target: 'channel_default',
          reason: 'custom_reply',
          content_requirements: { kind: 'custom', summary: '普通回复' },
          idempotency_key: 'presence:test:false-complete',
        },
      });
      const gen = await runChannelSpeechGenerationTask(root, 'alpha', {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            text: '调研完了，任务完成。',
          }),
        },
      });
      expect(gen.generated).toBeGreaterThan(0);
      const pending = listOutboxPending(root, 'alpha', { limit: 5 });
      expect(readJsonFile(pending[0])?.text).toBe('alpha: 已收到并记录。');
    });

    it('clears pending_speech_generation when speech generation fails', async () => {
      const root = makeRoot({
        feishu: { default_chat_id: null, mock: true },
        presence: { enabled: true, planner: 'deterministic' },
      });
      const event = appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-missing-target',
          target: 'operator',
          reason: 'approval_request_ack',
          content_requirements: { kind: 'approval_ack', summary: 'test' },
        },
      });
      trackPendingSpeechGeneration(root, 'alpha', {
        intent_id: 'intent-missing-target',
        event_id: event.id,
        requested_at: event.created_at,
      });

      const gen = await runChannelSpeechGenerationTask(root, 'alpha');
      expect(gen.failed).toBeGreaterThan(0);
      expect(readPresenceState(root, 'alpha').pending_speech_generation).toHaveLength(0);
    });

    it('reconcilePendingSpeechGeneration drops entries for failed speech events', () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'deterministic' } });
      const event = appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: { intent_id: 'intent-stale', target: 'channel_default', reason: 'stale' },
      });
      trackPendingSpeechGeneration(root, 'alpha', {
        intent_id: 'intent-stale',
        event_id: event.id,
        requested_at: event.created_at,
      });
      markChannelEventsFailed(root, 'alpha', [event.id], { error: 'empty_or_guarded_text' });

      const { changed, state } = reconcilePendingSpeechGeneration(root, 'alpha');
      expect(changed).toBe(true);
      expect(state.pending_speech_generation).toHaveLength(0);

      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.presence.pending_speech_generation).toHaveLength(0);
    });

    it('speech generation timeout does not block notify', async () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'llm', speech_generation_timeout_ms: 1 } });
      const { writeOutboxMessage } = await import('../src/channel/state.mjs');
      const { normalizeOutboundMessage } = await import('../src/channel/types.mjs');
      writeOutboxMessage(root, 'alpha', normalizeOutboundMessage({
        channel: 'feishu',
        target: 'oc_test',
        text: 'already queued',
        subject: 'alpha',
      }));
      appendChannelEvent(root, 'alpha', {
        type: 'speech_generation_requested',
        payload: {
          intent_id: 'intent-slow',
          target: 'channel_default',
          reason: 'slow',
          content_requirements: { kind: 'custom', text_hint: 'x' },
        },
      });
      const slowClient = {
        chatMessages: () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ text: 'late' })), 500)),
      };
      await expect(runChannelSpeechGenerationTask(root, 'alpha', { aiClient: slowClient })).resolves.toBeDefined();
      const notify = await runChannelNotifyTask(root, 'alpha', { limit: 5 });
      expect(notify.sent.length).toBeGreaterThan(0);
    });
  });

  describe('control_request', () => {
    it('parseControlRequestFromText recognizes evolution mode and cycle commands', () => {
      expect(parseControlRequestFromText('切换为按需进化')?.action_id).toBe('daemon_evolution_mode_set');
      expect(parseControlRequestFromText('切换为按需进化')?.params?.mode).toBe('on_demand');
      expect(parseControlRequestFromText('切换为 continuous 模式')?.params?.mode).toBe('continuous');
      expect(parseControlRequestFromText('启动一轮进化')?.action_id).toBe('daemon_cycle_request');
      expect(parseControlRequestFromText('当前进化模式是什么')?.action_id).toBe('daemon_evolution_mode_show');
    });

    it('classifyChannelEnvelope maps explicit control phrases to control_request', () => {
      const decision = classifyChannelEnvelope({
        message_id: 'om_ctrl',
        chat_id: 'oc_test',
        content: '切换为按需进化',
      });
      expect(decision.kind).toBe('control_request');
      expect(decision.request.action_id).toBe('daemon_evolution_mode_set');
    });

    it('classifier enqueues channel_control_action instead of changing mode directly', async () => {
      const root = makeRoot();
      writeOperatorBinding(root, 'alpha', 'ou_operator');
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_enqueue',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      expect(resolveEvolutionMode(root, { subject: 'alpha' }).mode).toBe('continuous');
      const queue = readChannelTaskQueue(root, 'alpha');
      expect(queue.tasks.some((task) => task.type === 'channel_control_action')).toBe(true);
    });

    it('classifier enqueues multiple control actions from one batch', async () => {
      const root = makeRoot();
      writeOperatorBinding(root, 'alpha', 'ou_operator');
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_batch_1',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_batch_2',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '当前进化模式是什么',
      });

      await runChannelClassifierTask(root, 'alpha');

      const queue = readChannelTaskQueue(root, 'alpha');
      const controlTasks = queue.tasks.filter((task) =>
        task.type === 'channel_control_action' && task.status === 'pending');
      expect(controlTasks).toHaveLength(2);
      expect(new Set(controlTasks.map((task) => task.idempotency_key)).size).toBe(2);
    });

    it('executor records failed audit for unknown control action', async () => {
      const root = makeRoot({
        classifier: {
          enabled: true,
          mode: 'llm',
          interval_ms: 30_000,
          batch_size: 5,
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_unknown',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '执行一个不存在的控制动作',
      });
      const aiClient = {
        chatMessages: () => JSON.stringify({
          items: [{
            message_id: 'om_ctrl_unknown',
            classification: 'control_request',
            confidence: 'high',
            summary: '执行一个不存在的控制动作',
            action_id: 'unknown_action',
            params: {},
          }],
        }),
      };

      await runChannelClassifierTask(root, 'alpha', { aiClient });
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unknown_action');
      expect(readChannelEvents(root, 'alpha', { limit: 10 }).some((event) =>
        event.type === 'channel_control_action_failed' && event.reason === 'unknown_action')).toBe(true);
    });

    it('executor records failed audit for low confidence control action', async () => {
      const root = makeRoot({
        classifier: {
          enabled: true,
          mode: 'llm',
          interval_ms: 30_000,
          batch_size: 5,
        },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_low_conf',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '可能切换为按需进化',
      });
      const aiClient = {
        chatMessages: () => JSON.stringify({
          items: [{
            message_id: 'om_ctrl_low_conf',
            classification: 'control_request',
            confidence: 'medium',
            summary: '可能切换为按需进化',
            action_id: 'daemon_evolution_mode_set',
            params: { mode: 'on_demand' },
          }],
        }),
      };

      await runChannelClassifierTask(root, 'alpha', { aiClient });
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('low_confidence');
      expect(resolveEvolutionMode(root, { subject: 'alpha' }).mode).toBe('continuous');
    });

    it('control executor applies evolution mode for bound operator', async () => {
      const root = makeRoot();
      writeOperatorBinding(root, 'alpha', 'ou_operator');
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_exec',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);
      expect(result.ok).toBe(true);
      expect(resolveEvolutionMode(root, { subject: 'alpha' }).mode).toBe('on_demand');
    });

    it('control executor rejects write actions without operator binding', async () => {
      const root = makeRoot();
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_unbound',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('operator_not_bound');
      expect(resolveEvolutionMode(root, { subject: 'alpha' }).mode).toBe('continuous');
    });

    it('control executor authorizes write actions via allow_from without binding', async () => {
      const root = makeRoot({ feishu: { allow_from: ['ou_operator'] } });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_allowlist',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);

      expect(result.ok).toBe(true);
      expect(resolveEvolutionMode(root, { subject: 'alpha' }).mode).toBe('on_demand');
    });

    it('control executor queues cycle start request', async () => {
      const root = makeRoot();
      writeOperatorBinding(root, 'alpha', 'ou_operator');
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_cycle',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '启动一轮进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      const result = await runChannelTask(root, 'alpha', claim.task);
      expect(result.ok).toBe(true);
      expect(readPendingCycleStartRequest(root, 'alpha')).toBeTruthy();
    });

    it('presence replies after control action completes', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', default_target: 'oc_operator' },
      });
      writeOperatorBinding(root, 'alpha', 'ou_operator');
      writePendingInbound(root, 'alpha', {
        messageId: 'om_ctrl_ack',
        chatId: 'oc_operator',
        senderId: 'ou_operator',
        content: '切换为按需进化',
      });
      await runChannelClassifierTask(root, 'alpha');
      const claim = claimNextChannelTask(root, 'alpha', {
        workerId: 'control-worker',
        types: taskTypesForChannelRole('control'),
      });
      await runChannelTask(root, 'alpha', claim.task);
      const reactor = await runPresenceReactor(root, 'alpha', { force: true, allow_empty_claim: true });
      expect(reactor.plan.kind).toBe('speak');
      expect(reactor.plan.intents.some((intent) =>
        intent.content_requirements?.kind === 'control_action_ack')).toBe(true);
    });
  });

  describe('classifier understanding', () => {
    it('inferDeterministicUnderstanding detects immediate investigation phrases', () => {
      const u = inferDeterministicUnderstanding(
        { content: '帮我查一下最近几轮演化日志有没有报错' },
        'observation',
      );
      expect(u.needs_immediate_action).toBe(true);
      expect(u.temporal).toBe('now');
      expect(u.action_hint).toBeTruthy();
    });

    it('inferDeterministicUnderstanding does not trigger on vague opinion phrasing', () => {
      const opinion = inferDeterministicUnderstanding(
        { content: '你怎么看这个方向，我看现在先不用动' },
        'observation',
      );
      expect(opinion.needs_immediate_action).toBe(false);
      expect(opinion.action_hint).toBeNull();
    });

    it('normalizeUnderstanding preserves LLM fields', () => {
      const u = normalizeUnderstanding({
        user_intent: '查 rank',
        needs_immediate_action: true,
        action_hint: 'Read verify report and rank',
        temporal: 'now',
        complexity: 'low',
      });
      expect(u.needs_immediate_action).toBe(true);
      expect(u.action_hint).toContain('rank');
    });

    it('normalizeUnderstanding does not override explicit LLM no-action judgment', () => {
      const u = normalizeUnderstanding({
        user_intent: '讨论方向，不需要立刻行动',
        needs_immediate_action: false,
        temporal: 'ongoing',
        complexity: 'medium',
      }, {
        envelope: { content: '你怎么看这个方向，我看现在先不用动' },
        classification: 'observation',
      });
      expect(u.needs_immediate_action).toBe(false);
      expect(u.temporal).toBe('ongoing');
    });

    it('deterministic agent eligibility is limited to reply candidates', () => {
      const understanding = {
        user_intent: '查状态',
        needs_immediate_action: true,
        temporal: 'now',
        complexity: 'low',
        action_hint: 'Check status',
      };
      expect(candidateEligibleForDeterministicAgent({
        kind: 'reply.message',
        summary: '帮我查状态',
        understanding,
      })).toBe(true);
      expect(candidateEligibleForDeterministicAgent({
        kind: 'notify.task_failed',
        summary: '任务失败',
        understanding,
      })).toBe(false);
    });

    it('passthrough understanding from classifier to expression candidates', async () => {
      const root = makeRoot({
        classifier: { enabled: true, mode: 'deterministic', batch_size: 5 },
        presence: { enabled: true, planner: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_understanding_passthrough',
        chatId: 'oc_operator',
        content: '帮我查一下最近日志有没有报错',
      });
      await runChannelClassifierTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      const ingested = ctx.channel.new_messages.find((m) => m.message_id === 'om_understanding_passthrough');
      expect(ingested?.understanding?.needs_immediate_action).toBe(true);
      const candidate = ctx.expression.candidates.find((c) => c.id === 'reply:message:om_understanding_passthrough');
      expect(candidate?.understanding?.needs_immediate_action).toBe(true);
    });

    it('operator brief fast ack bypasses when needs_immediate_action', () => {
      const root = makeRoot({ presence: { enabled: true, planner: 'llm' } });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.expression.candidates = [{
        id: 'reply:approval_request:om_compound',
        kind: 'reply.approval_request',
        summary: '同意发布，但先帮我查一下 rank',
        recommended_intent: 'approval_ack',
        understanding: {
          user_intent: '先查 rank 再审批',
          needs_immediate_action: true,
          temporal: 'now',
          complexity: 'low',
          action_hint: 'Check rank before approval',
        },
      }];
      expect(planPresenceOperatorBriefFastAck(ctx)).toBeNull();
      expect(candidateNeedsImmediateAction(ctx.expression.candidates[0])).toBe(true);
    });

    it('operator brief fast ack applies when no immediate action', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm' },
        classifier: { enabled: true, mode: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_fast_ack_only',
        chatId: 'oc_operator',
        content: '同意发布',
      });
      await runChannelClassifierTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceOperatorBriefFastAck(ctx);
      expect(plan).not.toBeNull();
      expect(plan.planner).toBe('deterministic_fast_ack');
      const candidate = ctx.expression.candidates.find((c) => c.id === 'reply:approval_request:om_fast_ack_only');
      expect(candidate?.understanding?.needs_immediate_action).not.toBe(true);
    });

    it('deterministic planner starts agent from understanding on observation', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
        classifier: { enabled: true, mode: 'deterministic' },
      });
      writePendingInbound(root, 'alpha', {
        messageId: 'om_det_agent',
        chatId: 'oc_operator',
        content: '帮我分析一下最近 verify 报告',
      });
      await runChannelClassifierTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      expect(plan.kind).toBe('act');
      expect(plan.actions.some((a) => a.type === 'start_agent_async')).toBe(true);
      expect(plan.actions.some((a) => a.type === 'speech_intent')).toBe(true);
      const execution = await executePresenceDecisionPlan(root, 'alpha', plan, { context: ctx });
      expect(execution.results.some((r) => r.queued || r.applied)).toBeTruthy();
    });

    it('decisionFromClassifierItem attaches understanding to brief metadata', () => {
      const envelope = {
        message_id: 'om_meta',
        channel: 'feishu',
        chat_id: 'oc_operator',
        content: '帮我查 rank',
      };
      const decision = decisionFromClassifierItem({
        classification: 'verification_request',
        summary: '查 rank',
        understanding: {
          user_intent: '查 rank',
          needs_immediate_action: true,
          action_hint: 'Check rank',
          temporal: 'now',
          complexity: 'low',
        },
      }, envelope);
      expect(decision.brief.metadata.understanding.needs_immediate_action).toBe(true);
    });
  });

  describe('notify', () => {
    it('sends pending outbox via notify task', async () => {
      const root = makeRoot();
      const { writeOutboxMessage } = await import('../src/channel/state.mjs');
      const { normalizeOutboundMessage } = await import('../src/channel/types.mjs');
      writeOutboxMessage(root, 'alpha', normalizeOutboundMessage({
        channel: 'feishu',
        target: 'oc_test',
        text: 'notify test',
        subject: 'alpha',
      }));
      const result = await runChannelNotifyTask(root, 'alpha', { limit: 5 });
      expect(result.sent.length + result.failed.length).toBeGreaterThan(0);
      expect(result.sent.length).toBeGreaterThan(0);
    });
  });
});
