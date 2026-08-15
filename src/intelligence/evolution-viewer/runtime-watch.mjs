import { existsSync, openSync, closeSync, readSync, statSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import { listJsonFiles, readJsonFile } from '../../channel/state.mjs';

export const RUNTIME_WATCH_DEBOUNCE_MS = 1000;

function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Incrementally tail a JSONL file without re-reading its full history.
 * Existing content is skipped by default; truncation resets the cursor.
 */
export function createJsonlTailer({
  path,
  onRecord,
  startAtEnd = true,
  watchFactory = watch,
}) {
  let offset = 0;
  let partial = '';
  let watcher = null;
  let stopped = true;

  function syncOffset() {
    offset = startAtEnd ? safeSize(path) : 0;
    partial = '';
  }

  function processChunk(chunk) {
    partial += chunk;
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onRecord?.(JSON.parse(trimmed));
      } catch {
        // Malformed or partial records are ignored; later valid lines still flow.
      }
    }
  }

  function readNewBytes() {
    if (!existsSync(path)) return;
    try {
      const size = safeSize(path);
      if (size < offset) {
        offset = 0;
        partial = '';
      }
      if (size <= offset) return;
      const length = size - offset;
      const buffer = Buffer.allocUnsafe(length);
      const fd = openSync(path, 'r');
      try {
        const read = readSync(fd, buffer, 0, length, offset);
        offset += read;
        processChunk(buffer.subarray(0, read).toString('utf8'));
      } finally {
        closeSync(fd);
      }
    } catch {
      // Ignore rotation/read races. Reconciliation can call readNewBytes again.
    }
  }

  function attachWatcher() {
    if (watcher || stopped || !existsSync(path)) return;
    try {
      watcher = watchFactory(path, readNewBytes);
    } catch {
      watcher = null;
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    syncOffset();
    attachWatcher();
  }

  function reconcile() {
    if (stopped) return;
    readNewBytes();
    attachWatcher();
  }

  function stop() {
    stopped = true;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher teardown races.
      }
      watcher = null;
    }
  }

  return {
    path,
    start,
    stop,
    reconcile,
    readNewBytes,
    getOffset: () => offset,
  };
}

export function runtimeWatchPaths(runtimeRoot, {
  projectRoot = null,
  watchSubjectsJson = true,
  includeOperator = false,
  includeDesktopSessions = false,
} = {}) {
  const paths = [
    join(runtimeRoot, 'data', 'evolution', 'tasks', 'pending_tasks.json'),
    join(runtimeRoot, 'data', 'evolution', 'daemon', 'worker-state.json'),
    join(runtimeRoot, 'data', 'evolution', 'views', 'current-state.json'),
    join(runtimeRoot, 'data', 'evolution', 'cycle-state'),
    join(runtimeRoot, 'data', 'channel', 'worker-state.json'),
    join(runtimeRoot, 'data', 'channel', 'tasks', 'pending_tasks.json'),
    join(runtimeRoot, 'data', 'channel', 'events.jsonl'),
    join(runtimeRoot, 'data', 'channel', 'inbound'),
    join(runtimeRoot, 'data', 'channel', 'outbox'),
  ];
  if (includeOperator) {
    paths.push(
      join(runtimeRoot, 'data', 'evolution', 'operator_briefs'),
      join(runtimeRoot, 'data', 'evolution', 'operator_facts'),
      join(runtimeRoot, 'data', 'evolution', 'operator_questions'),
    );
  }
  if (includeDesktopSessions) {
    paths.push(join(runtimeRoot, 'data', 'channel', 'desktop', 'sessions'));
  }
  if (projectRoot && watchSubjectsJson) {
    paths.push(join(projectRoot, 'runtime', 'subjects', 'registry.json'));
    paths.push(join(projectRoot, 'policies', 'subjects.json'));
  }
  return paths;
}

/**
 * Watch runtime projections and coalesce bursts into one invalidation.
 */
export function createRuntimeWatcher({
  runtimeRoot,
  projectRoot = null,
  subjectMeta,
  onRuntimeChange,
  onNotify,
  watchSubjectsJson = true,
  includeOperator = false,
  includeDesktopSessions = false,
  debounceMs = RUNTIME_WATCH_DEBOUNCE_MS,
  reconcileMs = 30_000,
  watchFactory = watch,
}) {
  const paths = runtimeWatchPaths(runtimeRoot, {
    projectRoot,
    watchSubjectsJson,
    includeOperator,
    includeDesktopSessions,
  });
  const watchers = [];
  let debounceTimer = null;
  let reconcileTimer = null;
  let started = false;

  function notify(reason = 'watch') {
    if (!started) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onRuntimeChange?.({ reason, subjectMeta });
      onNotify?.({ reason, subjectMeta });
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function attach(target) {
    if (!existsSync(target)) return;
    try {
      watchers.push(watchFactory(target, () => notify('watch')));
    } catch {
      // Missing and transiently replaced files are covered by reconciliation.
    }
  }

  function start() {
    if (started) return;
    started = true;
    for (const target of paths) attach(target);
    if (reconcileMs > 0) {
      reconcileTimer = setInterval(() => notify('reconcile'), reconcileMs);
      reconcileTimer.unref?.();
    }
  }

  function stop() {
    started = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher teardown races.
      }
    }
    watchers.length = 0;
  }

  return { paths, start, stop, notify };
}

function truncateText(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function summarizeInboundFile(payload, file) {
  const envelope = payload?.envelope ?? payload ?? {};
  const classifier = payload?.classifier ?? null;
  const understanding = classifier?.understanding ?? null;
  return {
    file: basename(file),
    message_id: payload?.message_id ?? envelope.message_id ?? envelope.messageId ?? null,
    sender: envelope.sender_id ?? envelope.sender?.id ?? envelope.open_id ?? null,
    chat_id: envelope.chat_id ?? envelope.chatId ?? null,
    received_at: payload?.received_at ?? envelope.received_at ?? null,
    text: truncateText(envelope.text ?? envelope.content ?? payload?.text ?? '', 140),
    classification: classifier?.classification ?? classifier?.kind ?? null,
    understanding: understanding
      ? {
        user_intent: understanding.user_intent ?? null,
        needs_immediate_action: understanding.needs_immediate_action ?? null,
        action_hint: understanding.action_hint ?? null,
        temporal: understanding.temporal ?? null,
        complexity: understanding.complexity ?? null,
      }
      : null,
  };
}

export function summarizeOutboxFile(payload, file) {
  const outbound = payload?.outbound ?? payload ?? {};
  return {
    file: basename(file),
    to: outbound.chat_id ?? outbound.to ?? null,
    text: truncateText(outbound.text ?? '', 140),
    speech_intent_id: payload?.metadata?.speech_intent_id
      ?? outbound.metadata?.speech_intent_id
      ?? null,
    message_id: payload?.send_result?.messageId ?? payload?.send_result?.message_id ?? null,
    sent_at: payload?.sent_at ?? null,
    failed_at: payload?.failed_at ?? null,
    reason: payload?.reason ?? null,
  };
}

export function summarizeChannelDir(dir, summarize, limit) {
  return listJsonFiles(dir)
    .slice(-Math.max(0, limit))
    .reverse()
    .map((file) => summarize(readJsonFile(file, null), file));
}
