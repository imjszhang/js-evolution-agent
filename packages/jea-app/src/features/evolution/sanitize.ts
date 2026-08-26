import { sanitizeReactorProgress } from '../reactor-progress'
import type {
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionCycleSummary,
  EvolutionEventEnvelope,
  EvolutionObservability,
  EvolutionRoundDetail,
  EvolutionStepView
} from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function asBoolean(value: unknown): boolean {
  return value === true
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = asString(value)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function sanitizeStepView(value: unknown): EvolutionStepView | null {
  if (!isRecord(value)) return null
  const status = asString(value.status) ?? 'pending'
  return {
    status,
    updated_at: asString(value.updated_at),
    error: asString(value.error)
  }
}

export function sanitizeSteps(value: unknown): Record<string, EvolutionStepView> {
  if (!isRecord(value)) return {}
  const steps: Record<string, EvolutionStepView> = {}
  for (const [name, info] of Object.entries(value)) {
    const key = asString(name)
    const step = sanitizeStepView(info)
    if (!key || !step) continue
    steps[key] = step
  }
  return steps
}

export function sanitizeCycleSummary(value: unknown): EvolutionCycleSummary | null {
  if (!isRecord(value)) return null
  const cycle_id = asString(value.cycle_id)
  if (!cycle_id) return null
  return {
    cycle_id,
    generated_at: asString(value.generated_at),
    tldr: asString(value.tldr),
    has_diary: asBoolean(value.has_diary),
    status: asString(value.status)
  }
}

export function sanitizeCycleList(value: unknown): EvolutionCycleList | null {
  if (!isRecord(value)) return null
  const subject = asString(value.subject)
  if (!subject) return null
  const rawCycles = Array.isArray(value.cycles) ? value.cycles : []
  const seen = new Set<string>()
  const cycles: EvolutionCycleSummary[] = []
  for (const item of rawCycles) {
    const cycle = sanitizeCycleSummary(item)
    if (!cycle || seen.has(cycle.cycle_id)) continue
    seen.add(cycle.cycle_id)
    cycles.push(cycle)
  }
  return {
    subject,
    namespace: asString(value.namespace) ?? subject,
    round_count: asFiniteNumber(value.round_count) ?? cycles.length,
    cycles
  }
}

export function sanitizeCycleDetail(value: unknown): EvolutionCycleDetail | null {
  if (!isRecord(value)) return null
  const subject = asString(value.subject)
  const cycle_id = asString(value.cycle_id)
  if (!subject || !cycle_id) return null
  const steps = sanitizeSteps(value.steps)
  const blockers = uniqueStrings([
    ...(Array.isArray(value.blockers) ? value.blockers : []),
    ...Object.values(steps).map((step) => step.error)
  ])
  return {
    subject,
    cycle_id,
    cycle_status: asString(value.cycle_status),
    opened_at: asString(value.opened_at),
    closed_at: asString(value.closed_at),
    has_report: asBoolean(value.has_report),
    steps,
    blockers
  }
}

export function sanitizeRoundDetail(value: unknown): EvolutionRoundDetail | null {
  if (!isRecord(value)) return null
  const subject = asString(value.subject)
  const cycle_id = asString(value.cycle_id)
  if (!subject || !cycle_id) return null
  const report = isRecord(value.report) ? value.report : {}
  const diary = isRecord(value.diary) ? value.diary : {}
  const verify = isRecord(value.verify) ? value.verify : {}
  const receipts = isRecord(value.receipts) ? value.receipts : {}
  const diaryItems = Array.isArray(diary.items) ? diary.items : []
  const items: Array<{ exec_id: string; tldr: string | null }> = []
  const seen = new Set<string>()
  for (const item of diaryItems) {
    if (!isRecord(item)) continue
    const exec_id = asString(item.exec_id)
    if (!exec_id || seen.has(exec_id)) continue
    seen.add(exec_id)
    items.push({ exec_id, tldr: asString(item.tldr) })
  }
  return {
    subject,
    cycle_id,
    report: {
      available: asBoolean(report.available),
      tldr: asString(report.tldr)
    },
    diary: {
      available: asBoolean(diary.available) || items.length > 0,
      items
    },
    verify: {
      available: asBoolean(verify.available),
      semantic_status: asString(verify.semantic_status),
      verified_count: asFiniteNumber(verify.verified_count),
      pending_count: asFiniteNumber(verify.pending_count)
    },
    receipts: {
      count: asFiniteNumber(receipts.count) ?? 0
    },
    blockers: uniqueStrings(Array.isArray(value.blockers) ? value.blockers : [])
  }
}

function sanitizeCycleDiagnostics(value: unknown): EvolutionObservability['cycle_diagnostics'] | undefined {
  if (!isRecord(value)) return undefined
  const raw = Array.isArray(value.recent) ? value.recent : []
  const recent: NonNullable<NonNullable<EvolutionObservability['cycle_diagnostics']>['recent']> = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const cycle_id = asString(item.cycle_id)
    if (!cycle_id || seen.has(cycle_id)) continue
    seen.add(cycle_id)
    recent.push({
      cycle_id,
      status: asString(item.status)
    })
  }
  return { recent }
}

export function sanitizeObservability(value: unknown): EvolutionObservability | null {
  if (!isRecord(value)) return null
  const subject = asString(value.subject)
  if (!subject) return null
  const cycle_diagnostics = sanitizeCycleDiagnostics(value.cycle_diagnostics)
  const rawAttention = isRecord(value.attention) ? value.attention : {}
  const items = (Array.isArray(rawAttention.items) ? rawAttention.items : []).flatMap((item) => {
    if (!isRecord(item)) return []
    const title = asString(item.title)
    if (!title) return []
    return [{
      severity: asString(item.severity) ?? 'info',
      kind: asString(item.kind) ?? 'general',
      status: asString(item.status) ?? 'active',
      category: asString(item.category) ?? 'current',
      blocking: asBoolean(item.blocking),
      title,
      summary: asString(item.summary) ?? ''
    }]
  })
  const reactor_progress = sanitizeReactorProgress(value.reactor_progress)
  return {
    subject,
    attention: {
      items,
      summary: isRecord(rawAttention.summary) ? rawAttention.summary : {}
    },
    open_cycles: asFiniteNumber(value.open_cycles) ?? 0,
    evidence_pending_count: asFiniteNumber(value.evidence_pending_count) ?? 0,
    daemon_task_pending_count: asFiniteNumber(value.daemon_task_pending_count) ?? 0,
    ...(cycle_diagnostics ? { cycle_diagnostics } : {}),
    ...(reactor_progress ? { reactor_progress } : {})
  }
}

export function eventSubject(event: EvolutionEventEnvelope | null | undefined): string | null {
  if (!event) return null
  return asString(event.subject) ?? asString(event.payload?.subject)
}

export function eventCycleId(event: EvolutionEventEnvelope | null | undefined): string | null {
  if (!event) return null
  return asString(event.payload?.cycle_id)
}

export function isEvolutionUpdatedEvent(event: EvolutionEventEnvelope | null | undefined): boolean {
  return asString(event?.type) === 'evolution.updated'
}
