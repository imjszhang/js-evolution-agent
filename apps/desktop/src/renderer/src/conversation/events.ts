import type { JeaEventEnvelope } from '../../../client-api/types'

const CONVERSATION_EVENTS = new Set([
  'conversation.updated'
])

/** Channel health is not a message event; do not treat it as a session read trigger. */

const SUBJECT_EVENTS = new Set([
  'subject.changed'
])

const SERVICE_EVENTS = new Set([
  'service.status',
  'projection.ops_updated'
])

const EVOLUTION_EVENTS = new Set([
  'evolution.updated',
  'projection.todo_updated'
])

const STALE_EVENTS = new Set([
  'projection.refresh_failed'
])

export function eventSubject(event: JeaEventEnvelope): string | null {
  if (typeof event.subject === 'string' && event.subject.trim()) return event.subject
  const payloadSubject = event.payload?.subject
  return typeof payloadSubject === 'string' && payloadSubject.trim() ? payloadSubject : null
}

export function eventSessionId(event: JeaEventEnvelope): string | null {
  if (typeof event.session_id === 'string' && event.session_id.trim()) return event.session_id
  const payloadSession = event.payload?.session_id
  return typeof payloadSession === 'string' && payloadSession.trim() ? payloadSession : null
}

export function isEventForContext(
  event: JeaEventEnvelope,
  subject: string | null,
  sessionId: string | null
): boolean {
  const nextSubject = eventSubject(event)
  if (nextSubject && subject && nextSubject !== subject) return false
  const nextSession = eventSessionId(event)
  if (nextSession && sessionId && nextSession !== sessionId) return false
  return true
}

export function isConversationEvent(event: JeaEventEnvelope): boolean {
  return CONVERSATION_EVENTS.has(event.type)
}

export function isSubjectEvent(event: JeaEventEnvelope): boolean {
  return SUBJECT_EVENTS.has(event.type)
}

export function isServiceEvent(event: JeaEventEnvelope): boolean {
  return SERVICE_EVENTS.has(event.type)
}

export function isEvolutionEvent(event: JeaEventEnvelope): boolean {
  return EVOLUTION_EVENTS.has(event.type)
}

export function isStaleProjectionEvent(event: JeaEventEnvelope): boolean {
  if (STALE_EVENTS.has(event.type)) return true
  return event.payload?.stale === true && (
    event.type === 'evolution.updated'
    || event.type === 'service.status'
    || event.type === 'projection.ops_updated'
    || event.type === 'projection.todo_updated'
    || event.type === 'projection.channel_updated'
  )
}
