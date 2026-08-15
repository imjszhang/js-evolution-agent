import { randomUUID } from 'node:crypto';
import { writePendingInbound } from '../../state.mjs';
import { listJsonFiles, readJsonFile } from '../../state.mjs';
import {
  channelInboundFailedDir,
  channelInboundPendingDir,
  channelInboundProcessedDir,
} from '../../paths.mjs';
import { normalizeOutboundMessage, nowIso } from '../../types.mjs';
import { enqueueClassifierIfPendingInbound } from '../../wake.mjs';
import {
  desktopTarget,
  resolveDesktopConfig,
  sessionIdFromDesktopTarget,
} from './config.mjs';
import { normalizeDesktopInboundPayload } from './parser.mjs';
import {
  appendDesktopSessionRecord,
  listDesktopSessions,
  readDesktopSession,
  withDesktopIngressLock,
} from './session-store.mjs';

export {
  desktopConfigForApi,
  desktopTarget,
  normalizeDesktopSessionId,
  resolveDesktopConfig,
  sessionIdFromDesktopTarget,
} from './config.mjs';
export { normalizeDesktopInboundPayload } from './parser.mjs';
export {
  appendDesktopSessionRecord,
  DESKTOP_SESSION_SCHEMA_VERSION,
  listDesktopSessions,
  readDesktopSession,
  withDesktopIngressLock,
} from './session-store.mjs';

export async function sendOutboundMessage(outboundInput, options = {}) {
  const outbound = normalizeOutboundMessage(outboundInput);
  const root = options.root ?? process.cwd();
  const subject = options.subject ?? outbound.subject ?? process.env.JEA_SUBJECT ?? 'default';
  const config = options.config ?? resolveDesktopConfig(root, subject);
  if (!config.enabled) throw new Error(`Desktop channel is disabled for subject ${subject}`);
  const sessionId = sessionIdFromDesktopTarget(outbound.target);
  const stableId = outbound.id
    ?? (outbound.idempotency_key ? `outbound:${outbound.idempotency_key}` : null);
  const appended = appendDesktopSessionRecord(root, subject, sessionId, {
    id: stableId,
    message_id: outbound.id ?? null,
    idempotency_key: outbound.idempotency_key,
    direction: 'outbound',
    role: 'assistant',
    content: outbound.text,
    content_type: outbound.document ? 'document' : (outbound.card ? 'card' : 'text'),
    created_at: outbound.created_at,
    reply_to_message_id: outbound.reply_to_message_id,
    metadata: outbound.metadata,
  });
  return {
    messageId: appended.record.id,
    chatId: desktopTarget(sessionId),
    sessionId,
    offset: appended.record.offset,
    duplicate: appended.duplicate,
    local: true,
  };
}

function inboundExists(root, subject, messageId) {
  for (const dir of [
    channelInboundPendingDir(root, subject),
    channelInboundProcessedDir(root, subject),
    channelInboundFailedDir(root, subject),
  ]) {
    for (const file of listJsonFiles(dir)) {
      const payload = readJsonFile(file, null);
      const existingId = payload?.message_id
        ?? payload?.messageId
        ?? payload?.envelope?.message_id
        ?? null;
      if (String(existingId ?? '') === String(messageId)) return true;
    }
  }
  return false;
}

export function sendDesktopInboundMessage(root, subject, {
  session_id = null,
  session = null,
  message_id = null,
  id = null,
  text = '',
  content = null,
  sender_id = 'desktop-user',
  created_at = null,
  metadata = {},
} = {}, {
  writeInbound = writePendingInbound,
  enqueueClassifier = enqueueClassifierIfPendingInbound,
} = {}) {
  const config = resolveDesktopConfig(root, subject);
  if (!config.enabled) throw new Error(`Desktop channel is disabled for subject ${subject}`);
  const resolvedSession = session_id ?? session ?? config.defaultSession;
  const messageId = String(message_id ?? id ?? `desktop-${randomUUID()}`);
  const envelope = normalizeDesktopInboundPayload({
    message_id: messageId,
    session_id: resolvedSession,
    sender_id,
    content: content ?? text,
    received_at: created_at ?? nowIso(),
    metadata,
  });
  const appended = appendDesktopSessionRecord(root, subject, resolvedSession, {
    id: `inbound:${messageId}`,
    message_id: messageId,
    direction: 'inbound',
    role: 'user',
    content: envelope.content,
    content_type: envelope.content_type,
    created_at: envelope.received_at,
    metadata,
  });
  const ingress = withDesktopIngressLock(root, subject, messageId, () => {
    const alreadyQueued = inboundExists(root, subject, messageId);
    if (alreadyQueued) {
      return {
        pending: null,
        classifier: { created: false, reason: 'inbound_already_queued' },
        repaired: false,
      };
    }
    const pending = writeInbound(root, subject, envelope, { label: 'desktop' });
    return {
      pending,
      classifier: enqueueClassifier(root, subject),
      repaired: appended.duplicate,
    };
  });
  return {
    subject,
    session_id: resolvedSession,
    target: desktopTarget(resolvedSession),
    message_id: messageId,
    session_record: appended.record,
    session_created: appended.created,
    duplicate: appended.duplicate,
    ingress_repaired: ingress.repaired,
    inbound_file: ingress.pending?.file ?? null,
    classifier_task: ingress.classifier.task ?? null,
    classifier_created: ingress.classifier.created ?? false,
    classifier_reason: ingress.classifier.reason ?? null,
  };
}
