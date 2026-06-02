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
  isPresenceMessageHandled,
} from '../src/channel/state.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { isPresenceInteractionRecord } from '../src/channel/presence-memory.mjs';
import { resolvePresenceAffordances } from '../src/channel/presence-affordances.mjs';
import { runChannelIngestTask, runChannelTask, runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { collectAttentionSignals } from '../src/channel/notify.mjs';
import { readPendingOperatorBriefs } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { runChannelTick } from '../src/channel/dispatch.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import { buildPresenceContext } from '../src/channel/presence-context.mjs';
import { planPresenceDeterministic, planPresenceWithLlm } from '../src/channel/presence-planner.mjs';
import { executePresencePlan } from '../src/channel/presence-executor.mjs';
import { resolvePresenceConfig } from '../src/channel/presence-config.mjs';
import { resolveSubjectReplyIdentity } from '../src/channel/subject-identity.mjs';

let tempDir = null;

function makeRoot({
  channelTarget = 'oc_test',
  presence = { enabled: true, planner: 'deterministic' },
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
    it('uses a separate queue from cycle tasks', () => {
      const root = makeRoot();
      enqueueTask(root, 'alpha', { type: 'run_cycle', idempotencyKey: 'cycle-task' });
      enqueueChannelTask(root, 'alpha', { type: 'channel_presence', idempotencyKey: 'channel-task' });

      expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
      expect(existsSync(channelPendingTasksPath(root, 'alpha'))).toBe(true);
      expect(pendingTasksPath(root, 'alpha')).not.toBe(channelPendingTasksPath(root, 'alpha'));
      expect(readChannelTaskQueue(root, 'alpha').tasks.map((task) => task.type)).toEqual(['channel_presence']);
    });

    it('rejects deprecated channel_reply and channel_watch tasks', async () => {
      const root = makeRoot();
      const { task } = enqueueChannelTask(root, 'alpha', {
        type: 'channel_reply',
        idempotencyKey: 'deprecated-reply',
      });
      await expect(runChannelTask(root, 'alpha', task)).rejects.toThrow(/Deprecated channel task type/);
    });
  });

  describe('inbound ingest', () => {
    it('turns approval messages into operator briefs without enqueueing reply', async () => {
      const root = makeRoot();
      writePendingInbound(root, 'alpha', {
        messageId: 'm-approval-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        chatType: 'group',
        content: '同意发布这个候选',
        contentType: 'text',
      });

      const result = await runChannelIngestTask(root, 'alpha', { limit: 5 });
      expect(result.processed).toHaveLength(1);
      expect(result.reply_created).toBeUndefined();
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
      await runChannelIngestTask(root, 'alpha', { limit: 5 });
      writePendingInbound(root, 'alpha', payload);

      const result = await runChannelIngestTask(root, 'alpha', { limit: 5 });
      expect(result.processed).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
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
      const plan = planPresenceDeterministic(ctx);
      expect(plan.stance).toBe('speak');
      expect(plan.actions.some((a) => a.type === 'send_message' && a.reason === 'proactive_signal')).toBe(true);
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

    it('runChannelTick always enqueues channel_presence', () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
      });
      const tick = runChannelTick(root, 'alpha');
      const created = tick.enqueued.filter((item) => item?.created);
      expect(created.some((item) => item.task?.type === 'channel_presence')).toBe(true);
      expect(created.some((item) => item.task?.type === 'channel_watch')).toBe(false);
      expect(created.some((item) => item.task?.type === 'channel_ingest')).toBe(false);
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
      const result = await runChannelPresenceTask(root, 'alpha', { run_ingest: true });
      expect(result.plan.stance).toBe('speak');
      expect(result.execution.applied).toBeGreaterThan(0);
      expect(listOutboxPending(root, 'alpha', { limit: 5 }).length).toBeGreaterThan(0);
      expect(isPresenceMessageHandled(root, 'alpha', 'om_presence_approval')).toBe(true);
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
      const first = await runChannelPresenceTask(root, 'alpha', { run_ingest: true });
      expect(first.plan.stance).toBe('speak');
      const second = await runChannelPresenceTask(root, 'alpha', { run_ingest: false });
      expect(second.plan.stance).toBe('silence');
      expect(second.plan.reason).toBe('nothing_to_express');
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(1);
    });

    it('records silence when there is nothing to express', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic' },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      const execution = await executePresencePlan(root, 'alpha', plan, { context: ctx });
      expect(plan.stance).toBe('silence');
      expect(execution.skipped).toBeGreaterThan(0);
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
      await runChannelPresenceTask(root, 'alpha', { run_ingest: true });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.channel.recent_presence_interactions.length).toBeGreaterThan(0);
      expect(readPresenceState(root, 'alpha').handled_messages.om_intel_memory).toBeDefined();
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
      ctx.presence = resolvePresenceConfig(root, 'alpha');
      const plan = await planPresenceWithLlm(ctx, {
        aiClient: {
          chatMessages: async () => JSON.stringify({
            stance: 'speak',
            reason: 'intro',
            actions: [{
              type: 'send_message',
              target: 'channel_default',
              text: '我是小测，alpha 的外部接口。',
              reason: 'casual_intro',
              reply_to_message_id: 'om_llm_obs',
            }],
          }),
        },
      });
      expect(plan.stance).toBe('speak');
      expect(plan.actions[0].text).toContain('小测');
    });

    it('skips expression when presence.enabled is false', async () => {
      const root = makeRoot({ presence: { enabled: false } });
      const result = await runChannelPresenceTask(root, 'alpha', { run_ingest: false });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('presence_disabled');
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
