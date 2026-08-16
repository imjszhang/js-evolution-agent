import { describe, expect, it } from 'vitest'
import {
  EVOLUTION_OPEN_CYCLE_EVENT,
  openEvolutionCycle,
  resetEvolutionNavigation,
  subscribeEvolutionNavigation
} from '../src/features/evolution/navigation'

describe('Evolution conversation navigation helper', () => {
  it('notifies subscribers with a stable cycle id callback', () => {
    resetEvolutionNavigation()
    const seen: Array<{ cycleId: string; subject?: string }> = []
    const stop = subscribeEvolutionNavigation((detail) => seen.push(detail))
    openEvolutionCycle('  ', 'alpha')
    openEvolutionCycle('cycle-20260815-closed', 'alpha')
    openEvolutionCycle('cycle-only')
    expect(seen).toEqual([
      { cycleId: 'cycle-20260815-closed', subject: 'alpha' },
      { cycleId: 'cycle-only' }
    ])
    stop()
    openEvolutionCycle('cycle-after-unsub')
    expect(seen).toHaveLength(2)
    expect(EVOLUTION_OPEN_CYCLE_EVENT).toBe('jea:evolution:open-cycle')
    resetEvolutionNavigation()
  })
})
