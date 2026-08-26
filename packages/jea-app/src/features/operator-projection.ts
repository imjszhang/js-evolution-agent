import type {
  ProductEvolutionIntent,
  ProductHostKind,
  RemediationActionView,
  SubjectReadiness
} from './client-types'
import type { EvolutionCycleList, EvolutionObservability } from './evolution/types'
import {
  displaySchedulerState,
  projectReactorControlPlane,
  type ReactorControlPlaneView
} from './reactor-progress'

export const OPERATOR_COUNT_SOURCES = {
  evidencePending: {
    source: 'daemon.reactor.evidence.pending_count',
    unit: 'evidence'
  },
  daemonTaskPending: {
    source: 'daemon.tasks.counts.pending',
    unit: 'tasks'
  },
  attentionItems: {
    source: 'observability.attention.items',
    unit: 'items'
  }
} as const

export interface OperatorEvolutionSummaryInput {
  roundCount: number
  openCycles: number
  latestStatus: string | null
  latestTldr: string | null
}

export interface OperatorCountProjection {
  count: number
  source: string
  unit: string
}

export interface OperatorEvolutionRuntime {
  mode: 'automatic' | 'paused'
  intent: ProductEvolutionIntent
  remaining_evidence: number
  blocker: string | null
  scheduler_state: ReactorControlPlaneView['scheduler_state']
  freshness: ReactorControlPlaneView['freshness']
}

export interface OperatorSurfaceProjection {
  conversation_readiness: SubjectReadiness['conversation']
  evolution_summary: OperatorEvolutionSummaryInput
  evolution_runtime: OperatorEvolutionRuntime
  observability_attention: OperatorCountProjection & {
    items: NonNullable<EvolutionObservability['attention']['items']>
  }
  evidence_pending: OperatorCountProjection
  daemon_task_pending: OperatorCountProjection
  allowed_remediation_actions: RemediationActionView[]
  product_actions: RemediationActionView[]
  reactor_control_plane: ReactorControlPlaneView
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

function latestCycle(list: EvolutionCycleList): EvolutionCycleList['cycles'][number] | null {
  return list.cycles.reduce<EvolutionCycleList['cycles'][number] | null>((latest, cycle) => {
    if (!latest) return cycle
    const latestTime = Date.parse(latest.generated_at ?? '')
    const cycleTime = Date.parse(cycle.generated_at ?? '')
    if (!Number.isFinite(cycleTime)) return latest
    if (!Number.isFinite(latestTime) || cycleTime > latestTime) return cycle
    return latest
  }, null)
}

export function projectEvolutionSummary(
  list: EvolutionCycleList,
  observability: EvolutionObservability
): OperatorEvolutionSummaryInput {
  const latest = latestCycle(list)
  return {
    roundCount: count(list.round_count),
    openCycles: count(observability.open_cycles),
    latestStatus: latest?.status ?? null,
    latestTldr: latest?.tldr ?? null
  }
}

const PRODUCT_ACTION_IDS = new Set([
  'pause_automatic_evolution',
  'resume_automatic_evolution',
  'check_now',
  'view_blocker',
  'open_desktop'
])

export function projectEvolutionRuntime(
  readiness: SubjectReadiness,
  observability: EvolutionObservability,
  host: ProductHostKind = 'electron'
): OperatorEvolutionRuntime {
  const pending = count(observability.evidence_pending_count)
  const plane = projectReactorControlPlane({ readiness, observability, host })
  const automation = readiness.automation
  const mode: 'automatic' | 'paused' = automation?.mode === 'paused' ? 'paused' : 'automatic'
  const intent = displaySchedulerState(plane.progress, mode)
  if (plane.progress || automation) {
    return {
      mode,
      intent,
      remaining_evidence: pending,
      blocker: plane.primary_blocker ?? automation?.blocker ?? null,
      scheduler_state: plane.scheduler_state,
      freshness: plane.freshness
    }
  }
  const cycleState = readiness.cycle.state
  if (['blocked', 'stale', 'zombie', 'unavailable', 'stopped'].includes(cycleState)) {
    return {
      mode: 'automatic',
      intent: 'blocked',
      remaining_evidence: pending,
      blocker: readiness.cycle.reasons[0] ?? cycleState,
      scheduler_state: null,
      freshness: 'unknown'
    }
  }
  if (cycleState === 'stalled') {
    return {
      mode: 'automatic',
      intent: 'stalled',
      remaining_evidence: pending,
      blocker: readiness.cycle.reasons[0] ?? cycleState,
      scheduler_state: null,
      freshness: 'unknown'
    }
  }
  return {
    mode: 'automatic',
    intent: pending > 0 ? 'queued' : 'listening',
    remaining_evidence: pending,
    blocker: null,
    scheduler_state: null,
    freshness: 'unknown'
  }
}

export function projectOperatorSurface(input: {
  readiness: SubjectReadiness
  evolution: OperatorEvolutionSummaryInput
  observability: EvolutionObservability
  host: ProductHostKind
}): OperatorSurfaceProjection {
  const items = Array.isArray(input.observability.attention.items)
    ? input.observability.attention.items
    : []
  const diagnosticActions = input.readiness.actions.filter((action) => (
    action.allowed
    && action.id !== 'none'
    && (input.host === 'electron' || action.capability !== 'local-only')
  ))
  const productSource = input.readiness.product_actions ?? input.readiness.actions
  const product_actions = productSource.filter((action) => (
    action.allowed
    && PRODUCT_ACTION_IDS.has(action.id)
    && (input.host === 'electron' || action.capability !== 'local-only')
  ))
  return {
    conversation_readiness: input.readiness.conversation,
    evolution_summary: {
      roundCount: count(input.evolution.roundCount),
      openCycles: count(input.evolution.openCycles),
      latestStatus: input.evolution.latestStatus,
      latestTldr: input.evolution.latestTldr
    },
    evolution_runtime: projectEvolutionRuntime(input.readiness, input.observability, input.host),
    observability_attention: {
      count: items.length,
      items,
      ...OPERATOR_COUNT_SOURCES.attentionItems
    },
    evidence_pending: {
      count: count(input.observability.evidence_pending_count),
      ...OPERATOR_COUNT_SOURCES.evidencePending
    },
    daemon_task_pending: {
      count: count(input.observability.daemon_task_pending_count),
      ...OPERATOR_COUNT_SOURCES.daemonTaskPending
    },
    allowed_remediation_actions: diagnosticActions,
    product_actions,
    reactor_control_plane: projectReactorControlPlane({
      readiness: input.readiness,
      observability: input.observability,
      host: input.host
    })
  }
}
