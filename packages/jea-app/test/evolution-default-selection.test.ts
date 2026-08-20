import { describe, expect, it } from 'vitest'
import { pickDefaultCycleId, projectTimeline } from '../src/features/evolution/projection'
import { sanitizeObservability } from '../src/features/evolution/sanitize'
import type { EvolutionCycleSummary, EvolutionInspectorSnapshot } from '../src/features/evolution/types'

function summary(cycle_id: string, status: string | null = null): EvolutionCycleSummary {
  return {
    cycle_id,
    generated_at: '2026-08-19T00:00:00.000Z',
    tldr: cycle_id,
    has_diary: false,
    status
  }
}

function snapshot(partial: Partial<EvolutionInspectorSnapshot> & Pick<EvolutionInspectorSnapshot, 'list' | 'observability'>): EvolutionInspectorSnapshot {
  return {
    subject: 'alpha',
    cycles: {},
    rounds: {},
    selectedCycleId: null,
    error: null,
    ...partial
  }
}

describe('pickDefaultCycleId', () => {
  it('prefers a listed open/running/active cycle without loaded details', () => {
    const list = {
      subject: 'alpha',
      namespace: 'alpha-data',
      round_count: 2,
      cycles: [summary('cycle-hist', 'closed'), summary('cycle-open', 'open')]
    }
    expect(pickDefaultCycleId(snapshot({
      list,
      observability: { subject: 'alpha', attention: {}, open_cycles: 1 }
    }))).toBe('cycle-open')
    expect(pickDefaultCycleId(snapshot({
      list: { ...list, cycles: [summary('cycle-run', 'running'), summary('cycle-hist', 'closed')] },
      observability: { subject: 'alpha', attention: {}, open_cycles: 1 }
    }))).toBe('cycle-run')
  })

  it('uses cycle_diagnostics.recent when list status is missing', () => {
    expect(pickDefaultCycleId(snapshot({
      list: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 2,
        cycles: [summary('cycle-hist'), summary('cycle-open')]
      },
      observability: {
        subject: 'alpha',
        attention: {},
        open_cycles: 1,
        cycle_diagnostics: {
          recent: [{ cycle_id: 'cycle-open', status: 'open' }]
        }
      }
    }))).toBe('cycle-open')
  })

  it('ignores attention.cycle_id because that field is not part of getObservability', () => {
    const selected = pickDefaultCycleId(snapshot({
      list: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 2,
        cycles: [summary('cycle-first', 'closed'), summary('cycle-decoy', 'closed')]
      },
      observability: {
        subject: 'alpha',
        attention: { cycle_id: 'cycle-decoy', items: [], summary: {}, backlog_count: 0 },
        open_cycles: 0
      }
    }))
    expect(selected).toBe('cycle-first')
    expect(selected).not.toBe('cycle-decoy')
  })

  it('does not invent attention.cycle_id when sanitizing observability', () => {
    const sanitized = sanitizeObservability({
      subject: 'alpha',
      attention: { items: [], summary: 'none', backlog_count: 0 },
      open_cycles: 1,
      cycle_diagnostics: { recent: [{ cycle_id: 'cycle-open', status: 'active' }] }
    })
    expect(sanitized?.attention).not.toHaveProperty('cycle_id')
    expect(sanitized?.cycle_diagnostics?.recent).toEqual([{ cycle_id: 'cycle-open', status: 'active' }])
  })

  it('projects unloaded timeline items as summary-only without step chips', () => {
    const view = projectTimeline(snapshot({
      list: {
        subject: 'alpha',
        namespace: 'alpha-data',
        round_count: 1,
        cycles: [summary('cycle-hist', 'closed')]
      },
      observability: { subject: 'alpha', attention: {}, open_cycles: 0 }
    }))
    expect(view[0]?.steps).toEqual([])
    expect(view[0]?.status).toBe('closed')
  })
})
