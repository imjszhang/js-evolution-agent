import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { enqueueTask, pendingTasksPath } from '../src/cli/utils/daemon-tasks.mjs';
import { enqueueChannelTask, readChannelTaskQueue, channelPendingTasksPath } from '../src/channel/task-queue.mjs';
import { writePendingInbound, listOutboxPending, cooldownActive } from '../src/channel/state.mjs';
import { runChannelIngestTask, runChannelReplyTask, runChannelWatchTask } from '../src/channel/tasks.mjs';
import { readPendingOperatorBriefs, writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import {
  decideInboundReply,
  decideProactiveReply,
  applyReplyDecision,
  resolveReplyConfig,
} from '../src/channel/reply.mjs';

let tempDir = null;

function makeRoot({ channelTarget = 'oc_test', reply = null } = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  const feishu = { default_chat_id: channelTarget };
  if (reply) feishu.reply = reply;
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: { feishu },
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
      const root = makeRoot({ reply: { mode: 'guarded', reply_observations: false } });
      const projection = buildChannelProjection(root, 'alpha');
      expect(projection.feishu.reply).toMatchObject({
        mode: 'guarded',
        reply_observations: false,
      });
      expect(resolveReplyConfig(root, 'alpha').mode).toBe('guarded');
    });
  });
});
