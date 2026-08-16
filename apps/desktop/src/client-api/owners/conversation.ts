import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  listDesktopSessions,
  normalizeDesktopSessionId,
  readDesktopSession,
  sendDesktopInboundMessage
} from '../../../../../src/channel/adapters/desktop/index.mjs'
import { channelDesktopSessionPath } from '../../../../../src/channel/paths.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type { ConversationPage, ConversationSendResult, ConversationSessionSummary } from '../types'
import { requireSubject, type ClientRuntimeContext } from './runtime'

export class ConversationCommandOwner {
  constructor(private readonly runtime: ClientRuntimeContext) {}

  listSessions(subject: string): ConversationSessionSummary[] {
    const name = requireSubject(this.runtime, subject)
    return redactPublicValue(listDesktopSessions(this.runtime, name) as ConversationSessionSummary[])
  }

  createSession(subject: string, sessionId?: string): ConversationSessionSummary {
    const name = requireSubject(this.runtime, subject)
    let normalized: string
    try {
      normalized = normalizeDesktopSessionId(sessionId ?? `session-${Date.now()}`)
    } catch {
      throw new PublicClientError('INVALID_REQUEST', 'A valid sessionId is required.')
    }
    const file = channelDesktopSessionPath(this.runtime, name, normalized)
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) appendFileSync(file, '', 'utf8')
    const sessions = this.listSessions(name)
    return sessions.find((item) => item.session_id === normalized) ?? {
      session_id: normalized,
      target: `desktop:${normalized}`,
      message_count: 0,
      last_message_at: null
    }
  }

  readMessages(
    subject: string,
    sessionId: string,
    options: { offset?: number; limit?: number; tail?: number | null } = {}
  ): ConversationPage {
    const name = requireSubject(this.runtime, subject)
    if (!sessionId?.trim()) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid sessionId is required.')
    }
    return redactPublicValue(readDesktopSession(this.runtime, name, sessionId, options) as ConversationPage)
  }

  sendMessage(
    subject: string,
    text: string,
    options: { sessionId?: string; messageId?: string } = {}
  ): ConversationSendResult {
    const name = requireSubject(this.runtime, subject)
    if (!text?.trim()) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid text is required.')
    }
    try {
      const result = sendDesktopInboundMessage(this.runtime, name, {
        session_id: options.sessionId,
        text: text.trim(),
        message_id: options.messageId,
        metadata: { source: 'jea_client' }
      }) as Record<string, unknown>
      return redactPublicValue({
        subject: name,
        session_id: String(result.session_id),
        message_id: String(result.message_id),
        session_created: Boolean(result.session_created),
        duplicate: Boolean(result.duplicate)
      })
    } catch (error) {
      const message = String(error)
      if (message.includes('disabled')) {
        throw new PublicClientError('CONFLICT', 'Desktop Channel is disabled for this subject.')
      }
      if (message.includes('already belongs to session')) {
        throw new PublicClientError('CONFLICT', 'This message already belongs to another desktop session.')
      }
      if (message.includes('session id')) {
        throw new PublicClientError('INVALID_REQUEST', 'A valid sessionId is required.')
      }
      throw error
    }
  }
}
