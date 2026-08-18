import { eventCycleId, sanitizeCycleDetail, sanitizeCycleList, sanitizeObservability, sanitizeRoundDetail } from './sanitize'
import { isStaleProjectionEvent, pickDefaultCycleId, shouldRefreshForEvent } from './projection'
import type {
  EvolutionCycleDetail,
  EvolutionInspectorClient,
  EvolutionInspectorSnapshot,
  EvolutionRoundDetail
} from './types'

export interface InspectorController {
  snapshot: EvolutionInspectorSnapshot
  loading: boolean
  load(subject: string | null, preferredCycleId?: string | null): Promise<EvolutionInspectorSnapshot>
  selectCycle(cycleId: string): Promise<EvolutionInspectorSnapshot>
  handleEvent(event: Parameters<EvolutionInspectorClient['subscribe']>[0] extends (e: infer E) => void ? E : never): Promise<EvolutionInspectorSnapshot | null>
  subscribe(onChange?: (snapshot: EvolutionInspectorSnapshot) => void): () => void
}

async function settled<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

export function createInspectorController(client: EvolutionInspectorClient): InspectorController {
  let generation = 0
  let lastRevision: number | null = null
  let loadInFlight: Promise<EvolutionInspectorSnapshot> | null = null
  let loadQueued: { subject: string | null; preferredCycleId?: string | null; revision: number | null } | null = null

  async function loadNow(subject: string | null, preferredCycleId?: string | null): Promise<EvolutionInspectorSnapshot> {
    const gen = ++generation
    const name = subject?.trim() || null
    if (!name) {
      state.snapshot = emptySnapshot(null)
      state.loading = false
      lastRevision = null
      return state.snapshot
    }
    state.loading = true
    state.snapshot = {
      ...emptySnapshot(name),
      selectedCycleId: preferredCycleId ?? state.snapshot.selectedCycleId
    }
    const [listRaw, observabilityRaw] = await Promise.all([
      settled(client.listCycles(name)),
      settled(client.getObservability(name))
    ])
    if (gen !== generation) return state.snapshot
    const list = sanitizeCycleList(listRaw)
    const observability = sanitizeObservability(observabilityRaw)
    const cycleIds = list?.cycles.map((item) => item.cycle_id) ?? []
    const details = await loadDetails(client, name, cycleIds)
    if (gen !== generation) return state.snapshot
    const next: EvolutionInspectorSnapshot = {
      subject: name,
      list,
      observability,
      cycles: details.cycles,
      rounds: details.rounds,
      selectedCycleId: null,
      error: list ? null : 'unavailable',
      stale: false
    }
    const preferred = preferredCycleId && cycleIds.includes(preferredCycleId)
      ? preferredCycleId
      : pickDefaultCycleId(next)
    next.selectedCycleId = preferred
    state.snapshot = next
    state.loading = false
    return next
  }

  async function loadCoalesced(
    subject: string | null,
    preferredCycleId: string | null | undefined,
    revision: number | null
  ): Promise<EvolutionInspectorSnapshot> {
    if (revision != null && revision === lastRevision && subject === state.snapshot.subject) {
      return state.snapshot
    }
    if (loadInFlight) {
      loadQueued = { subject, preferredCycleId, revision }
      return loadInFlight
    }
    loadInFlight = loadNow(subject, preferredCycleId)
    try {
      await loadInFlight
      if (revision != null) lastRevision = revision
    } finally {
      loadInFlight = null
    }
    const queued = loadQueued
    loadQueued = null
    if (queued && !(queued.revision != null && queued.revision === lastRevision && queued.subject === state.snapshot.subject)) {
      return loadCoalesced(queued.subject, queued.preferredCycleId, queued.revision)
    }
    return state.snapshot
  }

  const state: InspectorController = {
    snapshot: emptySnapshot(null),
    loading: false,
    async load(subject, preferredCycleId) {
      lastRevision = null
      return loadCoalesced(subject, preferredCycleId, null)
    },
    async selectCycle(cycleId) {
      const id = cycleId.trim()
      const subject = state.snapshot.subject
      if (!id || !subject) return state.snapshot
      const gen = generation
      if (!(id in state.snapshot.cycles) || !(id in state.snapshot.rounds)) {
        const details = await loadDetails(client, subject, [id])
        if (gen !== generation) return state.snapshot
        state.snapshot = {
          ...state.snapshot,
          cycles: { ...state.snapshot.cycles, ...details.cycles },
          rounds: { ...state.snapshot.rounds, ...details.rounds }
        }
      }
      state.snapshot = { ...state.snapshot, selectedCycleId: id }
      return state.snapshot
    },
    async handleEvent(event) {
      const subject = state.snapshot.subject
      if (isStaleProjectionEvent(event)) {
        const eventSubject = typeof event.subject === 'string' ? event.subject : event.payload?.subject
        if (subject && eventSubject && eventSubject !== subject) return null
        if (!subject) return null
        state.snapshot = { ...state.snapshot, stale: true }
        return state.snapshot
      }
      if (!shouldRefreshForEvent(event, subject)) {
        return null
      }
      const cycleId = eventCycleId(event)
      const selected = state.snapshot.selectedCycleId
      const revision = typeof event.payload?.revision === 'number' ? event.payload.revision : null
      if (revision != null && revision === lastRevision && (cycleId == null || cycleId === selected)) {
        return state.snapshot
      }
      return loadCoalesced(subject, cycleId ?? selected, revision)
    },
    subscribe(onChange) {
      return client.subscribe((event) => {
        void state.handleEvent(event).then((next) => {
          if (next) onChange?.(next)
        })
      })
    }
  }
  return state
}

function emptySnapshot(subject: string | null): EvolutionInspectorSnapshot {
  return {
    subject,
    list: null,
    observability: null,
    cycles: {},
    rounds: {},
    selectedCycleId: null,
    error: null,
    stale: false
  }
}

async function loadDetails(
  client: EvolutionInspectorClient,
  subject: string,
  cycleIds: string[]
): Promise<{
  cycles: Record<string, EvolutionCycleDetail | null>
  rounds: Record<string, EvolutionRoundDetail | null>
}> {
  const cycles: Record<string, EvolutionCycleDetail | null> = {}
  const rounds: Record<string, EvolutionRoundDetail | null> = {}
  await Promise.all(cycleIds.map(async (cycleId) => {
    const [cycleRaw, roundRaw] = await Promise.all([
      settled(client.getCycle(subject, cycleId)),
      settled(client.getRound(subject, cycleId))
    ])
    cycles[cycleId] = sanitizeCycleDetail(cycleRaw)
    rounds[cycleId] = sanitizeRoundDetail(roundRaw)
  }))
  return { cycles, rounds }
}
