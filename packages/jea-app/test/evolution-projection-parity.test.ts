import { describe, expect, it } from 'vitest'
import { createEvolutionFixtureData } from '../src/features/evolution/fixture-client'
import { coreFromLegacy, projectEvolutionCore } from '../src/features/evolution/projection'
import { sanitizeCycleDetail, sanitizeCycleList, sanitizeObservability, sanitizeRoundDetail } from '../src/features/evolution/sanitize'

describe('Evolution Inspector projection parity', () => {
  it('matches fixture core counts, status, and verify conclusions', () => {
    const data = createEvolutionFixtureData()
    const list = sanitizeCycleList(data.lists.alpha)
    const cycle = sanitizeCycleDetail(data.cycles.alpha['cycle-20260815-closed'])
    const round = sanitizeRoundDetail(data.rounds.alpha['cycle-20260815-closed'])
    const observability = sanitizeObservability(data.observability.alpha)
    expect(list && cycle && round && observability).toBeTruthy()
    if (!list || !cycle || !round || !observability) return

    const fromClient = projectEvolutionCore({
      subject: 'alpha',
      list,
      observability,
      cycles: { [cycle.cycle_id]: cycle },
      rounds: { [round.cycle_id]: round },
      selectedCycleId: cycle.cycle_id,
      error: null
    })
    const fromLegacyShape = coreFromLegacy({
      subject: 'alpha',
      namespace: list.namespace,
      list,
      cycle,
      round,
      observability
    })

    expect(fromClient).toEqual(fromLegacyShape)
    expect(fromClient.round_count).toBe(2)
    expect(fromClient.open_cycles).toBe(1)
    expect(fromClient.cycle_status).toBe('closed')
    expect(fromClient.verify_available).toBe(true)
    expect(fromClient.verify_semantic_status).toBe('ok')
    expect(fromClient.verified_count).toBe(2)
    expect(fromClient.pending_count).toBe(0)
    expect(fromClient.receipt_count).toBe(3)
    expect(fromClient.diary_count).toBe(1)
    expect(fromClient.report_available).toBe(true)
    expect(fromClient.blocker_count).toBe(0)
    expect(fromClient.step_count).toBe(4)
  })

  it('projects an open cycle with verify unavailable as a safe open state', () => {
    const data = createEvolutionFixtureData()
    const list = data.lists.alpha
    const cycle = data.cycles.alpha['cycle-20260816-open']
    const core = projectEvolutionCore({
      subject: 'alpha',
      list,
      observability: data.observability.alpha,
      cycles: { [cycle.cycle_id]: cycle },
      rounds: {},
      selectedCycleId: cycle.cycle_id,
      error: null
    })
    expect(core.selected_kind).toBe('open')
    expect(core.verify_available).toBe(false)
    expect(core.report_available).toBe(false)
    expect(core.receipt_count).toBe(0)
  })
})
