import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createJsonlTailer,
  createRuntimeWatcher,
  summarizeInboundFile,
} from '../src/intelligence/evolution-viewer/runtime-watch.mjs';

describe('shared runtime watch primitives', () => {
  it('tails only complete new JSONL records and resets after truncation', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-tail-'));
    const path = join(root, 'events.jsonl');
    writeFileSync(path, '{"old":true}\n');
    const records = [];
    const tailer = createJsonlTailer({ path, onRecord: (record) => records.push(record) });
    tailer.start();

    appendFileSync(path, '{"id":1}\n{"id":');
    tailer.readNewBytes();
    expect(records).toEqual([{ id: 1 }]);
    appendFileSync(path, '2}\n');
    tailer.readNewBytes();
    expect(records).toEqual([{ id: 1 }, { id: 2 }]);

    truncateSync(path, 0);
    appendFileSync(path, '{"id":3}\n');
    tailer.readNewBytes();
    expect(records).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    tailer.stop();
  });

  it('coalesces burst notifications and tears down watchers', () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'jea-watch-'));
    const cycleDir = join(root, 'data', 'evolution', 'cycle-state');
    mkdirSync(cycleDir, { recursive: true });
    const closed = [];
    const callbacks = [];
    const changes = [];
    const watcher = createRuntimeWatcher({
      runtimeRoot: root,
      subjectMeta: { subject: 'alpha', namespace: 'alpha' },
      debounceMs: 20,
      reconcileMs: 0,
      onRuntimeChange: (event) => changes.push(event),
      watchFactory: (_path, callback) => {
        callbacks.push(callback);
        return { close: () => closed.push(true) };
      },
    });
    watcher.start();
    callbacks[0]();
    callbacks[0]();
    vi.advanceTimersByTime(19);
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(changes).toHaveLength(1);
    watcher.stop();
    expect(closed).toHaveLength(1);
    vi.useRealTimers();
  });

  it('preserves classifier understanding in inbound summaries', () => {
    expect(summarizeInboundFile({
      envelope: { message_id: 'm1', chat_id: 'oc_1', text: 'hello' },
      classifier: {
        classification: 'observation',
        understanding: {
          user_intent: 'greeting',
          needs_immediate_action: false,
          action_hint: 'none',
          temporal: 'now',
          complexity: 'low',
        },
      },
    }, '/tmp/m1.json')).toMatchObject({
      message_id: 'm1',
      chat_id: 'oc_1',
      classification: 'observation',
      understanding: { user_intent: 'greeting', action_hint: 'none' },
    });
  });
});
