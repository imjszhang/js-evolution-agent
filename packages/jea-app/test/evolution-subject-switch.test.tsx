import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EvolutionInspector } from '../src/features/evolution/EvolutionInspector'
import { createEvolutionFixtureClient } from '../src/features/evolution/fixture-client'
import { createInspectorController } from '../src/features/evolution/controller'
import { LocaleProvider } from '../src/i18n/LocaleProvider'
import { createWave1Adapters } from '../src/fixtures/wave1'

describe('Evolution Inspector subject switch', () => {
  it('reloads the selected Subject and does not keep the previous cycle list', async () => {
    const client = createEvolutionFixtureClient()
    const controller = createInspectorController(client)
    const alpha = await controller.load('alpha')
    expect(alpha.list?.cycles.map((item) => item.cycle_id)).toEqual([
      'cycle-20260816-open',
      'cycle-20260815-closed'
    ])
    expect(alpha.selectedCycleId).toBe('cycle-20260816-open')

    const beta = await controller.load('beta')
    expect(beta.subject).toBe('beta')
    expect(beta.list?.cycles.map((item) => item.cycle_id)).toEqual(['cycle-20260814-beta'])
    expect(beta.selectedCycleId).toBe('cycle-20260814-beta')
    expect(beta.list?.cycles.some((item) => item.cycle_id.includes('alpha') || item.cycle_id.includes('20260816'))).toBe(false)
    expect(Object.keys(beta.cycles)).toEqual(['cycle-20260814-beta'])
    expect(client.calls.getCycle.filter((item) => item.subject === 'beta').map((item) => item.cycleId)).toEqual(['cycle-20260814-beta'])
    expect(client.calls.listCycles).toEqual(['alpha', 'beta'])

    const empty = await controller.load('empty')
    expect(empty.list?.cycles).toEqual([])
    expect(empty.selectedCycleId).toBeNull()

    const none = await controller.load(null)
    expect(none.subject).toBeNull()
    expect(none.list).toBeNull()
  })

  it('renders beta verify-unavailable and empty-subject safe states', () => {
    const betaHtml = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <EvolutionInspector
          slotId="evolutionInspector"
          adapters={createWave1Adapters({ selectedSubjectId: 'beta' })}
          snapshot={{
            subject: 'beta',
            list: {
              subject: 'beta',
              namespace: 'beta-data',
              round_count: 1,
              cycles: [{ cycle_id: 'cycle-20260814-beta', generated_at: '2026-08-14T00:00:00.000Z', tldr: 'Beta', has_diary: true, status: 'closed' }]
            },
            observability: { subject: 'beta', attention: { count: 0 }, open_cycles: 0 },
            cycles: {},
            rounds: {
              'cycle-20260814-beta': {
                subject: 'beta',
                cycle_id: 'cycle-20260814-beta',
                report: { available: true, tldr: 'Beta' },
                diary: { available: true, items: [] },
                verify: { available: false, semantic_status: null, verified_count: null, pending_count: null },
                receipts: { count: 1 },
                blockers: []
              }
            },
            selectedCycleId: 'cycle-20260814-beta',
            error: null
          }}
          loading={false}
        />
      </LocaleProvider>
    )
    expect(betaHtml).toContain('data-state="verify-unavailable"')
    expect(betaHtml).toContain('Verify is unavailable')

    const emptyHtml = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <EvolutionInspector
          slotId="evolutionInspector"
          adapters={createWave1Adapters({ selectedSubjectId: null, subjects: [] })}
          snapshot={{
            subject: null,
            list: null,
            observability: null,
            cycles: {},
            rounds: {},
            selectedCycleId: null,
            error: null
          }}
          loading={false}
        />
      </LocaleProvider>
    )
    expect(emptyHtml).toContain('data-state="no-subject"')
    expect(emptyHtml).toContain('Select a Subject')
  })
})
