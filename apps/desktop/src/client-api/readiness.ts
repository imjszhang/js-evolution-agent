import {
  READINESS_ACTION_CAPABILITY as READINESS_ACTION_CAPABILITY_IMPL,
  SUBJECT_READINESS_REASON_CODES as SUBJECT_READINESS_REASON_CODES_IMPL,
  isSubjectReadinessActionId as isSubjectReadinessActionIdImpl,
  isSubjectReadinessDomainState as isSubjectReadinessDomainStateImpl,
  isSubjectReadinessReasonCode as isSubjectReadinessReasonCodeImpl,
  observeWebHost as observeWebHostImpl,
  projectSubjectReadiness as projectSubjectReadinessImpl,
  readSubjectReadiness as readSubjectReadinessImpl,
  readinessCodeView as readinessCodeViewImpl,
  resolveRemediationActions as resolveRemediationActionsImpl
} from '../../../../src/product/subject-readiness.mjs'
import type {
  ClientHostKind,
  RemediationAction,
  SubjectReadiness,
  SubjectReadinessActionId,
  SubjectReadinessDomainState,
  SubjectReadinessReasonCode
} from './types'
import {
  SUBJECT_READINESS_ACTION_IDS,
  SUBJECT_READINESS_DOMAIN_STATES
} from './types'

export const SUBJECT_READINESS_REASON_CODES = SUBJECT_READINESS_REASON_CODES_IMPL

export const READINESS_ACTION_CAPABILITY = READINESS_ACTION_CAPABILITY_IMPL as Record<
  SubjectReadinessActionId,
  RemediationAction['capability']
>

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
  supervisor_lease?: {
    required?: boolean
    status?: string | null
    expires_at?: string | null
    domain?: 'all' | 'cycle' | 'channel' | null
  } | null
  supervisor_leases?: Array<NonNullable<OwnershipObservation['supervisor_lease']>>
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
  automation?: {
    mode?: string
    mapped_from?: string
    diagnostic?: string | null
    background?: boolean
  }
  pendingEvidence?: number | null
  projectionDegraded?: boolean
  waitingApproval?: boolean
  catchUp?: {
    paused?: boolean
    reason?: string | null
  }
  llmBudget?: {
    schema?: string
    period_id?: string
    state?: 'ok' | 'warn' | 'exhausted'
    used_tokens?: number
    remaining_tokens?: number
    token_budget?: number
    used_spend_usd?: number
    remaining_spend_usd?: number
    spend_budget_usd?: number
    cycle_admission?: 'open' | 'parked'
    shared_ledger?: boolean
    blocked_reason?: string | null
    token?: Record<string, unknown>
    spend?: Record<string, unknown>
  } | null
}

export function isSubjectReadinessDomainState(value: string): value is SubjectReadinessDomainState {
  return isSubjectReadinessDomainStateImpl(value)
    && (SUBJECT_READINESS_DOMAIN_STATES as readonly string[]).includes(value)
}

export function isSubjectReadinessActionId(value: string): value is SubjectReadinessActionId {
  return isSubjectReadinessActionIdImpl(value)
    && (SUBJECT_READINESS_ACTION_IDS as readonly string[]).includes(value)
}

export function isSubjectReadinessReasonCode(value: string): value is SubjectReadinessReasonCode {
  return isSubjectReadinessReasonCodeImpl(value)
}

export function observeWebHost(jeaHome: string): WebHostObservation {
  return observeWebHostImpl(jeaHome) as WebHostObservation
}

export function resolveRemediationActions(
  needed: readonly SubjectReadinessActionId[],
  hostKind: ClientHostKind
): { allowed_actions: SubjectReadinessActionId[]; actions: RemediationAction[] } {
  return resolveRemediationActionsImpl(needed, hostKind) as {
    allowed_actions: SubjectReadinessActionId[]
    actions: RemediationAction[]
  }
}

export function projectSubjectReadiness(input: ReadinessProjectionInput): SubjectReadiness {
  return projectSubjectReadinessImpl(input) as SubjectReadiness
}

export function readinessCodeView(value: SubjectReadiness) {
  return readinessCodeViewImpl(value) as {
    web_host: SubjectReadiness['web_host']
    cycle: SubjectReadiness['cycle']
    channel: SubjectReadiness['channel']
    model: SubjectReadiness['model']
    conversation: SubjectReadiness['conversation']
    reasons: SubjectReadiness['reasons']
  }
}

export function readSubjectReadiness(
  runtime: { sourceRoot: string; jeaHome: string },
  subject: string,
  options: {
    hostKind?: ClientHostKind
    processPort?: {
      get(subject: string): {
        mode?: string | null
        domain?: 'all' | 'cycle' | 'channel' | null
        supervisor_lease?: OwnershipObservation['supervisor_lease']
        supervisor_leases?: OwnershipObservation['supervisor_leases']
      }
    }
    generatedAt?: string
    deferRebuild?: boolean
  } = {}
): SubjectReadiness {
  return readSubjectReadinessImpl(runtime, subject, options) as SubjectReadiness
}
