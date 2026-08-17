import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessAlive } from '../../../../src/infra/process-alive.mjs'
import type {
  ClientHostKind,
  ConversationReadinessView,
  DomainReadiness,
  ModelReadinessView,
  RemediationAction,
  SubjectReadiness,
  SubjectReadinessActionId,
  SubjectReadinessDomainState,
  SubjectReadinessReasonCode
} from './types'
import {
  SUBJECT_READINESS_ACTION_IDS,
  SUBJECT_READINESS_DOMAIN_STATES,
  SUBJECT_READINESS_REASON_CODES
} from './types'

export const READINESS_ACTION_CAPABILITY: Record<SubjectReadinessActionId, RemediationAction['capability']> = {
  start_channel: 'local-only',
  start_cycle: 'local-only',
  process_cycle_once: 'write',
  repair_worker_state: 'local-only',
  stop_managed: 'local-only',
  open_desktop: 'readonly',
  none: 'readonly'
}

const LIVE_STATES = new Set<SubjectReadinessDomainState>(['running', 'attached', 'starting'])

export interface WorkerObservation {
  status?: string | null
  running?: boolean
  fresh?: boolean
  stale?: boolean
  zombie?: boolean
  pid_alive?: boolean
  pid?: number | null
  stop_requested_at?: string | null
}

export interface HealthObservation {
  status?: string | null
  ok?: boolean
}

export interface OwnershipObservation {
  mode?: string | null
  domain?: 'all' | 'cycle' | 'channel' | null
}

export interface WebHostObservation {
  running: boolean
  pid: number | null
}

export interface ReadinessProjectionInput {
  subject: string
  generatedAt: string
  hostKind: ClientHostKind
  webHost: WebHostObservation
  cycleWorker: WorkerObservation | null
  cycleHealth: HealthObservation | null
  channelWorker: WorkerObservation | null
  channelHealth: HealthObservation | null
  model: { configured: boolean; mode: 'deepseek' | 'mock' | 'unset' }
  desktopChannelEnabled: boolean
  ownership: OwnershipObservation
}

export function isSubjectReadinessDomainState(value: string): value is SubjectReadinessDomainState {
  return (SUBJECT_READINESS_DOMAIN_STATES as readonly string[]).includes(value)
}

export function isSubjectReadinessActionId(value: string): value is SubjectReadinessActionId {
  return (SUBJECT_READINESS_ACTION_IDS as readonly string[]).includes(value)
}

export function isSubjectReadinessReasonCode(value: string): value is SubjectReadinessReasonCode {
  return (SUBJECT_READINESS_REASON_CODES as readonly string[]).includes(value)
}

export function observeWebHost(jeaHome: string): WebHostObservation {
  const path = join(jeaHome, 'web-host', 'state.json')
  if (!existsSync(path)) {
    return { running: false, pid: null }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { running?: boolean; pid?: number | null }
    const pid = Number(parsed.pid)
    const alive = Number.isInteger(pid) && pid > 0 ? isProcessAlive(pid) : false
    return {
      running: alive,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null
    }
  } catch {
    return { running: false, pid: null }
  }
}

function uniqueCodes<T extends string>(codes: readonly T[]): T[] {
  return [...new Set(codes)]
}

function domainOwned(ownership: OwnershipObservation, domain: 'cycle' | 'channel'): boolean {
  if (ownership.mode !== 'managed' && ownership.mode !== 'stopping') return false
  return ownership.domain == null || ownership.domain === 'all' || ownership.domain === domain
}

function mapWebHost(observation: WebHostObservation): DomainReadiness {
  if (observation.running) {
    return { state: 'running', reasons: ['web_host_running'] }
  }
  if (observation.pid) {
    return { state: 'zombie', reasons: ['web_host_zombie'] }
  }
  return { state: 'stopped', reasons: ['web_host_stopped'] }
}

function mapModel(model: ReadinessProjectionInput['model']): ModelReadinessView {
  if (model.mode === 'deepseek' && model.configured) {
    return { state: 'running', mode: 'deepseek', reasons: ['model_ready'] }
  }
  if (model.mode === 'unset') {
    return { state: 'unavailable', mode: 'unset', reasons: ['model_unset'] }
  }
  return { state: 'running', mode: 'mock', reasons: ['model_mock'] }
}

function cycleStalled(health: HealthObservation | null): boolean {
  const status = health?.status ?? ''
  return status === 'reactor_backlog_stalled'
    || status === 'cycle_progress_stalled'
    || status === 'evolution_stalled'
    || status === 'stalled'
}

function mapProcessDomain(
  prefix: 'cycle' | 'channel',
  worker: WorkerObservation | null,
  health: HealthObservation | null,
  ownership: OwnershipObservation
): DomainReadiness {
  const owned = domainOwned(ownership, prefix)
  const running = Boolean(worker?.running)
  const pidAlive = worker?.pid_alive ?? (running || Boolean(worker?.pid && isProcessAlive(worker.pid)))
  const claimedActive = ['running', 'stopping', 'starting'].includes(String(worker?.status ?? ''))

  if (worker?.zombie || (claimedActive && worker?.fresh && !pidAlive)) {
    return { state: 'zombie', reasons: [`${prefix}_zombie`] }
  }
  if (worker?.stale || (claimedActive && !worker?.fresh && !pidAlive)) {
    return { state: 'stale', reasons: [`${prefix}_stale`] }
  }
  if (claimedActive && !pidAlive) {
    return { state: 'zombie', reasons: [`${prefix}_zombie`] }
  }

  if (owned && ownership.mode === 'stopping' && (running || worker?.status === 'stopping')) {
    return { state: 'stopping', reasons: [`${prefix}_stopping`] }
  }
  if (worker?.status === 'stopping' && running) {
    return { state: 'stopping', reasons: [`${prefix}_stopping`] }
  }
  if (worker?.status === 'starting') {
    return { state: 'starting', reasons: [`${prefix}_starting`] }
  }

  if (prefix === 'cycle' && cycleStalled(health)) {
    const reasons: SubjectReadinessReasonCode[] = health?.status === 'reactor_backlog_stalled'
      ? ['reactor_backlog_stalled']
      : ['cycle_stalled']
    if (running) reasons.push(owned ? 'cycle_running' : 'cycle_attached')
    return { state: 'stalled', reasons }
  }

  if (health?.status === 'blocked') {
    return { state: 'blocked', reasons: [`${prefix}_blocked`] }
  }

  if (running) {
    return {
      state: owned ? 'running' : 'attached',
      reasons: [owned ? `${prefix}_running` : `${prefix}_attached`]
    }
  }

  if (!worker || worker.status === 'stopped' || worker.running === false) {
    return { state: 'stopped', reasons: [`${prefix}_stopped`] }
  }

  return { state: 'unavailable', reasons: [`${prefix}_unavailable`] }
}

function mapConversation(
  channel: DomainReadiness,
  model: ModelReadinessView,
  desktopChannelEnabled: boolean
): ConversationReadinessView {
  const reasons: SubjectReadinessReasonCode[] = []
  if (!LIVE_STATES.has(channel.state)) {
    reasons.push('conversation_blocked_channel')
  }
  if (model.state !== 'running') {
    reasons.push('conversation_blocked_model')
  }
  if (!desktopChannelEnabled) {
    reasons.push('desktop_channel_disabled')
  }
  if (reasons.length > 0) {
    return { state: 'blocked', reasons }
  }
  return { state: 'running', reasons: ['conversation_ready'] }
}

function neededActionIds(input: {
  cycle: DomainReadiness
  channel: DomainReadiness
  ownership: OwnershipObservation
}): SubjectReadinessActionId[] {
  const needed: SubjectReadinessActionId[] = []
  const cycleStalledNow = input.cycle.state === 'stalled' || input.cycle.reasons.includes('reactor_backlog_stalled')
  const cycleLive = LIVE_STATES.has(input.cycle.state) || (input.cycle.state === 'stalled' && (
    input.cycle.reasons.includes('cycle_running') || input.cycle.reasons.includes('cycle_attached')
  ))

  if (input.channel.state === 'stopped' || input.channel.state === 'blocked') {
    needed.push('start_channel')
  }
  if (
    input.channel.state === 'stale'
    || input.channel.state === 'zombie'
    || input.cycle.state === 'stale'
    || input.cycle.state === 'zombie'
  ) {
    needed.push('repair_worker_state')
  }
  if (cycleStalledNow) {
    needed.push('process_cycle_once')
    if (!cycleLive) needed.push('start_cycle')
  } else if (input.cycle.state === 'stopped' || input.cycle.state === 'blocked') {
    needed.push('start_cycle')
  }

  const managedLive = (domainOwned(input.ownership, 'cycle') && (
    LIVE_STATES.has(input.cycle.state) || input.cycle.state === 'stopping' || input.cycle.state === 'stalled'
  )) || (domainOwned(input.ownership, 'channel') && (
    LIVE_STATES.has(input.channel.state) || input.channel.state === 'stopping'
  ))
  if (managedLive && (input.ownership.mode === 'managed' || input.ownership.mode === 'stopping')) {
    needed.push('stop_managed')
  }

  return uniqueCodes(needed)
}

function hostAllowsAction(id: SubjectReadinessActionId, hostKind: ClientHostKind): boolean {
  const capability = READINESS_ACTION_CAPABILITY[id]
  if (hostKind === 'web') return capability === 'readonly' || capability === 'write'
  return true
}

export function resolveRemediationActions(
  needed: readonly SubjectReadinessActionId[],
  hostKind: ClientHostKind
): { allowed_actions: SubjectReadinessActionId[]; actions: RemediationAction[] } {
  const neededSet = new Set(needed)
  const localNeeded = needed.filter((id) => READINESS_ACTION_CAPABILITY[id] === 'local-only')
  if (hostKind === 'web' && localNeeded.length > 0) {
    neededSet.add('open_desktop')
  }

  const actions: RemediationAction[] = SUBJECT_READINESS_ACTION_IDS.map((id) => {
    const capability = READINESS_ACTION_CAPABILITY[id]
    let allowed = neededSet.has(id) && hostAllowsAction(id, hostKind)
    if (id === 'open_desktop') {
      allowed = hostKind === 'web' && localNeeded.length > 0
    }
    if (id === 'none') allowed = false
    return { id, allowed, capability }
  })

  let allowed_actions = actions.filter((entry) => entry.allowed).map((entry) => entry.id)
  if (allowed_actions.length === 0) {
    const none = actions.find((entry) => entry.id === 'none')
    if (none) none.allowed = true
    allowed_actions = ['none']
  }
  return { allowed_actions, actions }
}

export function projectSubjectReadiness(input: ReadinessProjectionInput): SubjectReadiness {
  const web_host = mapWebHost(input.webHost)
  const cycle = mapProcessDomain('cycle', input.cycleWorker, input.cycleHealth, input.ownership)
  const channel = mapProcessDomain('channel', input.channelWorker, input.channelHealth, input.ownership)
  const model = mapModel(input.model)
  const conversation = mapConversation(channel, model, input.desktopChannelEnabled)
  const reasons = uniqueCodes([
    ...web_host.reasons,
    ...cycle.reasons,
    ...channel.reasons,
    ...model.reasons,
    ...conversation.reasons
  ])
  const { allowed_actions, actions } = resolveRemediationActions(
    neededActionIds({ cycle, channel, ownership: input.ownership }),
    input.hostKind
  )

  return {
    subject: input.subject,
    generated_at: input.generatedAt,
    web_host,
    cycle,
    channel,
    model,
    conversation,
    reasons,
    allowed_actions,
    actions
  }
}

export function readinessCodeView(value: SubjectReadiness) {
  return {
    web_host: value.web_host,
    cycle: value.cycle,
    channel: value.channel,
    model: value.model,
    conversation: value.conversation,
    reasons: value.reasons
  }
}
