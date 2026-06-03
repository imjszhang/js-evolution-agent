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
import { drainChannelInbound, runChannelInboundTask, runChannelTask, runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { runChannelClassifierTask } from '../src/channel/classifier.mjs';
import { claimNextChannelTask } from '../src/channel/task-queue.mjs';
import { resolveChannelWorkerTaskTypes, taskTypesForChannelRole } from '../src/channel/channel-roles.mjs';
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
import {
  createChannelRoleWorkerState,
  initChannelCoordinatorState,
  readChannelWorkerState,
  requestChannelWorkerStop,
} from '../src/channel/worker-state.mjs';

let tempDir = null;

function makeRoot({
  channelTarget = 'oc_test',
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
    feishu: { default_chat_id: channelTarget, mock: true },
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

    it('uses a separate queue from cycle tasks', () => {
      const root = makeRoot();
      enqueueTask(root, 'alpha', { type: 'run_cycle', idempotencyKey: 'cycle-task' });
      enqueueChannelTask(root, 'alpha', { type: 'channel_presence', idempotencyKey: 'channel-task' });

      expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
      expect(existsSync(channelPendingTasksPath(root, 'alpha'))).toBe(true);
      expect(pendingTasksPath(root, 'alpha')).not.toBe(channelPendingTasksPath(root, 'alpha'));
      expect(readChannelTaskQueue(root, 'alpha').tasks.map((task) => task.type)).toEqual(['channel_presence']);
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
        content: '你好',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha');
      await runChannelPresenceTask(root, 'alpha');
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.recent_presence_interactions.length).toBeGreaterThan(0);
      expect(Object.keys(readPresenceState(root, 'alpha').handled_candidates ?? {})
        .some((id) => id.includes('om_intel_memory'))).toBe(true);
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
        id: 'reply:custom:om_llm_obs',
        kind: 'reply.custom',
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
            candidate_ids: ['reply:custom:om_llm_obs'],
            intents: [{
              candidate_id: 'reply:custom:om_llm_obs',
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
        content: '回句话',
        contentType: 'text',
      });
      await runChannelClassifierTask(root, 'alpha', {
        aiClient: llmClassifierClient([{
          message_id: 'om_ctx_ignore',
          classification: 'ignore',
          confidence: 'medium',
          summary: '回句话',
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
        content: '回句话',
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
            summary: '回句话',
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
      expect(result.timeout).toBeUndefined();
      expect(summarizeChannelEventQueue(root, 'alpha').pending_speech_generation).toBe(0);
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
