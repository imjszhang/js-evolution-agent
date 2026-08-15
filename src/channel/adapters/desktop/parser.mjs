import { normalizeChannelEnvelope, nowIso } from '../../types.mjs';
import {
  desktopTarget,
  normalizeDesktopSessionId,
  sessionIdFromDesktopTarget,
} from './config.mjs';

export function normalizeDesktopInboundPayload(payload = {}) {
  const sessionId = normalizeDesktopSessionId(
    payload.session_id
      ?? payload.sessionId
      ?? (String(payload.chat_id ?? '').startsWith('desktop:')
        ? sessionIdFromDesktopTarget(payload.chat_id)
        : null)
      ?? 'main',
  );
  return normalizeChannelEnvelope({
    ...payload,
    channel: 'desktop',
    adapter: 'desktop',
    direction: 'inbound',
    chat_id: desktopTarget(sessionId),
    chat_type: payload.chat_type ?? 'session',
    sender_id: payload.sender_id ?? 'desktop-user',
    content: payload.content ?? payload.text ?? '',
    content_type: payload.content_type ?? 'text',
    received_at: payload.received_at ?? nowIso(),
    metadata: {
      ...(payload.metadata ?? {}),
      session_id: sessionId,
    },
  });
}
