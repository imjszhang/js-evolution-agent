import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createJsonlTailer,
  createRuntimeWatcher,
  summarizeInboundFile,
} from '../src/intelligence/evolution-viewer/runtime-watch.mjs';

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
}

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
    expect(closed.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('deduplicates watchers that fall back to the same parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-watch-dedupe-'));
    mkdirSync(join(root, 'data', 'channel'), { recursive: true });
    const watched = [];
    const watcher = createRuntimeWatcher({
      runtimeRoot: root,
      subjectMeta: { subject: 'alpha', namespace: 'alpha' },
      debounceMs: 0,
      reconcileMs: 0,
      includeOperator: true,
      includeDesktopSessions: true,
      watchFactory: (path) => {
        watched.push(path);
        return { close: () => {} };
      },
    });
    watcher.start();
    expect(new Set(watched).size).toBe(watched.length);
    expect(watched.length).toBeLessThan(watcher.paths.length);
    expect(watched.length).toBeLessThanOrEqual(7);
    watcher.stop();
  });

  it('reattaches runtime file watchers after atomic replacement', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'jea-runtime-replace-'));
    const dir = join(root, 'data', 'evolution', 'tasks');
    const target = join(dir, 'pending_tasks.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '{}');
    const closed = [];
    const identities = [];
    const changes = [];
    const watcher = createRuntimeWatcher({
      runtimeRoot: root,
      subjectMeta: { subject: 'alpha', namespace: 'alpha' },
      debounceMs: 5,
      reconcileMs: 0,
      onRuntimeChange: () => { changes.push(true); },
      watchFactory: (path) => {
        identities.push(path);
        return { close: () => closed.push(path) };
      },
    });
    watcher.start();
    const before = identities.length;
    const replacement = join(dir, 'pending_tasks.next.json');
    writeFileSync(replacement, '{"version":2}');
    rmSync(target);
    renameSync(replacement, target);
    watcher.reconcile();
    vi.advanceTimersByTime(5);
    expect(changes.length).toBeGreaterThan(0);
    expect(identities.length).toBeGreaterThanOrEqual(before);
    const afterReplace = changes.length;
    appendFileSync(target, '\n');
    watcher.reconcile();
    vi.advanceTimersByTime(5);
    expect(changes.length).toBeGreaterThan(afterReplace);
    watcher.stop();
    expect(closed.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('notifies after a real-filesystem atomic replacement via reconcile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-runtime-replace-fs-'));
    const dir = join(root, 'data', 'evolution', 'tasks');
    const target = join(dir, 'pending_tasks.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, '{}');
    let changes = 0;
    const watcher = createRuntimeWatcher({
      runtimeRoot: root,
      subjectMeta: { subject: 'alpha', namespace: 'alpha' },
      debounceMs: 5,
      reconcileMs: 0,
      onRuntimeChange: () => { changes += 1; },
    });
    watcher.start();
    const replacement = join(dir, 'pending_tasks.next.json');
    writeFileSync(replacement, '{"version":2}');
    rmSync(target);
    renameSync(replacement, target);
    watcher.reconcile();
    await waitFor(() => changes > 0);
    const afterReplace = changes;
    appendFileSync(target, '\n');
    watcher.reconcile();
    await waitFor(() => changes > afterReplace);
    watcher.stop();
  });

  it('attaches after file creation and resets on equal-size rotation', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-tail-create-'));
    const path = join(root, 'events.jsonl');
    const records = [];
    const tailer = createJsonlTailer({
      path,
      onRecord: (record) => records.push(record),
      reconcileMs: 0,
    });
    tailer.start();
    writeFileSync(path, '{"id":"first"}\n');
    tailer.reconcile();
    expect(records).toEqual([{ id: 'first' }]);

    const rotated = join(root, 'events.old.jsonl');
    renameSync(path, rotated);
    writeFileSync(path, '{"id":"new-1"}\n');
    tailer.readNewBytes();
    expect(records).toEqual([{ id: 'first' }, { id: 'new-1' }]);
    tailer.stop();
  });

  it('resets after a same-inode rewrite that grows past the previous size', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-tail-rewrite-'));
    const path = join(root, 'events.jsonl');
    writeFileSync(path, `${JSON.stringify({ id: 'old-1' })}\n${JSON.stringify({ id: 'old-2' })}\n`);
    const records = [];
    const tailer = createJsonlTailer({
      path,
      onRecord: (record) => records.push(record),
      reconcileMs: 0,
    });
    tailer.start();
    writeFileSync(path, `${JSON.stringify({ id: 'new-1' })}\n${JSON.stringify({ id: 'new-2' })}\n${JSON.stringify({ id: 'new-3' })}\n`);
    tailer.readNewBytes();
    expect(records).toEqual([{ id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }]);
    tailer.stop();
  });

  it('preserves UTF-8 characters split across byte appends', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-tail-utf8-'));
    const path = join(root, 'events.jsonl');
    writeFileSync(path, '');
    const records = [];
    const tailer = createJsonlTailer({
      path,
      onRecord: (record) => records.push(record),
      reconcileMs: 0,
    });
    tailer.start();
    const bytes = Buffer.from('{"text":"你好"}\n');
    const split = Buffer.from('{"text":"你').length - 1;
    appendFileSync(path, bytes.subarray(0, split));
    tailer.readNewBytes();
    appendFileSync(path, bytes.subarray(split));
    tailer.readNewBytes();
    expect(records).toEqual([{ text: '你好' }]);
    tailer.stop();
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

  it('reads a large JSONL stream in bounded chunks and continues from its byte offset', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-tail-stress-'));
    const path = join(root, 'large.jsonl');
    const count = 100_000;
    writeFileSync(path, `${Array.from(
      { length: count },
      (_, index) => JSON.stringify({ id: index }),
    ).join('\n')}\n`);
    let seen = 0;
    const started = Date.now();
    const tailer = createJsonlTailer({
      path,
      startAtEnd: false,
      chunkBytes: 64 * 1024,
      onRecord: () => { seen += 1; },
    });
    tailer.start();
    tailer.readNewBytes();
    expect(seen).toBe(count);
    appendFileSync(path, `${JSON.stringify({ id: count })}\n`);
    tailer.readNewBytes();
    expect(seen).toBe(count + 1);
    expect(Date.now() - started).toBeLessThan(5_000);
    tailer.stop();
  });
});
