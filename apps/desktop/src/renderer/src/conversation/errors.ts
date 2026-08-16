import { isPublicClientError } from '../../../client-api/errors'

export type ConversationErrorKind =
  | 'desktop_disabled'
  | 'web_rejected'
  | 'unavailable'
  | 'daemon_unhealthy'
  | 'model_unavailable'
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
