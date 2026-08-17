import { describe, expect, it } from 'vitest'
import { resolveSafeState } from '../src/features/evolution/projection'
import {
  sanitizeCycleDetail,
  sanitizeCycleList,
  sanitizeObservability,
  sanitizeRoundDetail
} from '../src/features/evolution/sanitize'
import type { EvolutionInspectorSnapshot } from '../src/features/evolution/types'

describe('Evolution Inspector malformed data', () => {
  it('drops invalid cycles, duplicate ids, and non-object payloads', () => {
    expect(sanitizeCycleList(null)).toBeNull()
    expect(sanitizeCycleList('nope')).toBeNull()
    expect(sanitizeCycleList({ subject: 'alpha', cycles: [{}, { cycle_id: 'c1' }, { cycle_id: 'c1' }, 3] })?.cycles).toEqual([
      { cycle_id: 'c1', generated_at: null, tldr: null, has_diary: false, status: null }
    ])
    expect(sanitizeCycleDetail({ subject: 'alpha' })).toBeNull()
    expect(sanitizeCycleDetail({
      subject: 'alpha',
      cycle_id: 'c1',
      steps: { exec: { status: 'failed', error: 'boom' }, bad: null },
      blockers: ['boom', 'boom', 1]
    })?.blockers).toEqual(['boom'])
    expect(sanitizeRoundDetail({
      subject: 'alpha',
      cycle_id: 'c1',
      report: 'bad',
      diary: { items: [{ exec_id: 'e1' }, { exec_id: 'e1' }, null] },
      verify: { available: true, verified_count: 'x' },
      receipts: { count: 'nope' }
    })).toMatchObject({
      diary: { items: [{ exec_id: 'e1', tldr: null }] },
      verify: { available: true, verified_count: null },
      receipts: { count: 0 }
    })
    expect(sanitizeObservability({ attention: [] })).toBeNull()
    expect(sanitizeObservability({ subject: 'alpha', open_cycles: '1' })?.open_cycles).toBe(0)
  })

  it('uses an explicit malformed safe state when optional files are missing', () => {
    const snapshot: EvolutionInspectorSnapshot = {
      subject: 'alpha',
      list: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 1,
        cycles: [{ cycle_id: 'broken', generated_at: null, tldr: null, has_diary: false, status: null }]
      },
      observability: { subject: 'alpha', attention: {}, open_cycles: 0 },
      cycles: { broken: null },
      rounds: { broken: null },
      selectedCycleId: 'broken',
      error: null
    }
    expect(resolveSafeState(snapshot, false)).toBe('malformed')
    expect(resolveSafeState({ ...snapshot, subject: null, list: null, selectedCycleId: null }, false)).toBe('no-subject')
    expect(resolveSafeState({ ...snapshot, list: { ...snapshot.list!, cycles: [], round_count: 0 }, selectedCycleId: null }, false)).toBe('empty')
    expect(resolveSafeState({ ...snapshot, error: 'unavailable' }, false)).toBe('error')
    expect(resolveSafeState({ ...snapshot, stale: true }, false)).toBe('stale')
    expect(resolveSafeState({ ...snapshot, stale: true, error: 'offline' }, false)).toBe('offline')
  })
})
