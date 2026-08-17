import type {
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionEventEnvelope,
  EvolutionInspectorClient,
  EvolutionObservability,
  EvolutionRoundDetail
} from './types'

export interface EvolutionFixtureStore {
  lists: Record<string, EvolutionCycleList>
  cycles: Record<string, Record<string, EvolutionCycleDetail>>
  rounds: Record<string, Record<string, EvolutionRoundDetail>>
  observability: Record<string, EvolutionObservability>
  errors?: Record<string, Partial<Record<'list' | 'cycle' | 'round' | 'observability', unknown>>>
}

export interface EvolutionFixtureClient extends EvolutionInspectorClient {
  emit(event: EvolutionEventEnvelope): void
  replace(store: Partial<EvolutionFixtureStore>): void
  calls: {
    listCycles: string[]
    getCycle: Array<{ subject: string; cycleId: string }>
    getRound: Array<{ subject: string; cycleId: string }>
    getObservability: string[]
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createEvolutionFixtureData(): EvolutionFixtureStore {
  const openId = 'cycle-20260816-open'
  const historicalId = 'cycle-20260815-closed'
  const betaId = 'cycle-20260814-beta'
  return {
    lists: {
      alpha: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 2,
        cycles: [
          {
            cycle_id: openId,
            generated_at: '2026-08-16T01:00:00.000Z',
            tldr: 'Open reactor cycle',
            has_diary: false,
            status: 'open'
          },
          {
            cycle_id: historicalId,
            generated_at: '2026-08-15T00:00:00.000Z',
            tldr: 'Closed historical cycle',
            has_diary: true,
            status: 'closed'
          }
        ]
      },
      beta: {
        subject: 'beta',
        namespace: 'beta-data',
        round_count: 1,
        cycles: [
          {
            cycle_id: betaId,
            generated_at: '2026-08-14T00:00:00.000Z',
            tldr: 'Beta historical cycle',
            has_diary: true,
            status: 'closed'
          }
        ]
      },
      empty: {
        subject: 'empty',
        namespace: 'empty-data',
        round_count: 0,
        cycles: []
      }
    },
    cycles: {
      alpha: {
        [openId]: {
          subject: 'alpha',
          cycle_id: openId,
          cycle_status: 'open',
          opened_at: '2026-08-16T01:00:00.000Z',
          closed_at: null,
          has_report: false,
          steps: {
            reactor: { status: 'running', updated_at: '2026-08-16T01:02:00.000Z', error: null },
            exec: { status: 'pending', updated_at: null, error: null }
          },
          blockers: []
        },
        [historicalId]: {
          subject: 'alpha',
          cycle_id: historicalId,
          cycle_status: 'closed',
          opened_at: '2026-08-15T00:00:00.000Z',
          closed_at: '2026-08-15T00:20:00.000Z',
          has_report: true,
          steps: {
            reactor: { status: 'done', updated_at: '2026-08-15T00:05:00.000Z', error: null },
            exec: { status: 'done', updated_at: '2026-08-15T00:10:00.000Z', error: null },
            verify: { status: 'done', updated_at: '2026-08-15T00:15:00.000Z', error: null },
            diary: { status: 'done', updated_at: '2026-08-15T00:18:00.000Z', error: null }
          },
          blockers: []
        }
      },
      beta: {
        [betaId]: {
          subject: 'beta',
          cycle_id: betaId,
          cycle_status: 'closed',
          opened_at: '2026-08-14T00:00:00.000Z',
          closed_at: '2026-08-14T00:10:00.000Z',
          has_report: true,
          steps: {
            reactor: { status: 'done', updated_at: '2026-08-14T00:04:00.000Z', error: null }
          },
          blockers: []
        }
      }
    },
    rounds: {
      alpha: {
        [historicalId]: {
          subject: 'alpha',
          cycle_id: historicalId,
          report: { available: true, tldr: 'Closed historical cycle' },
          diary: { available: true, items: [{ exec_id: 'exec-20260815-001', tldr: 'Diary for historical cycle' }] },
          verify: { available: true, semantic_status: 'ok', verified_count: 2, pending_count: 0 },
          receipts: { count: 3 },
          blockers: []
        }
      },
      beta: {
        [betaId]: {
          subject: 'beta',
          cycle_id: betaId,
          report: { available: true, tldr: 'Beta historical cycle' },
          diary: { available: true, items: [{ exec_id: 'exec-20260814-001', tldr: 'Beta diary' }] },
          verify: { available: false, semantic_status: null, verified_count: null, pending_count: null },
          receipts: { count: 1 },
          blockers: []
        }
      }
    },
    observability: {
      alpha: {
        subject: 'alpha',
        attention: { count: 1, highest_severity: 'info', backlog_count: 1 },
        open_cycles: 1
      },
      beta: {
        subject: 'beta',
        attention: { count: 0, highest_severity: null, backlog_count: 0 },
        open_cycles: 0
      },
      empty: {
        subject: 'empty',
        attention: { count: 0, highest_severity: null, backlog_count: 0 },
        open_cycles: 0
      }
    }
  }
}

export function createEvolutionFixtureClient(
  store: EvolutionFixtureStore = createEvolutionFixtureData()
): EvolutionFixtureClient {
  const listeners = new Set<(event: EvolutionEventEnvelope) => void>()
  const data: EvolutionFixtureStore = {
    lists: { ...store.lists },
    cycles: { ...store.cycles },
    rounds: { ...store.rounds },
    observability: { ...store.observability },
    errors: store.errors
  }
  const calls: EvolutionFixtureClient['calls'] = {
    listCycles: [],
    getCycle: [],
    getRound: [],
    getObservability: []
  }

  const client: EvolutionFixtureClient = {
    calls,
    async listCycles(subject) {
      calls.listCycles.push(subject)
      if (data.errors?.[subject]?.list !== undefined) {
        throw Object.assign(new Error('list failed'), { code: 'OPERATION_FAILED' })
      }
      const list = data.lists[subject]
      if (!list) throw Object.assign(new Error('subject missing'), { code: 'NOT_FOUND' })
      return clone(list)
    },
    async getCycle(subject, cycleId) {
      calls.getCycle.push({ subject, cycleId })
      if (data.errors?.[subject]?.cycle !== undefined) {
        throw Object.assign(new Error('cycle failed'), { code: 'OPERATION_FAILED' })
      }
      const cycle = data.cycles[subject]?.[cycleId]
      if (!cycle) throw Object.assign(new Error('cycle missing'), { code: 'NOT_FOUND' })
      return clone(cycle)
    },
    async getRound(subject, cycleId) {
      calls.getRound.push({ subject, cycleId })
      if (data.errors?.[subject]?.round !== undefined) {
        throw Object.assign(new Error('round failed'), { code: 'OPERATION_FAILED' })
      }
      const round = data.rounds[subject]?.[cycleId]
      if (!round) throw Object.assign(new Error('round missing'), { code: 'NOT_FOUND' })
      return clone(round)
    },
    async getObservability(subject) {
      calls.getObservability.push(subject)
      if (data.errors?.[subject]?.observability !== undefined) {
        throw Object.assign(new Error('observability failed'), { code: 'OPERATION_FAILED' })
      }
      const observability = data.observability[subject]
      if (!observability) throw Object.assign(new Error('observability missing'), { code: 'NOT_FOUND' })
      return clone(observability)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event) {
      for (const listener of listeners) listener(event)
    },
    replace(next) {
      if (next.lists) Object.assign(data.lists, next.lists)
      if (next.cycles) {
        for (const [subject, cycles] of Object.entries(next.cycles)) {
          data.cycles[subject] = { ...(data.cycles[subject] ?? {}), ...cycles }
        }
      }
      if (next.rounds) {
        for (const [subject, rounds] of Object.entries(next.rounds)) {
          data.rounds[subject] = { ...(data.rounds[subject] ?? {}), ...rounds }
        }
      }
      if (next.observability) Object.assign(data.observability, next.observability)
      if (next.errors) data.errors = { ...(data.errors ?? {}), ...next.errors }
    }
  }
  return client
}
