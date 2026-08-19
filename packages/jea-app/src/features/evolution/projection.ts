import { asFiniteNumber } from './sanitize'
import type {
  CycleKind,
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionInspectorCore,
  EvolutionInspectorSnapshot,
  EvolutionObservability,
  EvolutionRoundDetail,
  InspectorSafeState,
  TimelineCycleView
} from './types'
import { STEP_ORDER } from './types'

export function isOpenCycleStatus(status: string | null | undefined, closedAt?: string | null): boolean {
  if (closedAt) return false
  const value = (status ?? '').toLowerCase()
  if (!value) return false
  return value === 'open' || value === 'running' || value === 'active'
}

export function cycleKind(
  detail: EvolutionCycleDetail | null | undefined,
  summaryStatus?: string | null
): CycleKind {
  if (isOpenCycleStatus(detail?.cycle_status ?? summaryStatus, detail?.closed_at)) return 'open'
  return 'historical'
}

export function orderedSteps(steps: EvolutionCycleDetail['steps'] | undefined): TimelineCycleView['steps'] {
  const entries = Object.entries(steps ?? {})
  entries.sort((a, b) => {
    const ai = STEP_ORDER.indexOf(a[0] as (typeof STEP_ORDER)[number])
    const bi = STEP_ORDER.indexOf(b[0] as (typeof STEP_ORDER)[number])
    const av = ai === -1 ? STEP_ORDER.length : ai
    const bv = bi === -1 ? STEP_ORDER.length : bi
    return av - bv || a[0].localeCompare(b[0])
  })
  return entries.map(([name, step]) => ({
    name,
    status: step.status,
    error: step.error
  }))
}

export function pickDefaultCycleId(snapshot: Pick<EvolutionInspectorSnapshot, 'list' | 'cycles' | 'observability'>): string | null {
  const cycles = snapshot.list?.cycles ?? []
  if (cycles.length === 0) return null
  const open = cycles.find((cycle) => {
    const detail = snapshot.cycles[cycle.cycle_id]
    return cycleKind(detail ?? null, cycle.status) === 'open'
  })
  if (open) return open.cycle_id
  const listed = new Set(cycles.map((cycle) => cycle.cycle_id))
  const diagnosticOpen = (snapshot.observability?.cycle_diagnostics?.recent ?? []).find((item) => (
    listed.has(item.cycle_id) && isOpenCycleStatus(item.status)
  ))
  if (diagnosticOpen) return diagnosticOpen.cycle_id
  if ((snapshot.observability?.open_cycles ?? 0) > 0) {
    const firstWithDetail = cycles.find((cycle) => snapshot.cycles[cycle.cycle_id])
    if (firstWithDetail && !snapshot.cycles[firstWithDetail.cycle_id]?.closed_at) {
      return firstWithDetail.cycle_id
    }
  }
  return cycles[0]?.cycle_id ?? null
}

export function projectTimeline(snapshot: EvolutionInspectorSnapshot): TimelineCycleView[] {
  const cycles = snapshot.list?.cycles ?? []
  return cycles.map((cycle) => {
    const detail = snapshot.cycles[cycle.cycle_id] ?? null
    const kind = cycleKind(detail, cycle.status)
    return {
      cycle_id: cycle.cycle_id,
      status: detail?.cycle_status ?? cycle.status ?? (kind === 'open' ? 'open' : 'historical'),
      kind,
      time: detail?.opened_at ?? cycle.generated_at,
      tldr: cycle.tldr,
      has_diary: cycle.has_diary,
      steps: orderedSteps(detail?.steps)
    }
  })
}

export function projectEvolutionCore(snapshot: EvolutionInspectorSnapshot): EvolutionInspectorCore {
  const selected = snapshot.selectedCycleId
  const detail = selected ? snapshot.cycles[selected] ?? null : null
  const round = selected ? snapshot.rounds[selected] ?? null : null
  const blockers = uniqueBlockers(detail, round)
  const attentionCount = asFiniteNumber(snapshot.observability?.attention?.count)
  const kind = selected ? cycleKind(detail, snapshot.list?.cycles.find((item) => item.cycle_id === selected)?.status) : null
  return {
    subject: snapshot.list?.subject ?? snapshot.observability?.subject ?? snapshot.subject ?? '',
    namespace: snapshot.list?.namespace ?? '',
    round_count: snapshot.list?.round_count ?? snapshot.list?.cycles.length ?? 0,
    open_cycles: snapshot.observability?.open_cycles ?? projectTimeline(snapshot).filter((item) => item.kind === 'open').length,
    selected_cycle_id: selected,
    selected_kind: kind,
    cycle_status: detail?.cycle_status ?? null,
    verify_available: Boolean(round?.verify.available),
    verify_semantic_status: round?.verify.semantic_status ?? null,
    verified_count: round?.verify.verified_count ?? null,
    pending_count: round?.verify.pending_count ?? null,
    receipt_count: round?.receipts.count ?? 0,
    diary_count: round?.diary.items.length ?? 0,
    report_available: Boolean(round?.report.available || detail?.has_report),
    report_tldr: round?.report.tldr ?? null,
    blocker_count: blockers.length,
    blockers,
    step_count: Object.keys(detail?.steps ?? {}).length,
    attention_count: attentionCount
  }
}

function uniqueBlockers(
  detail: EvolutionCycleDetail | null,
  round: EvolutionRoundDetail | null
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...(detail?.blockers ?? []), ...(round?.blockers ?? [])]) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function resolveSafeState(snapshot: EvolutionInspectorSnapshot, loading: boolean): InspectorSafeState {
  if (!snapshot.subject) return 'no-subject'
  if (snapshot.stale) return snapshot.error === 'offline' ? 'offline' : 'stale'
  if (snapshot.error) return 'error'
  if (loading && !snapshot.list) return 'loading'
  if (!snapshot.list || snapshot.list.cycles.length === 0) return 'empty'
  const core = projectEvolutionCore(snapshot)
  if (!core.selected_cycle_id) return 'empty'
  if (snapshot.cycles[core.selected_cycle_id] === null && snapshot.rounds[core.selected_cycle_id] === null) {
    return 'malformed'
  }
  if (!core.verify_available) {
    return core.selected_kind === 'open' ? 'open' : 'verify-unavailable'
  }
  return core.selected_kind === 'open' ? 'open' : 'historical'
}

const LIVE_REFRESH_EVENTS = new Set([
  'evolution.updated',
  'projection.todo_updated',
  'projection.ops_updated'
])

const STALE_EVENTS = new Set([
  'projection.refresh_failed'
])

export function eventSubjectOf(
  event: { subject?: string; payload?: Record<string, unknown> } | null
): string | null {
  if (!event) return null
  if (typeof event.subject === 'string' && event.subject.trim()) return event.subject.trim()
  return typeof event.payload?.subject === 'string' && event.payload.subject.trim()
    ? event.payload.subject.trim()
    : null
}

export function isStaleProjectionEvent(
  event: { type: string; payload?: Record<string, unknown> } | null
): boolean {
  if (!event) return false
  if (STALE_EVENTS.has(event.type)) return true
  return event.payload?.stale === true && LIVE_REFRESH_EVENTS.has(event.type)
}

export function shouldRefreshForEvent(
  event: { type: string; subject?: string; payload?: Record<string, unknown> } | null,
  subject: string | null
): boolean {
  if (!subject || !event || !LIVE_REFRESH_EVENTS.has(event.type)) return false
  if (isStaleProjectionEvent(event)) return false
  const eventSubject = eventSubjectOf(event)
  if (eventSubject && eventSubject !== subject) return false
  return true
}

export function mergeCycleRecords<T extends { cycle_id: string }>(
  current: T[],
  incoming: T[]
): T[] {
  const byId = new Map<string, T>()
  for (const item of current) {
    if (item?.cycle_id) byId.set(item.cycle_id, item)
  }
  for (const item of incoming) {
    if (item?.cycle_id) byId.set(item.cycle_id, item)
  }
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of [...incoming, ...current]) {
    if (!item?.cycle_id || seen.has(item.cycle_id)) continue
    seen.add(item.cycle_id)
    const next = byId.get(item.cycle_id)
    if (next) out.push(next)
  }
  return out
}

export function coreFromLegacy(input: {
  subject: string
  namespace: string
  list: EvolutionCycleList
  cycle: EvolutionCycleDetail | null
  round: EvolutionRoundDetail | null
  observability: EvolutionObservability
}): EvolutionInspectorCore {
  return projectEvolutionCore({
    subject: input.subject,
    list: input.list,
    observability: input.observability,
    cycles: input.cycle ? { [input.cycle.cycle_id]: input.cycle } : {},
    rounds: input.round ? { [input.round.cycle_id]: input.round } : {},
    selectedCycleId: input.cycle?.cycle_id ?? input.round?.cycle_id ?? input.list.cycles[0]?.cycle_id ?? null,
    error: null
  })
}
