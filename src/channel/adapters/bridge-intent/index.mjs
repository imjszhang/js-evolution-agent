import { mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSubjectEntry } from '../../../cli/utils/subjects.mjs';
import { runtimeForSubject } from '../../../cli/utils/evolve-runs.mjs';
import { writeJsonFile } from '../../../cli/utils/files.mjs';
import { normalizeOutboundMessage, nowIso } from '../../types.mjs';

function safeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function bridgeConfig(root, subject) {
  const entry = getSubjectEntry(root, subject);
  return entry?.channels?.['bridge-intent']
    ?? entry?.channels?.openclaw
    ?? {};
}

export function bridgeIntentDir(root, subject, cfg = bridgeConfig(root, subject)) {
  const { dataRoot } = runtimeForSubject(root, subject);
  const configured = cfg.intents_dir ?? cfg.intentsDir ?? null;
  if (!configured) return join(dataRoot, 'bridge', 'openclaw', 'intents');
  const value = String(configured);
  return isAbsolute(value) ? value : resolve(dataRoot, value);
}

export async function sendOutboundMessage(outbound, options = {}) {
  const root = options.root ?? process.cwd();
  const subject = options.subject ?? outbound.subject ?? process.env.JEA_SUBJECT ?? 'default';
  const cfg = options.cfg ?? bridgeConfig(root, subject);
  const message = normalizeOutboundMessage(outbound);
  const baseDir = bridgeIntentDir(root, subject, cfg);
  const pendingDir = join(baseDir, 'pending');
  mkdirSync(pendingDir, { recursive: true });

  const intentId = message.idempotency_key
    ?? message.id
    ?? `bridge-intent-${randomUUID()}`;
  const file = join(
    pendingDir,
    `${timestampForFilename()}-${safeFilenamePart(intentId)}.json`,
  );
  const record = {
    schema_version: 1,
    type: 'channel_outbound_intent',
    intent_id: intentId,
    generated_at: nowIso(),
    subject,
    target: message.target,
    channel: message.channel,
    outbound: message,
    metadata: {
      ...(message.metadata ?? {}),
      bridge: 'openclaw',
    },
  };
  writeJsonFile(file, record);
  return {
    messageId: basename(file, '.json'),
    bridge: 'openclaw',
    intentFile: file,
    intentId,
  };
}
