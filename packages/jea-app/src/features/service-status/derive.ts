import type { ProductHostKind, SubjectReadiness } from '../client-types'
import type { ServiceStatusKind } from '../../slots/types'

const ATTENTION_STATES = new Set(['zombie', 'stale', 'stalled', 'blocked', 'unavailable'])

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
