import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  listDesktopSessions,
  normalizeDesktopSessionId,
  readDesktopSession,
  sendDesktopInboundMessage
} from '../../../../../src/channel/adapters/desktop/index.mjs'
import { channelDesktopSessionPath } from '../../../../../src/channel/paths.mjs'
import { buildChannelProjection } from '../../../../../src/channel/projection.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type {
  ChannelProjectionHealth,
  ConversationPage,
  ConversationPipelineState,
  ConversationSendResult,
  ConversationSessionSummary
} from '../types'
import { requireSubject, type ClientRuntimeContext } from './runtime'

export function channelProjectionHealth(
  runtime: ClientRuntimeContext,
  subject: string
): ChannelProjectionHealth {
  const projection = buildChannelProjection(runtime, subject, { eventLimit: 0 }) as {
    health?: { status?: string; ok?: boolean; reasons?: unknown }
  }
  const reasons = Array.isArray(projection.health?.reasons)
    ? projection.health.reasons.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  return {
    status: String(projection.health?.status ?? 'idle'),
    ok: projection.health?.ok !== false,
    reasons
  }
}

function conversationPipelineState(
  projection: Record<string, any>,
  sessionId: string
): ConversationPipelineState {
  const pipeline = projection.presence?.delivery_pipeline ?? {}
  const target = `desktop:${sessionId}`
  const scoped = [
    ...(Array.isArray(pipeline.pending) ? pipeline.pending : []),
    ...(Array.isArray(pipeline.failed) ? pipeline.failed : []),
    ...(Array.isArray(pipeline.delivered) ? pipeline.delivered : [])
  ].filter((item) => item?.transport === 'desktop' && item?.target === target)
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
  const latest = scoped[0] ?? null
  return {
    status: latest?.status === 'pending' || latest?.status === 'claimed' || latest?.status === 'queued'
      ? 'pending'
      : latest?.status === 'failed'
        ? 'failed'
        : latest?.status === 'delivered'
          ? 'delivered'
          : 'idle',
    message_id: typeof latest?.message_id === 'string' ? latest.message_id : null,
    pending_count: scoped.filter((item) => (
      item.status === 'pending' || item.status === 'claimed' || item.status === 'queued'
    )).length,
    failed_count: scoped.filter((item) => item.status === 'failed').length,
    last_error: typeof latest?.last_error === 'string' ? latest.last_error : null
  }
}

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
    const page = redactPublicValue((readDesktopSession as (...args: unknown[]) => ConversationPage)(
      this.runtime,
      name,
      sessionId,
      options
    ))
    const projection = buildChannelProjection(this.runtime, name, { eventLimit: 0 }) as Record<string, any>
    const health = projection.health ?? {}
    return {
      ...page,
      channel_health: {
        status: String(health.status ?? 'idle'),
        ok: health.ok !== false,
        reasons: Array.isArray(health.reasons)
          ? health.reasons.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
          : []
      },
      pipeline_state: conversationPipelineState(projection, sessionId)
    }
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
      const result = (sendDesktopInboundMessage as (...args: unknown[]) => Record<string, unknown>)(
        this.runtime,
        name,
        {
          session_id: options.sessionId,
          text: text.trim(),
          message_id: options.messageId,
          metadata: { source: 'jea_client' }
        }
      )
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
