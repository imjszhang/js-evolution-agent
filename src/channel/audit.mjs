import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { channelEventsPath } from './paths.mjs';
import { nowIso } from './types.mjs';

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

export function readChannelEvents(root, subject, { limit = 20 } = {}) {
  const file = channelEventsPath(root, subject);
  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    return lines
      .filter(Boolean)
      .slice(-Math.max(0, limit))
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
