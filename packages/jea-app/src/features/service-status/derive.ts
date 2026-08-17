import type { ProductEventEnvelope, ProductHostKind, SubjectReadiness } from '../client-types'
import type { ServiceStatusKind } from '../../slots/types'

const ATTENTION_STATES = new Set(['zombie', 'stale', 'stalled', 'blocked', 'unavailable'])

const SERVICE_READINESS_REFRESH_EVENTS = new Set([
  'service.status',
  'projection.ops_updated',
  'projection.channel_updated',
  'evolution.updated',
  'subject.changed'
])

export function needsOpenDesktop(readiness: SubjectReadiness | null | undefined): boolean {
  return Boolean(readiness?.allowed_actions?.includes('open_desktop'))
}

export function webHostStoppedIsNotOutage(
  readiness: SubjectReadiness | null | undefined,
  host: ProductHostKind
): boolean {
  if (!readiness || host !== 'electron') return false
  return readiness.web_host.state === 'stopped' || readiness.web_host.reasons.includes('web_host_stopped')
}

export function deriveServiceStatusKind(
  readiness: SubjectReadiness | null | undefined,
  {
    host,
    connection
  }: {
    host: ProductHostKind
    connection?: 'online' | 'offline' | null
  }
): ServiceStatusKind {
  if (host === 'web' && connection === 'offline') return 'offline'
  if (!readiness) return 'online'

  const domains = [readiness.cycle, readiness.channel, readiness.model, readiness.conversation]
  if (host === 'web') domains.push(readiness.web_host)
  else if (readiness.web_host.state === 'zombie') return 'degraded'

  if (domains.some((domain) => ATTENTION_STATES.has(domain.state))) return 'degraded'
  return 'online'
}

export function eventSubjectOf(
  event: Pick<ProductEventEnvelope, 'subject' | 'payload'> | null | undefined
): string | null {
  if (!event) return null
  if (typeof event.subject === 'string' && event.subject.trim()) return event.subject.trim()
  return typeof event.payload?.subject === 'string' && event.payload.subject.trim()
    ? event.payload.subject.trim()
    : null
}

export function shouldRefreshServiceReadiness(
  event: Pick<ProductEventEnvelope, 'type' | 'subject' | 'payload'> | null | undefined,
  subject: string | null | undefined
): boolean {
  if (!event || !SERVICE_READINESS_REFRESH_EVENTS.has(event.type)) return false
  const name = subject?.trim() || null
  const eventSubject = eventSubjectOf(event)
  if (eventSubject && name && eventSubject !== name) return false
  return true
}
