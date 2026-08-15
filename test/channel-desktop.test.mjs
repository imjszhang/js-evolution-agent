import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  appendDesktopSessionRecord,
  listDesktopSessions,
  readDesktopSession,
  sendDesktopInboundMessage,
} from '../src/channel/adapters/desktop/index.mjs';
import {
  findDesktopIngress,
  recordDesktopIngress,
} from '../src/channel/adapters/desktop/ingress-index.mjs';
import { channelDirForSubject } from '../src/channel/paths.mjs';
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
import { channelDesktopSessionPath } from '../src/channel/paths.mjs';

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

function runDesktopChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: stderr || stdout || 'no child output' });
      }
    });
  });
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

  it('builds a persistent byte index for large offset reads', () => {
    const project = makeRoot();
    const file = channelDesktopSessionPath(project, 'alpha', 'large');
    mkdirSync(dirname(file), { recursive: true });
    const total = 20_000;
    writeFileSync(file, `${Array.from({ length: total }, (_, offset) => JSON.stringify({
      schema_version: 1,
      id: `large-${offset}`,
      session_id: 'large',
      target: 'desktop:large',
      direction: 'inbound',
      role: 'user',
      content: `message ${offset}`,
      created_at: '2026-08-15T00:00:00.000Z',
      offset,
    })).join('\n')}\n`);
    const page = readDesktopSession(project, 'alpha', 'large', {
      offset: total - 5,
      limit: 5,
    });
    expect(page.total).toBe(total);
    expect(page.records.map((record) => record.id)).toEqual([
      'large-19995',
      'large-19996',
      'large-19997',
      'large-19998',
      'large-19999',
    ]);
    expect(readDesktopSession(project, 'alpha', 'large', { tail: 1 }).records[0].id)
      .toBe('large-19999');
  });

  it('splits large id buckets while preserving direct duplicate lookup', () => {
    const project = makeRoot();
    const file = channelDesktopSessionPath(project, 'alpha', 'split');
    mkdirSync(dirname(file), { recursive: true });
    const ids = [];
    for (let candidate = 0; ids.length < 1_100; candidate += 1) {
      const id = `split-${candidate}`;
      if (createHash('sha256').update(id).digest('hex').startsWith('00')) ids.push(id);
    }
    writeFileSync(file, `${ids.map((id, offset) => JSON.stringify({
      schema_version: 1,
      id,
      session_id: 'split',
      target: 'desktop:split',
      direction: 'inbound',
      role: 'user',
      content: id,
      created_at: '2026-08-15T00:00:00.000Z',
      offset,
    })).join('\n')}\n`);
    expect(readDesktopSession(project, 'alpha', 'split', { tail: 1 }).total)
      .toBe(ids.length);
    const duplicate = appendDesktopSessionRecord(project, 'alpha', 'split', {
      id: ids.at(-1),
      direction: 'inbound',
      role: 'user',
      content: 'different content',
    });
    expect(duplicate).toMatchObject({
      created: false,
      duplicate: true,
      record: { id: ids.at(-1) },
    });
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

  it('repairs ingress when session append succeeds before pending inbound write fails', () => {
    const project = makeRoot();
    expect(() => sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'repair-message',
      text: 'repair me',
    }, {
      writeInbound: () => {
        throw new Error('injected write failure');
      },
    })).toThrow('injected write failure');

    const repaired = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'repair-message',
      text: 'repair me',
    });
    expect(repaired).toMatchObject({
      duplicate: true,
      ingress_repaired: true,
      classifier_created: true,
    });
    expect(repaired.inbound_file).toEqual(expect.any(String));
    expect(readDesktopSession(project, 'alpha', 'main', { tail: 10 }).records)
      .toHaveLength(1);
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

  it('locks first-time session reads against concurrent appends', async () => {
    const project = makeRoot();
    const [read, written] = await Promise.all([
      Promise.resolve().then(() => readDesktopSession(project, 'alpha', 'race', { tail: 1 })),
      Promise.resolve().then(() => appendDesktopSessionRecord(project, 'alpha', 'race', {
        id: 'race-1',
        direction: 'inbound',
        role: 'user',
        content: 'hello',
      })),
    ]);
    expect(written.created).toBe(true);
    const page = readDesktopSession(project, 'alpha', 'race', { offset: 0, limit: 10 });
    expect(page.total).toBe(1);
    expect(page.records.map((record) => record.id)).toEqual(['race-1']);
    expect(read.total === 0 || read.total === 1).toBe(true);
  });

  it('rewakes the classifier after pending write succeeds and enqueue fails', () => {
    const project = makeRoot();
    expect(() => sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'rewake-message',
      text: 'rewake me',
    }, {
      enqueueClassifier: () => {
        throw new Error('injected enqueue failure');
      },
    })).toThrow('injected enqueue failure');

    const retried = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'rewake-message',
      text: 'rewake me',
    });
    expect(retried).toMatchObject({
      duplicate: true,
      ingress_repaired: true,
      classifier_created: true,
    });
  });

  it('rejects the same message id across desktop sessions', () => {
    const project = makeRoot();
    sendDesktopInboundMessage(project, 'alpha', {
      session: 'chat-a',
      message_id: 'shared-id',
      text: 'first',
    });
    expect(() => sendDesktopInboundMessage(project, 'alpha', {
      session: 'chat-b',
      message_id: 'shared-id',
      text: 'second',
    })).toThrow('already belongs to session chat-a');
    expect(readDesktopSession(project, 'alpha', 'chat-b', { tail: 10 }).records).toHaveLength(0);
  });

  it('looks up inbound history without parsing every processed file', () => {
    const project = makeRoot();
    const processed = join(project, 'runtime', 'subjects', 'alpha', 'data', 'channel', 'inbound', 'processed');
    mkdirSync(processed, { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(join(processed, `20260815-legacy-${index}.json`), JSON.stringify({
        message_id: `legacy-${index}`,
        envelope: { message_id: `legacy-${index}`, metadata: { session_id: 'main' } },
      }));
    }
    const started = Date.now();
    const first = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'legacy-12',
      text: 'already processed',
    });
    const second = sendDesktopInboundMessage(project, 'alpha', {
      session: 'main',
      message_id: 'fresh-after-history',
      text: 'new',
    });
    expect(first.ingress_repaired).toBe(true);
    expect(first.inbound_file).toBeNull();
    expect(second.session_created).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('indexes oversized JSONL lines without blocking later records', () => {
    const project = makeRoot();
    const file = channelDesktopSessionPath(project, 'alpha', 'huge');
    mkdirSync(dirname(file), { recursive: true });
    const huge = `${'x'.repeat(5 * 1024 * 1024)}`;
    writeFileSync(file, `${JSON.stringify({ id: 'too-big', content: huge })}\n${JSON.stringify({
      schema_version: 1,
      id: 'after-huge',
      session_id: 'huge',
      target: 'desktop:huge',
      direction: 'inbound',
      role: 'user',
      content: 'ok',
      created_at: '2026-08-15T00:00:00.000Z',
      offset: 0,
    })}\n`);
    const page = readDesktopSession(project, 'alpha', 'huge', { tail: 2 });
    expect(page.records.map((record) => record.id)).toEqual(['after-huge']);
  });

  it('does not create session files or list entries when reading a missing session', () => {
    const project = makeRoot();
    const file = channelDesktopSessionPath(project, 'alpha', 'never-created');
    const page = readDesktopSession(project, 'alpha', 'never-created', { tail: 10 });
    expect(page).toMatchObject({
      session_id: 'never-created',
      records: [],
      total: 0,
      next_offset: 0,
    });
    expect(existsSync(file)).toBe(false);
    expect(listDesktopSessions(project, 'alpha')).toEqual([]);
    expect(existsSync(join(
      channelDirForSubject(project, 'alpha'),
      'desktop',
      'session-index',
      'never-created',
    ))).toBe(false);
  });

  it('rejects the same inbound id across sessions even when sent concurrently', async () => {
    const project = makeRoot();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/channel/adapters/desktop/index.mjs')).href;
    const script = (session) => `
      import { sendDesktopInboundMessage } from ${JSON.stringify(moduleUrl)};
      try {
        const result = sendDesktopInboundMessage(${JSON.stringify(project)}, 'alpha', {
          session: ${JSON.stringify(session)},
          message_id: 'concurrent-shared',
          text: 'race',
        });
        process.stdout.write(JSON.stringify({ ok: true, session: result.session_id }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
        process.exitCode = 2;
      }
    `;
    const [first, second] = await Promise.all([
      runDesktopChild(script('chat-a')),
      runDesktopChild(script('chat-b')),
    ]);
    const accepted = [first, second].filter((item) => item.ok);
    const rejected = [first, second].filter((item) => !item.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].error).toMatch(/already belongs to session/);
    const totals = [
      readDesktopSession(project, 'alpha', 'chat-a', { tail: 10 }).total,
      readDesktopSession(project, 'alpha', 'chat-b', { tail: 10 }).total,
    ];
    expect(totals.filter((total) => total > 0)).toEqual([1]);
    expect(existsSync(channelDesktopSessionPath(
      project,
      'alpha',
      accepted[0].session === 'chat-a' ? 'chat-b' : 'chat-a',
    ))).toBe(false);
  });

  it('drops stale ingress shards after a crash-safe rebuild', () => {
    const project = makeRoot();
    const indexDir = join(channelDirForSubject(project, 'alpha'), 'desktop', 'ingress-index');
    recordDesktopIngress(project, 'alpha', {
      message_id: 'ghost-message',
      session_id: 'stale',
      status: 'processed',
    });
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, 'metadata.json'), '{broken');
    expect(findDesktopIngress(project, 'alpha', 'ghost-message')).toBeNull();
    expect(existsSync(join(indexDir, 'metadata.json'))).toBe(true);
    const leftover = existsSync(indexDir)
      ? readFileSync(join(indexDir, 'metadata.json'), 'utf8')
      : '';
    expect(leftover).not.toContain('ghost-message');
    expect(findDesktopIngress(project, 'alpha', 'ghost-message')).toBeNull();
  });

  it('keeps concurrent rebuild and append records', async () => {
    const project = makeRoot();
    const processed = join(project, 'runtime', 'subjects', 'alpha', 'data', 'channel', 'inbound', 'processed');
    mkdirSync(processed, { recursive: true });
    writeFileSync(join(processed, '20260815-scanned.json'), JSON.stringify({
      message_id: 'scanned-message',
      envelope: { message_id: 'scanned-message', metadata: { session_id: 'main' } },
    }));
    const indexDir = join(channelDirForSubject(project, 'alpha'), 'desktop', 'ingress-index');
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(join(indexDir, 'metadata.json'), '{broken');
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/channel/adapters/desktop/ingress-index.mjs')).href;
    const [found, recorded] = await Promise.all([
      runDesktopChild(`
        import { findDesktopIngress } from ${JSON.stringify(moduleUrl)};
        const entry = findDesktopIngress(${JSON.stringify(project)}, 'alpha', 'scanned-message');
        process.stdout.write(JSON.stringify({ ok: true, entry }));
      `),
      runDesktopChild(`
        import { recordDesktopIngress } from ${JSON.stringify(moduleUrl)};
        const entry = recordDesktopIngress(${JSON.stringify(project)}, 'alpha', {
          message_id: 'appended-message',
          session_id: 'main',
          status: 'pending',
        });
        process.stdout.write(JSON.stringify({ ok: true, entry }));
      `),
    ]);
    expect(found.entry).toMatchObject({ message_id: 'scanned-message' });
    expect(recorded.entry).toMatchObject({ message_id: 'appended-message' });
    expect(findDesktopIngress(project, 'alpha', 'scanned-message')).toMatchObject({
      message_id: 'scanned-message',
    });
    expect(findDesktopIngress(project, 'alpha', 'appended-message')).toMatchObject({
      message_id: 'appended-message',
    });
  });
});
