import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { enqueueTask, pendingTasksPath } from '../src/cli/utils/daemon-tasks.mjs';
import { enqueueChannelTask, readChannelTaskQueue, channelPendingTasksPath } from '../src/channel/task-queue.mjs';
import { writePendingInbound, listOutboxPending } from '../src/channel/state.mjs';
import { runChannelIngestTask, runChannelWatchTask } from '../src/channel/tasks.mjs';
import { readPendingOperatorBriefs } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';

let tempDir = null;

function makeRoot({ channelTarget = 'oc_test' } = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          feishu: { default_chat_id: channelTarget },
        },
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
    writePendingInbound(root, 'alpha', payload);

    const result = await runChannelIngestTask(root, 'alpha', { limit: 5 });
    expect(result.processed).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    });
  });

  describe('watch notify', () => {
    it('writes notification outbox for pending approval briefs', async () => {
    const root = makeRoot();
    writePendingInbound(root, 'alpha', {
      messageId: 'm-approval-2',
      chatId: 'oc_test',
      senderId: 'ou_operator',
      content: '同意发布',
    });
    await runChannelIngestTask(root, 'alpha', { limit: 5 });

    const result = await runChannelWatchTask(root, 'alpha', {});
    expect(result.enqueued.length).toBeGreaterThan(0);
    expect(listOutboxPending(root, 'alpha', { limit: 10 }).length).toBeGreaterThan(0);
    });

    it('projects channel health independently', () => {
    const root = makeRoot();
    enqueueChannelTask(root, 'alpha', { type: 'channel_watch', idempotencyKey: 'channel-health' });
    const projection = buildChannelProjection(root, 'alpha');
    expect(projection.tasks.counts.pending).toBe(1);
    expect(projection.health.ok).toBe(false);
    });
  });
});
