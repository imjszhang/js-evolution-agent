import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { readChannelEvents, readJsonlTail, recordChannelEvent } from '../src/channel/audit.mjs';
import { channelEventsPath } from '../src/channel/paths.mjs';
import {
  resetClassifierTickAuditForTests,
  runChannelClassifierTick,
} from '../src/channel/dispatch.mjs';
import { writePendingInbound } from '../src/channel/state.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-audit-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          classifier: {
            enabled: true,
            mode: 'deterministic',
            interval_ms: 30_000,
            batch_size: 5,
          },
        },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'channel'), { recursive: true });
  return tempDir;
}

afterEach(() => {
  resetClassifierTickAuditForTests();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('channel audit tail read', () => {
  it('returns [] for a missing file, empty file, or limit=0', () => {
    const root = makeRoot();
    const file = channelEventsPath(root, 'alpha');
    expect(readChannelEvents(root, 'alpha', { limit: 20 })).toEqual([]);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '', 'utf8');
    expect(readJsonlTail(file, { limit: 10 })).toEqual([]);
    writeFileSync(file, '{"id":"a"}\n', 'utf8');
    expect(readJsonlTail(file, { limit: 0 })).toEqual([]);
  });

  it('tails recent complete UTF-8 lines and skips bad rows', () => {
    const root = makeRoot();
    const file = channelEventsPath(root, 'alpha');
    writeFileSync(
      file,
      [
        '{"id":"old","type":"channel_message_received"}',
        '{bad',
        '{"id":"mid","type":"channel_task_enqueued"}',
        '{"id":"newest","type":"channel_agent_run_completed"}',
      ].join('\n'),
      'utf8',
    );
    const events = readJsonlTail(file, { limit: 2 });
    expect(events.map((item) => item.id)).toEqual(['newest', 'mid']);
  });

  it('handles a long single line and rotation to a smaller file', () => {
    const root = makeRoot();
    const file = channelEventsPath(root, 'alpha');
    const huge = { id: 'huge', type: 'channel_message_received', text: 'x'.repeat(80_000) };
    writeFileSync(file, `${JSON.stringify(huge)}\n`, 'utf8');
    expect(readJsonlTail(file, { limit: 1, chunkBytes: 1024 })[0].id).toBe('huge');
    writeFileSync(file, '{"id":"rotated","type":"channel_tick"}\n', 'utf8');
    expect(readJsonlTail(file, { limit: 5 }).map((item) => item.id)).toEqual(['rotated']);
  });
});

describe('channel classifier tick audit', () => {
  it('does not write a no-op tick on every idle classifier pass', () => {
    const root = makeRoot();
    const first = runChannelClassifierTick(root, 'alpha');
    expect(first.enqueued.created).toBe(false);
    expect(readChannelEvents(root, 'alpha', { limit: 10 }).filter((event) => event.type === 'channel_classifier_tick')).toHaveLength(1);
    runChannelClassifierTick(root, 'alpha');
    runChannelClassifierTick(root, 'alpha');
    expect(readChannelEvents(root, 'alpha', { limit: 10 }).filter((event) => event.type === 'channel_classifier_tick')).toHaveLength(1);
  });

  it('records a tick when a classifier task is created', () => {
    const root = makeRoot();
    runChannelClassifierTick(root, 'alpha');
    writePendingInbound(root, 'alpha', {
      message_id: 'msg-1',
      envelope: { text: 'hello', chat_id: 'oc_test', sender_id: 'ou_1' },
    });
    const created = runChannelClassifierTick(root, 'alpha');
    expect(created.enqueued.created).toBe(true);
    const ticks = readChannelEvents(root, 'alpha', { limit: 20 }).filter((event) => event.type === 'channel_classifier_tick');
    expect(ticks.some((event) => event.created === true)).toBe(true);
    expect(recordChannelEvent(root, 'alpha', { type: 'channel_message_received', status: 'ok' }).type).toBe('channel_message_received');
  });
});
