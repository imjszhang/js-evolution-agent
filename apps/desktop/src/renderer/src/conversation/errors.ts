import { isPublicClientError } from '../../../client-api/errors'

export type ConversationErrorKind =
  | 'desktop_disabled'
  | 'web_rejected'
  | 'unavailable'
  | 'daemon_unhealthy'
  | 'model_unavailable'
  | 'channel_attached'
  | 'channel_stale'
  | 'early_exit'
  | 'startup_timeout'
  | 'conflict'
  | 'failed'

export interface ConversationErrorView {
  kind: ConversationErrorKind
  code: string | null
  message: string
}

export function classifyClientError(
  error: unknown,
  fallback = 'Unable to complete the conversation request.'
): ConversationErrorView {
  const message = error instanceof Error && error.message ? error.message : fallback
  const code = isPublicClientError(error) ? error.code : null

  if (code === 'COMMAND_NOT_ALLOWED') {
    return { kind: 'web_rejected', code, message }
  }
  if (/external daemon is already running/i.test(message)) {
    return { kind: 'channel_attached', code, message }
  }
  if (/live worker is still present|cannot be replaced safely|heartbeat is stale/i.test(message)) {
    return { kind: 'channel_stale', code, message }
  }
  if (/exited before becoming ready/i.test(message)) {
    return { kind: 'early_exit', code, message }
  }
  if (/startup timeout|did not become ready before the startup timeout/i.test(message)) {
    return { kind: 'startup_timeout', code, message }
  }
  if (code === 'UNAVAILABLE') {
    return { kind: 'unavailable', code, message }
  }
  if (code === 'CONFLICT' || /disabled/i.test(message)) {
    return {
      kind: /disabled/i.test(message) ? 'desktop_disabled' : 'conflict',
      code,
      message
    }
  }
  if (/unhealthy|offline|not running|stopped/i.test(message)) {
    return { kind: 'daemon_unhealthy', code, message }
  }
  if (/model|deepseek|unset/i.test(message)) {
    return { kind: 'model_unavailable', code, message }
  }
  return { kind: 'failed', code, message }
}
