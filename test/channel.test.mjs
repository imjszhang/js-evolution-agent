import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { enqueueTask, pendingTasksPath } from '../src/cli/utils/daemon-tasks.mjs';
import { enqueueChannelTask, readChannelTaskQueue, channelPendingTasksPath } from '../src/channel/task-queue.mjs';
import { writePendingInbound, listOutboxPending, cooldownActive } from '../src/channel/state.mjs';
import { runChannelIngestTask, runChannelReplyTask, runChannelWatchTask } from '../src/channel/tasks.mjs';
import { collectAttentionSignals } from '../src/channel/notify.mjs';
import { readPendingOperatorBriefs, writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { runChannelTick } from '../src/channel/dispatch.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import { buildPresenceContext } from '../src/channel/presence-context.mjs';
import { planPresenceDeterministic, planPresenceWithLlm } from '../src/channel/presence-planner.mjs';
import { executePresencePlan } from '../src/channel/presence-executor.mjs';
import { resolvePresenceConfig, shouldUseLegacyReplyPipeline } from '../src/channel/presence-config.mjs';
import {
  decideInboundReply,
  decideInboundReplyWithLlm,
  decideProactiveReply,
  applyReplyDecision,
  refineReplyDecisionWithDraft,
  resolveReplyConfig,
} from '../src/channel/reply.mjs';
import { resolveSubjectReplyIdentity } from '../src/channel/subject-identity.mjs';

let tempDir = null;

function makeRoot({
  channelTarget = 'oc_test',
  reply = null,
  presence = null,
  policyText = null,
} = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(tempDir, 'policies', 'subjects', 'alpha.md'),
    policyText ?? '# alpha\n\n## Subject\nalpha 是测试主体。\n\n## Persona\n本主体名为「小测」，表达风格简洁克制。',
    'utf-8',
  );
  const feishu = { default_chat_id: channelTarget };
  if (reply) feishu.reply = reply;
  const channels = { feishu };
  if (presence) channels.presence = presence;
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

function envelopeFromPayload(payload) {
  return {
    schema_version: 1,
    channel: 'feishu',
    adapter: 'feishu',
    direction: 'inbound',
    message_id: payload.messageId,
    chat_id: payload.chatId,
    chat_type: payload.chatType ?? null,
    sender_id: payload.senderId ?? null,
    content: payload.content,
    content_type: payload.contentType ?? 'text',
    resources: [],
    mentions: [],
    received_at: new Date().toISOString(),
    raw: payload,
    metadata: {},
  };
}

async function ingestAndReply(root, payload) {
  writePendingInbound(root, 'alpha', payload);
  const ingest = await runChannelIngestTask(root, 'alpha', { limit: 5 });
  const reply = await runChannelReplyTask(root, 'alpha', {
    items: ingest.processed.map((item) => ({
      message_id: item.message_id,
      envelope: item.envelope,
      ingest_result: item.ingest_result,
    })),
  });
  return { ingest, reply };
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
      enqueueChannelTask(root, 'alpha', { type: 'channel_watch', idempotencyKey: 'channel-task' });

      expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
      expect(existsSync(channelPendingTasksPath(root, 'alpha'))).toBe(true);
      expect(pendingTasksPath(root, 'alpha')).not.toBe(channelPendingTasksPath(root, 'alpha'));
      expect(readChannelTaskQueue(root, 'alpha').tasks.map((task) => task.type)).toEqual(['channel_watch']);
    });
  });

  describe('inbound ingest', () => {
    it('turns approval messages into operator briefs', async () => {
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
      expect(result.reply_created).toBe(true);
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

  describe('reply decisions', () => {
    it('enqueues approval acknowledgement replies after ingest', async () => {
      const root = makeRoot();
      const { reply } = await ingestAndReply(root, {
        messageId: 'm-approval-reply-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '同意发布',
      });
      expect(reply.results[0].decision.action).toBe('send');
      expect(reply.results[0].result.applied).toBe(true);
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(1);
    });

    it('falls back to sendText for non-Feishu message ids', () => {
      const root = makeRoot();
      const envelope = envelopeFromPayload({
        messageId: 'm-manual-approval-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '同意发布',
      });
      const decision = decideInboundReply(root, 'alpha', {
        envelope,
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-manual-1', kind: 'approval_request', summary: '同意发布' },
        },
      });
      const result = applyReplyDecision(root, 'alpha', decision);
      expect(result.applied).toBe(true);
      expect(result.outbound.reply_to_message_id).toBe(null);
    });

    it('enqueues verification acknowledgement replies after ingest', async () => {
      const root = makeRoot();
      const { reply } = await ingestAndReply(root, {
        messageId: 'm-verify-reply-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '请下一轮核实 A',
      });
      expect(reply.results[0].decision.action).toBe('send');
      expect(reply.results[0].result.applied).toBe(true);
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(1);
    });

    it('does not reply to plain observations by default', async () => {
      const root = makeRoot();
      const { reply } = await ingestAndReply(root, {
        messageId: 'm-obs-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '知道了',
      });
      expect(reply.results[0].decision.action).toBe('none');
      expect(reply.results[0].decision.reason).toBe('observation_no_reply');
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(0);
    });

    it('respects reply.mode=off without writing outbox', async () => {
      const root = makeRoot({ reply: { mode: 'off' } });
      const { reply } = await ingestAndReply(root, {
        messageId: 'm-off-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '同意发布',
      });
      expect(reply.results[0].decision.action).toBe('none');
      expect(reply.results[0].decision.reason).toBe('reply_mode_off');
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBe(0);
    });

    it('skips duplicate replies under cooldown', () => {
      const root = makeRoot();
      const envelope = envelopeFromPayload({
        messageId: 'm-cooldown-1',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '同意发布',
      });
      const decision = decideInboundReply(root, 'alpha', {
        envelope,
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-1', kind: 'approval_request', summary: '同意发布' },
        },
      });
      const first = applyReplyDecision(root, 'alpha', decision);
      const second = applyReplyDecision(root, 'alpha', decision);
      expect(first.applied).toBe(true);
      expect(second.skipped).toBe(true);
      expect(second.reason).toBe('cooldown');
      expect(cooldownActive(root, 'alpha', decision.idempotency_key)).toBe(true);
    });

    it('suppresses proactive brief reminders after inbound acknowledgement', () => {
      const root = makeRoot();
      const envelope = envelopeFromPayload({
        messageId: 'om_manualapproval123',
        chatId: 'oc_test',
        senderId: 'ou_operator',
        content: '同意发布',
      });
      const decision = decideInboundReply(root, 'alpha', {
        envelope,
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-ack-1', kind: 'approval_request', summary: '同意发布' },
        },
      });
      applyReplyDecision(root, 'alpha', decision);
      const proactive = decideProactiveReply(root, 'alpha', {
        signal: {
          type: 'operator_brief_pending',
          severity: 'high',
          title: 'Pending approval_request',
          summary: '同意发布',
          key: 'brief:brief-ack-1',
          refs: { brief_id: 'brief-ack-1' },
        },
      });
      expect(proactive.action).toBe('none');
      expect(proactive.reason).toBe('recent_inbound_ack');
    });

    it('rate limits replies when max_messages_per_hour is configured', () => {
      const root = makeRoot({ reply: { max_messages_per_hour: 1 } });
      const first = decideInboundReply(root, 'alpha', {
        envelope: envelopeFromPayload({
          messageId: 'm-rate-1',
          chatId: 'oc_test',
          senderId: 'ou_operator',
          content: '同意发布 A',
        }),
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-rate-1', kind: 'approval_request', summary: '同意发布 A' },
        },
      });
      const second = decideInboundReply(root, 'alpha', {
        envelope: envelopeFromPayload({
          messageId: 'm-rate-2',
          chatId: 'oc_test',
          senderId: 'ou_operator',
          content: '同意发布 B',
        }),
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-rate-2', kind: 'approval_request', summary: '同意发布 B' },
        },
      });
      expect(applyReplyDecision(root, 'alpha', first).applied).toBe(true);
      const limited = applyReplyDecision(root, 'alpha', second);
      expect(limited.skipped).toBe(true);
      expect(limited.reason).toBe('rate_limited');
    });

    it('optionally refines allowed replies with an LLM draft', async () => {
      const root = makeRoot({
        reply: {
          reply_observations: true,
          llm_draft: {
            enabled: true,
            allowed_reasons: ['greeting_ack'],
          },
        },
      });
      const decision = decideInboundReply(root, 'alpha', {
        envelope: envelopeFromPayload({
          messageId: 'om_greeting123',
          chatId: 'oc_test',
          senderId: 'ou_operator',
          content: '你好',
        }),
        ingestResult: { kind: 'observation' },
      });
      const refined = await refineReplyDecisionWithDraft(root, 'alpha', decision, {
        aiClient: {
          chatMessages: async () => '{"text":"JEA alpha: 收到，我会按当前主体策略处理。"}',
        },
      });
      expect(refined.text).toContain('收到');
      expect(refined.metadata.llm_draft.used).toBe(true);
    });

    it('lets LLM autonomous mode reply to plain observations', async () => {
      const root = makeRoot({
        reply: {
          mode: 'llm_autonomous',
          llm_decision: { enabled: true },
        },
      });
      let capturedMessages = null;
      const decision = await decideInboundReplyWithLlm(root, 'alpha', {
        envelope: envelopeFromPayload({
          messageId: 'om_chat123',
          chatId: 'oc_test',
          senderId: 'ou_operator',
          content: '说说你自己吧',
        }),
        ingestResult: { kind: 'observation', record: { content: '说说你自己吧' } },
        aiClient: {
          chatMessages: async (messages) => {
            capturedMessages = messages;
            return JSON.stringify({
              action: 'send',
              text: '我是小测，alpha 的 channel 入口，可以记录你的意图、事实和核实请求。',
              reason: 'casual_intro',
              confidence: 'high',
              risk: 'low',
            });
          },
        },
      });
      expect(decision.action).toBe('send');
      expect(decision.reason).toBe('llm_autonomous_reply');
      expect(decision.text).toContain('小测');
      expect(decision.metadata.llm_decision.status).toBe('used');
      expect(JSON.stringify(capturedMessages)).toContain('小测');
      expect(JSON.stringify(capturedMessages)).toContain('subject_identity');
    });

    it('loads subject persona for channel reply prompts', () => {
      const root = makeRoot();
      const identity = resolveSubjectReplyIdentity(root, 'alpha');
      expect(identity.subject).toBe('alpha');
      expect(identity.subject_description).toContain('测试主体');
      expect(identity.persona).toContain('小测');
    });

    it('falls back when LLM autonomous text violates hard guardrails', async () => {
      const root = makeRoot({
        reply: {
          mode: 'llm_autonomous',
          llm_decision: { enabled: true },
        },
      });
      const decision = await decideInboundReplyWithLlm(root, 'alpha', {
        envelope: envelopeFromPayload({
          messageId: 'om_badapproval123',
          chatId: 'oc_test',
          senderId: 'ou_operator',
          content: '同意发布',
        }),
        ingestResult: {
          kind: 'operator_brief',
          brief: { id: 'brief-bad-1', kind: 'approval_request', summary: '同意发布' },
        },
        aiClient: {
          chatMessages: async () => JSON.stringify({
            action: 'send',
            text: '已授权发布，我会直接发布。',
            reason: 'bad_approval',
            confidence: 'high',
            risk: 'high',
          }),
        },
      });
      expect(decision.action).toBe('send');
      expect(decision.reason).toBe('approval_brief_ack');
      expect(decision.metadata.llm_decision.status).toBe('skipped');
      expect(decision.metadata.llm_decision.reason).toBe('guardrail_rejected_text');
    });
  });

  describe('watch notify', () => {
    it('writes proactive notification outbox for pending approval briefs', async () => {
      const root = makeRoot();
      const runtime = runtimeForSubject(root, 'alpha');
      writePendingOperatorBrief(runtime.runtimeRoot, {
        kind: 'approval_request',
        scope: 'next_cycle',
        summary: '同意发布测试',
        priority: 'high',
      });

      const result = await runChannelWatchTask(root, 'alpha', {});
      expect(result.enqueued.length).toBeGreaterThan(0);
      expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBeGreaterThan(0);
    });

    it('allows proactive replies for task_failed signals', () => {
      const root = makeRoot();
      const decision = decideProactiveReply(root, 'alpha', {
        signal: {
          type: 'task_failed',
          severity: 'medium',
          title: 'Task failed: intel',
          summary: 'boom',
          key: 'task_failed:task-1',
        },
      });
      expect(decision.action).toBe('send');
      expect(decision.reason).toBe('proactive_signal');
    });

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

    it('skips low-priority verification brief proactive replies', () => {
      const root = makeRoot();
      const decision = decideProactiveReply(root, 'alpha', {
        signal: {
          type: 'operator_brief_pending',
          severity: 'low',
          title: 'Pending verification_request',
          summary: '请核实 X',
          key: 'brief:brief-verify-1',
        },
      });
      expect(decision.action).toBe('none');
      expect(decision.reason).toBe('low_priority_brief_signal');
    });

    it('projects channel health independently', () => {
      const root = makeRoot();
      enqueueChannelTask(root, 'alpha', { type: 'channel_watch', idempotencyKey: 'channel-health' });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.tasks.counts.pending).toBe(1);
      expect(projection.health.ok).toBe(false);
    });

    it('exposes reply config in channel projection', () => {
      const root = makeRoot({
        reply: {
          mode: 'llm_autonomous',
          reply_observations: true,
          llm_decision: { enabled: true, timeout: 12 },
        },
      });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.feishu.reply).toMatchObject({
        mode: 'llm_autonomous',
        reply_observations: true,
        llm_decision: { enabled: true, timeout: 12 },
      });
      expect(resolveReplyConfig(root, 'alpha').mode).toBe('llm_autonomous');
    });
  });

  describe('presence loop', () => {
    it('builds presence context without requiring feishu-only modules', () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          default_target: 'oc_presence_only',
          legacy_reply: false,
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      expect(ctx.subject).toBe('alpha');
      expect(ctx.identity.persona).toContain('小测');
      expect(ctx.presence.enabled).toBe(true);
    });

    it('runChannelTick enqueues channel_presence when presence is enabled', () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', legacy_reply: false },
      });
      const tick = runChannelTick(root, 'alpha');
      const created = tick.enqueued.filter((item) => item?.created);
      expect(created.some((item) => item.task?.type === 'channel_presence')).toBe(true);
      expect(created.some((item) => item.task?.type === 'channel_watch')).toBe(false);
    });

    it('skips legacy reply pipeline when presence is enabled', () => {
      const root = makeRoot({
        presence: { enabled: true, legacy_reply: false },
      });
      expect(shouldUseLegacyReplyPipeline(root, 'alpha')).toBe(false);
    });

    it('acks approval via presence loop and writes outbox', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'deterministic',
          legacy_reply: false,
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
      expect(result.ingest_pass?.reply_skipped).toBe(true);
    });

    it('records silence when there is nothing to express', async () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'deterministic', legacy_reply: false },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      const plan = planPresenceDeterministic(ctx);
      const execution = await executePresencePlan(root, 'alpha', plan);
      expect(plan.stance).toBe('silence');
      expect(execution.skipped).toBeGreaterThan(0);
    });

    it('llm planner can reply to plain observations', async () => {
      const root = makeRoot({
        presence: {
          enabled: true,
          planner: 'llm',
          legacy_reply: false,
          default_target: 'oc_operator',
        },
      });
      const ctx = buildPresenceContext(root, 'alpha');
      ctx.channel.recent_ingested = [{
        message_id: 'om_llm_obs',
        channel: 'test',
        content: '说说你自己',
        ingest_kind: 'observation',
      }];
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
            }],
            memory: { summary: 'greeted operator' },
          }),
        },
      });
      expect(plan.stance).toBe('speak');
      expect(plan.actions[0].text).toContain('小测');
    });

    it('exposes presence config in channel projection', () => {
      const root = makeRoot({
        presence: { enabled: true, planner: 'llm', max_actions_per_tick: 3 },
      });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.presence.config).toMatchObject({
        enabled: true,
        planner: 'llm',
        max_actions_per_tick: 3,
      });
    });
  });
});
