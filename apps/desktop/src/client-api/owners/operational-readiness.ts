/**
 * Diagnostics consume service.getReadiness (#138) as the single operational
 * readiness source. The leftover projector is only a no-subject fallback.
 */
import type { ServiceStatus, SetupReadiness, SubjectReadiness } from '../types'
import { SUBJECT_READINESS_REASON_CODES } from '../readiness'

export const OPERATIONAL_READINESS_SEAM = {
  issue: 138,
  reservedCommand: 'service.getReadiness',
  source: 'service.getReadiness',
} as const

export type OperationalDomainId = 'web' | 'cycle' | 'channel' | 'model' | 'conversation'
export type OperationalDomainStatus =
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'stopped'
  | 'unavailable'
  | 'stale'
  | 'zombie'
  | 'attached'

export interface OperationalDomainReadiness {
  id: OperationalDomainId
  status: OperationalDomainStatus
  reasons: string[]
}

export interface OperationalReadinessProjection {
  source: typeof OPERATIONAL_READINESS_SEAM.source
  reservedCommand: typeof OPERATIONAL_READINESS_SEAM.reservedCommand
  web: OperationalDomainReadiness
  cycle: OperationalDomainReadiness
  channel: OperationalDomainReadiness
  model: OperationalDomainReadiness
  conversation: OperationalDomainReadiness
}

export interface OperationalReadinessInput {
  setup: SetupReadiness
  service?: ServiceStatus | null
  web?: { running?: boolean } | null
  cycle?: {
    running?: boolean
    stale?: boolean
    zombie?: boolean
    health?: string | null
    reasons?: string[]
  } | null
  channel?: {
    running?: boolean
    stale?: boolean
    zombie?: boolean
    health?: string | null
    reasons?: string[]
  } | null
}

const TOP_REASON_LIMIT = 3

function reasonsOf(...groups: Array<string[] | undefined | null>): string[] {
  const out: string[] = []
  for (const group of groups) {
    for (const item of group ?? []) {
      const reason = String(item || '').trim()
      if (
        reason
        && SUBJECT_READINESS_REASON_CODES.includes(reason as SubjectReadiness['reasons'][number])
        && !out.includes(reason)
      ) out.push(reason)
      if (out.length >= TOP_REASON_LIMIT) return out
    }
  }
  return out
}

function domain(
  id: OperationalDomainId,
  status: OperationalDomainStatus,
  ...reasonGroups: Array<string[] | undefined | null>
): OperationalDomainReadiness {
  const reasons = reasonsOf(...reasonGroups)
  if (reasons.length === 0) reasons.push(fallbackDomainReason(id, status))
  return { id, status, reasons }
}

function fallbackDomainReason(
  id: OperationalDomainId,
  status: OperationalDomainStatus
): SubjectReadiness['reasons'][number] {
  if (id === 'web') {
    if (status === 'ready' || status === 'attached') return 'web_host_running'
    if (status === 'stopped') return 'web_host_stopped'
    if (status === 'zombie') return 'web_host_zombie'
    return 'web_host_unavailable'
  }
  if (id === 'cycle' || id === 'channel') {
    return fallbackProcessReason(id, status) as SubjectReadiness['reasons'][number]
  }
  if (id === 'model') return status === 'ready' ? 'model_ready' : 'model_unset'
  return status === 'ready' ? 'conversation_ready' : 'conversation_blocked_setup'
}

function mapDomainState(state: string): OperationalDomainStatus {
  switch (state) {
    case 'running':
    case 'starting':
      return 'ready'
    case 'stopping':
    case 'stalled':
      return 'degraded'
    case 'attached':
      return 'attached'
    case 'blocked':
      return 'blocked'
    case 'stopped':
      return 'stopped'
    case 'unavailable':
      return 'unavailable'
    case 'stale':
      return 'stale'
    case 'zombie':
      return 'zombie'
    default:
      return 'unavailable'
  }
}

function fallbackProcessReason(
  domainId: 'cycle' | 'channel',
  status: OperationalDomainStatus
): string {
  if (status === 'ready') return `${domainId}_running`
  if (status === 'degraded') return domainId === 'cycle' ? 'cycle_stalled' : 'channel_blocked'
  return `${domainId}_${status}`
}

export function fromSubjectReadiness(readiness: SubjectReadiness): OperationalReadinessProjection {
  return {
    source: OPERATIONAL_READINESS_SEAM.source,
    reservedCommand: OPERATIONAL_READINESS_SEAM.reservedCommand,
    web: domain('web', mapDomainState(readiness.web_host.state), readiness.web_host.reasons),
    cycle: domain('cycle', mapDomainState(readiness.cycle.state), readiness.cycle.reasons),
    channel: domain('channel', mapDomainState(readiness.channel.state), readiness.channel.reasons),
    model: domain('model', mapDomainState(readiness.model.state), readiness.model.reasons),
    conversation: domain(
      'conversation',
      mapDomainState(readiness.conversation.state),
      readiness.conversation.reasons
    ),
  }
}

export function projectOperationalReadiness(input: OperationalReadinessInput): OperationalReadinessProjection {
  const setup = input.setup
  const webRunning = input.web?.running === true
  const cycle = input.cycle
  const channel = input.channel
  const service = input.service

  let cycleStatus: OperationalDomainStatus = 'stopped'
  if (cycle?.zombie) cycleStatus = 'zombie'
  else if (cycle?.stale) cycleStatus = 'stale'
  else if (cycle?.running) cycleStatus = cycle.health && cycle.health !== 'healthy' && cycle.health !== 'idle'
    ? 'degraded'
    : 'ready'
  else if (service?.mode === 'attached') cycleStatus = 'attached'
  else if (service?.mode === 'managed') cycleStatus = 'ready'
  else if (!setup.subjects.defaultSubject) cycleStatus = 'unavailable'

  let channelStatus: OperationalDomainStatus = 'stopped'
  if (channel?.zombie) channelStatus = 'zombie'
  else if (channel?.stale) channelStatus = 'stale'
  else if (channel?.running) channelStatus = channel.health && channel.health !== 'healthy' && channel.health !== 'idle'
    ? 'degraded'
    : 'ready'
  else if (!setup.conversation.desktopChannelEnabled) channelStatus = 'blocked'

  const conversationReasons: string[] = []
  if (!setup.conversation.desktopChannelEnabled) {
    conversationReasons.push('conversation_blocked_channel', 'desktop_channel_disabled')
  }
  if (setup.model.mode === 'unset') conversationReasons.push('conversation_blocked_model')
  if (setup.conversationReady) conversationReasons.push('conversation_ready')
  if (!setup.conversationReady) {
    if (!setup.jeaHome.writable) conversationReasons.push('home_unwritable')
    if (!setup.subjects.defaultSubject) conversationReasons.push('subject_missing')
    if (!setup.data.initialized) conversationReasons.push('data_uninitialized')
    if (conversationReasons.length === 0) conversationReasons.push('conversation_blocked_setup')
  }

  const modelReasons = [setup.model.mode === 'deepseek' && setup.model.configured
    ? 'model_ready'
    : setup.model.mode === 'unset'
      ? 'model_unset'
      : 'model_mock']

  return {
    source: OPERATIONAL_READINESS_SEAM.source,
    reservedCommand: OPERATIONAL_READINESS_SEAM.reservedCommand,
    web: domain(
      'web',
      webRunning ? 'ready' : 'stopped',
      [webRunning ? 'web_host_running' : 'web_host_stopped']
    ),
    cycle: domain(
      'cycle',
      cycleStatus,
      cycle?.reasons,
      [fallbackProcessReason('cycle', cycleStatus)]
    ),
    channel: domain(
      'channel',
      channelStatus,
      channel?.reasons,
      [fallbackProcessReason('channel', channelStatus)]
    ),
    model: domain(
      'model',
      setup.model.mode === 'unset' ? 'blocked' : 'ready',
      modelReasons
    ),
    conversation: domain(
      'conversation',
      setup.conversationReady ? 'ready' : 'blocked',
      conversationReasons
    ),
  }
}
