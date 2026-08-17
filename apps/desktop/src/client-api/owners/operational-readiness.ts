/**
 * Diagnostics consume service.getReadiness (#138) as the single operational
 * readiness source. The leftover projector is only a no-subject fallback.
 */
import type { ServiceStatus, SetupReadiness, SubjectReadiness } from '../types'

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
      if (reason && !out.includes(reason)) out.push(reason)
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
  return { id, status, reasons: reasonsOf(...reasonGroups) }
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
  if (!setup.jeaHome.writable) conversationReasons.push('jea_home_not_writable')
  if (setup.subjects.count === 0) conversationReasons.push('no_subject')
  if (!setup.data.initialized) conversationReasons.push('data_not_initialized')
  if (!setup.conversation.desktopChannelEnabled) conversationReasons.push('desktop_channel_disabled')
  if (setup.conversationReady) conversationReasons.push('conversation_ready')

  const modelReasons = [
    setup.model.configured ? 'model_configured' : 'model_unconfigured',
    `model_mode_${setup.model.mode}`,
  ]

  return {
    source: OPERATIONAL_READINESS_SEAM.source,
    reservedCommand: OPERATIONAL_READINESS_SEAM.reservedCommand,
    web: domain(
      'web',
      webRunning ? 'ready' : 'stopped',
      [webRunning ? 'web_host_running' : 'web_host_stopped']
    ),
    cycle: domain('cycle', cycleStatus, cycle?.reasons, cycleStatus === 'stopped' ? ['cycle_worker_stopped'] : []),
    channel: domain(
      'channel',
      channelStatus,
      channel?.reasons,
      channelStatus === 'stopped' ? ['channel_worker_stopped'] : []
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
