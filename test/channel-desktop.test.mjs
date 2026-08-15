import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  appendDesktopSessionRecord,
  readDesktopSession,
  sendDesktopInboundMessage,
} from '../src/channel/adapters/desktop/index.mjs';
import { resolveInboundAdapter } from '../src/channel/inbound-adapters/registry.mjs';
import { resolveOutboundAdapter } from '../src/channel/adapter-registry.mjs';
import { runChannelClassifierTask } from '../src/channel/classifier.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import { runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { writeOutboxMessage } from '../src/channel/state.mjs';
import { normalizeOutboundMessage } from '../src/channel/types.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { channelCommand } from '../src/cli/commands/channel.mjs';
import { resolveOutboundTarget } from '../src/channel/transport.mjs';

let root = null;

function makeRoot({
  presence = {
    enabled: true,
    planner: 'deterministic',
    default_transport: 'desktop',
    default_target: 'desktop:main',
  },
  additionalChannels = {},
} = {}) {
  root = mkdtempSync(join(tmpdir(), 'jea-desktop-channel-'));
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(root, 'policies', 'subjects', 'alpha.md'),
    '# alpha\n\n## Subject\nalpha test subject.\n\n## Persona\nConcise.',
    'utf-8',
  );
  writeJsonFile(join(root, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          feishu: { enabled: true, default_chat_id: 'oc_test', mock: true },
          classifier: { enabled: true, mode: 'deterministic', batch_size: 20 },
          presence,
          ...additionalChannels,
        },
      },
    },
  });
  mkdirSync(join(root, 'runtime', 'subjects', 'alpha', 'data', 'intelligence'), { recursive: true });
  return root;
}

async function captureConsole(fn) {
  const original = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  try {
    return { code: await fn(), output: output.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('desktop channel adapter', () => {
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('keeps append-only session records stable and deduplicates offset/tail reads', () => {
    const project = makeRoot();
    const first = appendDesktopSessionRecord(project, 'alpha', 'main', {
      id: 'stable-1',
      direction: 'inbound',
      role: 'user',
      content: 'one',
      created_at: '2026-08-15T00:00:00.000Z',
    });
    appendDesktopSessionRecord(project, 'alpha', 'main', {
      id: 'stable-2',
      direction: 'outbound',
      role: 'assistant',
      content: 'two',
      created_at: '2026-08-15T00:00:01.000Z',
    });
    const duplicate = appendDesktopSessionRecord(project, 'alpha', 'main', {
      id: 'stable-1',
      direction: 'inbound',
      role: 'user',
      content: 'one',
    });
    expect(duplicate.created).toBe(false);

    const duplicateLine = JSON.parse(readFileSync(first.file, 'utf-8').trim().split('\n')[0]);
    appendFileSync(first.file, `${JSON.stringify({ ...duplicateLine, offset: 2 })}\n`);

    const page = readDesktopSession(project, 'alpha', 'main', { offset: 1, limit: 10 });
    expect(page.schema_version).toBe(1);
    expect(page.records.map((record) => record.id)).toEqual(['stable-2']);
    expect(page.total).toBe(2);
    expect(page.next_offset).toBe(2);
    expect(readDesktopSession(project, 'alpha', 'main', { tail: 1 }).records[0].id).toBe('stable-2');
  });

  it('runs desktop inbound through classifier, presence, speech, outbox, and notify', async () => {
    const project = makeRoot();
    const inbound = sendDesktopInboundMessage(project, 'alpha', {
      session: 'chat-a',
      message_id: 'desktop-msg-1',
      text: '同意发布候选',
    });
    expect(inbound.classifier_created).toBe(true);

    const classified = await runChannelClassifierTask(project, 'alpha');
    expect(classified.classified).toBe(1);
    const presence = await runChannelPresenceTask(project, 'alpha');
    expect(presence.plan.kind).toBe('speak');
    const notify = await runChannelNotifyTask(project, 'alpha');
    expect(notify.sent.length).toBeGreaterThan(0);

    const session = readDesktopSession(project, 'alpha', 'chat-a', { offset: 0, limit: 10 });
    expect(session.records[0].role).toBe('user');
    expect(session.records.some((record) => record.role === 'assistant')).toBe(true);
    expect(session.records.filter((record) => record.role === 'assistant')
      .every((record) => record.target === 'desktop:chat-a')).toBe(true);
  });

  it('deduplicates desktop inbound while Feishu and desktop outbound coexist', async () => {
    const project = makeRoot();
    const first = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'same-message',
      text: 'hello',
    });
    const second = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'same-message',
      text: 'hello',
    });
    expect(first.session_created).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.inbound_file).toBeNull();

    writeOutboxMessage(project, 'alpha', normalizeOutboundMessage({
      channel: 'desktop',
      target: 'desktop:main',
      text: 'local reply',
      idempotency_key: 'desktop-outbound',
    }));
    writeOutboxMessage(project, 'alpha', normalizeOutboundMessage({
      channel: 'feishu',
      target: 'oc_test',
      text: 'remote reply',
      idempotency_key: 'feishu-outbound',
      metadata: { mock: true },
    }));
    const notify = await runChannelNotifyTask(project, 'alpha');
    expect(notify.sent).toHaveLength(2);
    expect(notify.failed).toHaveLength(0);
    expect(readDesktopSession(project, 'alpha', 'main', { tail: 10 }).records
      .some((record) => record.content === 'local reply')).toBe(true);
  });

  it('registers both directions and projects desktop sessions', async () => {
    const project = makeRoot();
    expect(resolveInboundAdapter('desktop')?.id).toBe('desktop');
    expect((await resolveOutboundAdapter('desktop')).id).toBe('desktop');
    sendDesktopInboundMessage(project, 'alpha', {
      session: 'projected',
      message_id: 'projection-message',
      text: 'projection',
    });
    const projection = buildChannelProjection(project, 'alpha');
    expect(projection.desktop.config.enabled).toBe(true);
    expect(projection.desktop.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: 'projected', message_count: 1 }),
    ]));
    expect(projection.feishu.config.enabled).toBe(true);
  });

  it('resolves explicit Feishu aliases without recursing when desktop is default', async () => {
    const project = makeRoot();
    await expect(resolveOutboundTarget(project, 'alpha', 'feishu')).resolves.toEqual({
      transport: 'feishu',
      target: 'oc_test',
    });
    await expect(resolveOutboundTarget(project, 'alpha', 'lark')).resolves.toEqual({
      transport: 'lark',
      target: 'oc_test',
    });
  });

  it('keeps bridge-intent defaults while explicit desktop and Feishu routes stay isolated', async () => {
    const project = makeRoot({
      presence: {
        enabled: true,
        planner: 'deterministic',
        default_transport: 'bridge-intent',
      },
      additionalChannels: {
        'bridge-intent': { enabled: true, target: 'jea-alpha' },
      },
    });
    await expect(resolveOutboundTarget(project, 'alpha', 'channel_default')).resolves.toEqual({
      transport: 'bridge-intent',
      target: 'jea-alpha',
    });
    await expect(resolveOutboundTarget(project, 'alpha', 'desktop')).resolves.toEqual({
      transport: 'desktop',
      target: 'desktop:main',
    });
    await expect(resolveOutboundTarget(project, 'alpha', 'feishu')).resolves.toEqual({
      transport: 'feishu',
      target: 'oc_test',
    });
    await expect(resolveOutboundTarget(project, 'alpha', 'channel_default')).resolves.toEqual({
      transport: 'bridge-intent',
      target: 'jea-alpha',
    });
  });

  it('supports desktop send and offset/tail session CLI reads', async () => {
    const project = makeRoot();
    const sent = await captureConsole(() => channelCommand({
      subcommand: 'desktop',
      args: ['send'],
      flags: { session: 'cli', text: 'from cli', id: 'cli-message', json: true },
      root: project,
    }));
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.output).target).toBe('desktop:cli');

    const read = await captureConsole(() => channelCommand({
      subcommand: 'desktop',
      args: ['read', 'cli'],
      flags: { offset: 0, tail: 1, json: true },
      root: project,
    }));
    expect(read.code).toBe(0);
    expect(JSON.parse(read.output).records[0]).toMatchObject({
      id: 'inbound:cli-message',
      content: 'from cli',
    });
  });
});
