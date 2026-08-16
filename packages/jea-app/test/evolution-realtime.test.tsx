import { describe, expect, it } from 'vitest'
import { createEvolutionFixtureClient, createEvolutionFixtureData } from '../src/features/evolution/fixture-client'
import { createInspectorController } from '../src/features/evolution/controller'
import { mergeCycleRecords, shouldRefreshForEvent } from '../src/features/evolution/projection'

describe('Evolution Inspector realtime refresh', () => {
  it('refreshes the active Subject without duplicating cycles or touching another Subject', async () => {
    const store = createEvolutionFixtureData()
    const client = createEvolutionFixtureClient(store)
    const controller = createInspectorController(client)
    await controller.load('alpha')
    const firstListCalls = client.calls.listCycles.length

    const ignored = await controller.handleEvent({
      type: 'evolution.updated',
      ts: '2026-08-16T02:00:00.000Z',
      subject: 'beta',
      payload: { subject: 'beta', cycle_id: 'cycle-20260814-beta' }
    })
    expect(ignored).toBeNull()
    expect(client.calls.listCycles.length).toBe(firstListCalls)

    const updated = {
      cycle_id: 'cycle-20260816-open',
      generated_at: '2026-08-16T01:30:00.000Z',
      tldr: 'Open reactor cycle (updated)',
      has_diary: false,
      status: 'open' as const
    }
    client.replace({
      lists: {
        alpha: {
          ...store.lists.alpha,
          cycles: [updated, store.lists.alpha.cycles[1]]
        }
      }
    })

    const next = await controller.handleEvent({
      type: 'evolution.updated',
      ts: '2026-08-16T02:01:00.000Z',
      subject: 'alpha',
      payload: { subject: 'alpha', cycle_id: 'cycle-20260816-open' }
    })
    expect(next?.list?.cycles.map((item) => item.cycle_id)).toEqual([
      'cycle-20260816-open',
      'cycle-20260815-closed'
    ])
    expect(next?.list?.cycles.filter((item) => item.cycle_id === 'cycle-20260816-open')).toHaveLength(1)
    expect(next?.list?.cycles[0]?.tldr).toBe('Open reactor cycle (updated)')
    expect(next?.selectedCycleId).toBe('cycle-20260816-open')
  })

  it('ignores unrelated event types and merges cycle records by id', () => {
    expect(shouldRefreshForEvent({ type: 'conversation.updated', subject: 'alpha' }, 'alpha')).toBe(false)
    expect(shouldRefreshForEvent({ type: 'evolution.updated', subject: 'alpha' }, 'beta')).toBe(false)
    expect(shouldRefreshForEvent({ type: 'evolution.updated', payload: { subject: 'alpha' } }, 'alpha')).toBe(true)
    expect(mergeCycleRecords(
      [{ cycle_id: 'a' }, { cycle_id: 'b' }],
      [{ cycle_id: 'a' }, { cycle_id: 'a' }, { cycle_id: 'c' }]
    ).map((item) => item.cycle_id)).toEqual(['a', 'c', 'b'])
  })
})
