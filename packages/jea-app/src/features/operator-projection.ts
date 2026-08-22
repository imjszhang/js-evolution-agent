import type { ProductHostKind, RemediationActionView, SubjectReadiness } from './client-types'
import type { EvolutionCycleList, EvolutionObservability } from './evolution/types'

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

export interface OperatorSurfaceProjection {
  conversation_readiness: SubjectReadiness['conversation']
  evolution_summary: OperatorEvolutionSummaryInput
  observability_attention: OperatorCountProjection & {
    items: NonNullable<EvolutionObservability['attention']['items']>
  }
  evidence_pending: OperatorCountProjection
  daemon_task_pending: OperatorCountProjection
  allowed_remediation_actions: RemediationActionView[]
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

export function projectOperatorSurface(input: {
  readiness: SubjectReadiness
  evolution: OperatorEvolutionSummaryInput
  observability: EvolutionObservability
  host: ProductHostKind
}): OperatorSurfaceProjection {
  const items = Array.isArray(input.observability.attention.items)
    ? input.observability.attention.items
    : []
  return {
    conversation_readiness: input.readiness.conversation,
    evolution_summary: {
      roundCount: count(input.evolution.roundCount),
      openCycles: count(input.evolution.openCycles),
      latestStatus: input.evolution.latestStatus,
      latestTldr: input.evolution.latestTldr
    },
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
    allowed_remediation_actions: input.readiness.actions.filter((action) => (
      action.allowed
      && action.id !== 'none'
      && (input.host === 'electron' || action.capability !== 'local-only')
    ))
  }
}
