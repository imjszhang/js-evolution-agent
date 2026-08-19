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
  let lastRevisionCycleId: string | null = null
  let loadInFlight: Promise<EvolutionInspectorSnapshot> | null = null
  let loadQueued: {
    subject: string | null
    preferredCycleId?: string | null
    revision: number | null
    detailCycleId?: string | null
  } | null = null

  async function loadNow(
    subject: string | null,
    preferredCycleId?: string | null,
    detailCycleId?: string | null
  ): Promise<EvolutionInspectorSnapshot> {
    const gen = ++generation
    const name = subject?.trim() || null
    if (!name) {
      state.snapshot = emptySnapshot(null)
      state.loading = false
      lastRevision = null
      return state.snapshot
    }

    // Copy before any snapshot reset. emptySnapshot() would wipe these maps.
    const sameSubject = state.snapshot.subject === name
    const previousCycles = sameSubject ? { ...state.snapshot.cycles } : {}
    const previousRounds = sameSubject ? { ...state.snapshot.rounds } : {}

    state.loading = true
    state.snapshot = {
      ...state.snapshot,
      subject: name,
      selectedCycleId: preferredCycleId ?? state.snapshot.selectedCycleId,
      stale: false
    }
    const [listRaw, observabilityRaw] = await Promise.all([
      settled(client.listCycles(name)),
      settled(client.getObservability(name))
    ])
    if (gen !== generation) return state.snapshot
    const list = sanitizeCycleList(listRaw)
    const observability = sanitizeObservability(observabilityRaw)
    const cycleIds = list?.cycles.map((item) => item.cycle_id) ?? []
    const listed = new Set(cycleIds)
    const cycles = keepListedDetails(previousCycles, listed)
    const rounds = keepListedDetails(previousRounds, listed)
    const next: EvolutionInspectorSnapshot = {
      subject: name,
      list,
      observability,
      cycles,
      rounds,
      selectedCycleId: null,
      error: list ? null : 'unavailable',
      stale: false
    }
    const preferred = preferredCycleId && cycleIds.includes(preferredCycleId)
      ? preferredCycleId
      : pickDefaultCycleId(next)
    next.selectedCycleId = preferred
    const cycleToLoad = detailCycleId === undefined
      ? preferred
      : detailCycleId && listed.has(detailCycleId) ? detailCycleId : null
    if (cycleToLoad) {
      const details = await loadDetails(client, name, [cycleToLoad])
      if (gen !== generation) return state.snapshot
      next.cycles = { ...next.cycles, ...details.cycles }
      next.rounds = { ...next.rounds, ...details.rounds }
    }
    state.snapshot = next
    state.loading = false
    return next
  }

  async function loadCoalesced(
    subject: string | null,
    preferredCycleId: string | null | undefined,
    revision: number | null,
    detailCycleId?: string | null
  ): Promise<EvolutionInspectorSnapshot> {
    if (
      revision != null
      && revision === lastRevision
      && detailCycleId === lastRevisionCycleId
      && subject === state.snapshot.subject
    ) {
      return state.snapshot
    }
    if (loadInFlight) {
      loadQueued = { subject, preferredCycleId, revision, detailCycleId }
      return loadInFlight
    }
    loadInFlight = loadNow(subject, preferredCycleId, detailCycleId)
    try {
      await loadInFlight
      if (revision != null) {
        lastRevision = revision
        lastRevisionCycleId = detailCycleId ?? null
      }
    } finally {
      loadInFlight = null
    }
    const queued = loadQueued
    loadQueued = null
    if (queued && !(
      queued.revision != null
      && queued.revision === lastRevision
      && (queued.detailCycleId ?? null) === lastRevisionCycleId
      && queued.subject === state.snapshot.subject
    )) {
      return loadCoalesced(queued.subject, queued.preferredCycleId, queued.revision, queued.detailCycleId)
    }
    return state.snapshot
  }

  const state: InspectorController = {
    snapshot: emptySnapshot(null),
    loading: false,
    async load(subject, preferredCycleId) {
      lastRevision = null
      lastRevisionCycleId = null
      return loadCoalesced(subject, preferredCycleId, null, undefined)
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
      return loadCoalesced(subject, cycleId ?? selected, revision, cycleId)
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

function keepListedDetails<T>(
  previous: Record<string, T>,
  listed: Set<string>
): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [cycleId, value] of Object.entries(previous)) {
    if (listed.has(cycleId)) next[cycleId] = value
  }
  return next
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
