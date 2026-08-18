import { existsSync, openSync, closeSync, readSync, fstatSync, statSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { basename, dirname, join } from 'node:path';
import { listJsonFiles, readJsonFile } from '../../channel/state.mjs';

export const RUNTIME_WATCH_DEBOUNCE_MS = 1000;
export const RUNTIME_WATCH_PARTITIONS = Object.freeze(['service', 'channel', 'evolution', 'conversation']);
export const TAIL_READ_CHUNK_BYTES = 256 * 1024;
const HEAD_ANCHOR_BYTES = 64;

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function hashHead(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Incrementally tail a JSONL file without re-reading its full history.
 * Existing content is skipped by default; truncation or rewrite resets the cursor.
 */
export function createJsonlTailer({
  path,
  onRecord,
  startAtEnd = true,
  watchFactory = watch,
  reconcileMs = 1_000,
  chunkBytes = TAIL_READ_CHUNK_BYTES,
}) {
  let offset = 0;
  let lastSeenSize = 0;
  let partial = '';
  let identity = null;
  let headAnchor = null;
  let decoder = new StringDecoder('utf8');
  let watcher = null;
  let reconcileTimer = null;
  let stopped = true;

  function resetCursor() {
    offset = 0;
    partial = '';
    decoder = new StringDecoder('utf8');
    headAnchor = null;
  }

  function processChunk(chunk) {
    partial += decoder.write(chunk);
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

  function captureHead(fd, size) {
    if (size <= 0) {
      headAnchor = null;
      return;
    }
    const length = Math.min(HEAD_ANCHOR_BYTES, size);
    const head = Buffer.allocUnsafe(length);
    const read = readSync(fd, head, 0, length, 0);
    headAnchor = read > 0
      ? { hash: hashHead(head.subarray(0, read)), length: read }
      : null;
  }

  function headChanged(fd, size) {
    if (!headAnchor || offset === 0 || size <= 0) return false;
    if (size < headAnchor.length) return true;
    const head = Buffer.allocUnsafe(headAnchor.length);
    const read = readSync(fd, head, 0, headAnchor.length, 0);
    if (read <= 0) return true;
    return hashHead(head.subarray(0, read)) !== headAnchor.hash;
  }

  function readNewBytes() {
    let fd = null;
    try {
      fd = openSync(path, 'r');
    } catch {
      if (identity) {
        identity = null;
        lastSeenSize = 0;
        resetCursor();
        closeWatcher();
      }
      return;
    }
    try {
      const stat = fstatSync(fd);
      const nextIdentity = `${stat.dev}:${stat.ino}`;
      if (identity && identity !== nextIdentity) {
        resetCursor();
        closeWatcher();
      }
      identity = nextIdentity;

      if (stat.size < offset || (lastSeenSize > 0 && stat.size < lastSeenSize) || headChanged(fd, stat.size)) {
        resetCursor();
        captureHead(fd, stat.size);
      }

      if (stat.size <= offset) {
        lastSeenSize = stat.size;
        if (offset === 0) captureHead(fd, stat.size);
        return;
      }

      if (offset === 0) captureHead(fd, stat.size);

      const cap = Math.max(1, Number(chunkBytes) || TAIL_READ_CHUNK_BYTES);
      while (offset < stat.size) {
        const toRead = Math.min(stat.size - offset, cap);
        const buffer = Buffer.allocUnsafe(toRead);
        const read = readSync(fd, buffer, 0, toRead, offset);
        if (!read) break;
        offset += read;
        processChunk(buffer.subarray(0, read));
      }
      lastSeenSize = stat.size;
    } catch {
      // Ignore rotation/read races. Reconciliation can call readNewBytes again.
    } finally {
      if (fd != null) closeSync(fd);
    }
    attachWatcher();
  }

  function closeWatcher() {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // Ignore watcher teardown races.
    }
    watcher = null;
  }

  function attachWatcher() {
    if (watcher || stopped || !existsSync(path)) return;
    try {
      watcher = watchFactory(path, readNewBytes);
    } catch {
      watcher = null;
    }
  }

  function syncOffset() {
    let fd = null;
    try {
      fd = openSync(path, 'r');
      const stat = fstatSync(fd);
      identity = `${stat.dev}:${stat.ino}`;
      lastSeenSize = stat.size;
      offset = startAtEnd ? stat.size : 0;
      partial = '';
      decoder = new StringDecoder('utf8');
      captureHead(fd, stat.size);
    } catch {
      identity = null;
      lastSeenSize = 0;
      resetCursor();
    } finally {
      if (fd != null) closeSync(fd);
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    syncOffset();
    attachWatcher();
    if (reconcileMs > 0) {
      reconcileTimer = setInterval(reconcile, reconcileMs);
      reconcileTimer.unref?.();
    }
  }

  function reconcile() {
    if (stopped) return;
    readNewBytes();
    attachWatcher();
  }

  function stop() {
    stopped = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    closeWatcher();
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
    join(runtimeRoot, 'data', 'channel', 'inbound', 'pending'),
    join(runtimeRoot, 'data', 'channel', 'inbound', 'processed'),
    join(runtimeRoot, 'data', 'channel', 'inbound', 'failed'),
    join(runtimeRoot, 'data', 'channel', 'outbox', 'pending'),
    join(runtimeRoot, 'data', 'channel', 'outbox', 'sent'),
    join(runtimeRoot, 'data', 'channel', 'outbox', 'failed'),
  ];
  if (includeOperator) {
    paths.push(
      join(runtimeRoot, 'data', 'evolution', 'operator_briefs', 'pending'),
      join(runtimeRoot, 'data', 'evolution', 'operator_facts', 'pending'),
      join(runtimeRoot, 'data', 'evolution', 'operator_questions', 'pending'),
    );
  }
  if (includeDesktopSessions) {
    paths.push(join(runtimeRoot, 'data', 'channel', 'desktop', 'sessions'));
  }
  if (projectRoot && watchSubjectsJson) {
    paths.push(join(dirname(runtimeRoot), 'registry.json'));
    paths.push(join(projectRoot, 'policies', 'subjects.json'));
  }
  return paths;
}

function nearestExisting(target) {
  let candidate = target;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

export function resolveWatchPath(target) {
  const existing = nearestExisting(target);
  if (!existing) return null;
  const stat = safeStat(existing);
  if (stat?.isFile()) return dirname(existing);
  return existing;
}

export function classifyRuntimeWatchPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('/channel/desktop/sessions') || normalized.includes('/conversation')) {
    return 'conversation';
  }
  if (normalized.includes('/channel/') || normalized.endsWith('/channel')) return 'channel';
  if (
    normalized.endsWith('worker-state.json')
    || normalized.endsWith('pending_tasks.json')
    || normalized.includes('/daemon/')
  ) {
    return 'service';
  }
  if (
    normalized.includes('/evolution/')
    || normalized.includes('cycle-state')
    || normalized.includes('operator_')
    || normalized.includes('current-state.json')
    || normalized.includes('subjects.json')
    || normalized.includes('registry.json')
  ) {
    return 'evolution';
  }
  return null;
}

export function classifyRuntimeWatchName(filename, watchedPath = '') {
  const fromName = filename ? classifyRuntimeWatchPath(String(filename)) : null;
  if (fromName) return fromName;
  const fromPath = classifyRuntimeWatchPath(watchedPath);
  if (fromPath) return fromPath;
  return 'all';
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
  const watchersByPath = new Map();
  let debounceTimer = null;
  let reconcileTimer = null;
  let started = false;
  let pendingPartitions = new Set();

  function notify(reason = 'watch', partition = 'all') {
    if (!started) return;
    pendingPartitions.add(partition || 'all');
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const partitions = [...pendingPartitions];
      pendingPartitions = new Set();
      const event = { reason, subjectMeta, partitions };
      onRuntimeChange?.(event);
      onNotify?.(event);
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function closeEntry(path) {
    const current = watchersByPath.get(path);
    if (!current) return;
    try {
      current.watcher.close();
    } catch {
      // Ignore replacement races.
    }
    watchersByPath.delete(path);
  }

  function reconcileWatchers() {
    const desired = new Map();
    for (const target of paths) {
      const watchedPath = resolveWatchPath(target);
      if (!watchedPath) continue;
      const stat = safeStat(watchedPath);
      const identity = stat ? `${stat.dev}:${stat.ino}` : null;
      const entry = desired.get(watchedPath) ?? { identity, targets: new Set() };
      entry.targets.add(target);
      desired.set(watchedPath, entry);
    }

    for (const [path, current] of watchersByPath) {
      const next = desired.get(path);
      if (!next || current.identity !== next.identity) closeEntry(path);
    }

    for (const [path, next] of desired) {
      const current = watchersByPath.get(path);
      if (current) {
        current.targets = next.targets;
        continue;
      }
      try {
        watchersByPath.set(path, {
          identity: next.identity,
          targets: next.targets,
          watcher: watchFactory(path, (_eventType, filename) => {
            reconcileWatchers();
            notify('watch', classifyRuntimeWatchName(filename, path));
          }),
        });
      } catch {
        // Missing and transiently replaced files are covered by reconciliation.
      }
    }
  }

  function reconcile(reason = 'reconcile') {
    if (!started) return;
    reconcileWatchers();
    notify(reason);
  }

  function start() {
    if (started) return;
    started = true;
    reconcileWatchers();
    if (reconcileMs > 0) {
      reconcileTimer = setInterval(() => reconcile('reconcile'), reconcileMs);
      reconcileTimer.unref?.();
    }
  }

  function stop() {
    started = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const path of [...watchersByPath.keys()]) closeEntry(path);
  }

  return {
    paths,
    start,
    stop,
    notify,
    reconcile,
    getWatchedPaths: () => [...watchersByPath.keys()],
  };
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
