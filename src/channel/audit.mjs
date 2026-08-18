import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { channelEventsPath } from './paths.mjs';
import { nowIso } from './types.mjs';

export const CHANNEL_EVENT_TAIL_CHUNK_BYTES = 64 * 1024;

export function recordChannelEvent(root, subject, event = {}) {
  const file = channelEventsPath(root, subject);
  mkdirSync(dirname(file), { recursive: true });
  const record = {
    id: event.id ?? `channel-event-${randomUUID()}`,
    subject,
    recorded_at: nowIso(),
    ...event,
  };
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

function pushParsedLine(buffer, collected, want) {
  if (collected.length >= want || buffer.length === 0) return;
  const text = buffer.toString('utf8').trim();
  if (!text) return;
  try {
    collected.push(JSON.parse(text));
  } catch {
    // skip malformed lines
  }
}

export function readJsonlTail(filePath, { limit = 20, chunkBytes = CHANNEL_EVENT_TAIL_CHUNK_BYTES } = {}) {
  const want = Math.max(0, Math.floor(Number(limit)));
  if (!Number.isFinite(want) || want === 0) return [];
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = fstatSync(fd);
    if (size <= 0) return [];
    const cap = Math.max(1, Number(chunkBytes) || CHANNEL_EVENT_TAIL_CHUNK_BYTES);
    const NL = 0x0a;
    let pos = size;
    let carry = Buffer.alloc(0);
    const collected = [];
    while (pos > 0 && collected.length < want) {
      const n = Math.min(cap, pos);
      pos -= n;
      const chunk = Buffer.allocUnsafe(n);
      const read = readSync(fd, chunk, 0, n, pos);
      const buf = Buffer.concat([chunk.subarray(0, read), carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0; i -= 1) {
        if (buf[i] !== NL) continue;
        pushParsedLine(buf.subarray(i + 1, end), collected, want);
        end = i;
        if (collected.length >= want) break;
      }
      carry = buf.subarray(0, end);
    }
    if (collected.length < want) pushParsedLine(carry, collected, want);
    return collected;
  } finally {
    closeSync(fd);
  }
}

export function readChannelEvents(root, subject, { limit = 20 } = {}) {
  return readJsonlTail(channelEventsPath(root, subject), { limit });
}
