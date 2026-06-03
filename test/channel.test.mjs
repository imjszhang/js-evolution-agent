import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { enqueueTask, pendingTasksPath } from '../src/cli/utils/daemon-tasks.mjs';
import { enqueueChannelTask, readChannelTaskQueue, channelPendingTasksPath } from '../src/channel/task-queue.mjs';
import {
  writePendingInbound,
  listOutboxPending,
  cooldownActive,
  readPresenceState,
} from '../src/channel/state.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { isPresenceInteractionRecord } from '../src/channel/presence-memory.mjs';
import { resolvePresenceAffordances } from '../src/channel/presence-affordances.mjs';
import { readChannelEvents } from '../src/channel/audit.mjs';
import { drainChannelInbound, runChannelInboundTask, runChannelTask, runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { runChannelAgentRunTask } from '../src/channel/agent-runner.mjs';
import { runChannelClassifierTask } from '../src/channel/classifier.mjs';
import { claimNextChannelTask } from '../src/channel/task-queue.mjs';
import { resolveChannelWorkerTaskTypes, taskTypesForChannelRole, DEFAULT_CHANNEL_ROLES } from '../src/channel/channel-roles.mjs';
import { collectAttentionSignals } from '../src/channel/notify.mjs';
import { readPendingOperatorBriefs } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { runChannelTick } from '../src/channel/dispatch.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import {
  requestExpressionRecompute,
  PRESENCE_REACTOR_IDEMPOTENCY,
} from '../src/channel/wake.mjs';
import { cancelDeprecatedChannelTasks } from '../src/channel/queue-cleanup.mjs';
import { appendChannelEvent, listPendingChannelEvents, summarizeChannelEventQueue } from '../src/channel/event-queue.mjs';
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
import { classifyChannelEnvelope } from '../src/channel/ingest.mjs';
import { buildSpeechGenerationEventPayload, speechIntentFromDeterministic } from '../src/channel/speech-intent.mjs';
import { resolveEvolutionMode } from '../src/cli/utils/evolution-mode.mjs';
import { readPendingCycleStartRequest } from '../src/cli/utils/cycle-start-requests.mjs';
import {
  createChannelRoleWorkerState,
  initChannelCoordinatorState,
  readChannelWorkerState,
  requestChannelWorkerStop,
} from '../src/channel/worker-state.mjs';

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

    it('runChannelTask routes channel_agent_run and wakes presence after completion', async () => {
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
          },
        },
      });
      const result = await runChannelTask(root, 'alpha', task);
      expect(result.ok).toBe(true);
      expect(readChannelEvents(root, 'alpha', { limit: 5 }).some((event) =>
        event.type === 'channel_agent_run_completed' && event.channel_agent_run_id === 'channel-agent-route')).toBe(true);
      expect(listPendingChannelEvents(root, 'alpha', { type: 'expression_recompute_requested' }).length).toBeGreaterThan(0);
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.expression.candidates.some((candidate) =>
        candidate.kind === 'reply.agent_run' && candidate.agent_result?.channel_agent_run_id === 'channel-agent-route')).toBe(true);
      const plan = planPresenceDeterministic(ctx);
      expect(plan.actions[0].content_requirements?.kind).toBe('agent_run_result');
      expect(plan.actions[0].content_requirements?.summary?.agent_result?.summary).toBe('channel agent completed');
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
