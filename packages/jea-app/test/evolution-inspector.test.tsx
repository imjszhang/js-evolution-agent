import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaApp } from '../src/JeaApp'
import { EvolutionInspector } from '../src/features/evolution/EvolutionInspector'
import { createEvolutionFixtureClient, createEvolutionFixtureData } from '../src/features/evolution/fixture-client'
import { createEvolutionInspectorFeature } from '../src/features/evolution/feature'
import { EVOLUTION_PARITY_INVENTORY } from '../src/features/evolution/parity-inventory'
import { pickDefaultCycleId, projectEvolutionCore, projectTimeline } from '../src/features/evolution/projection'
import type { EvolutionInspectorSnapshot } from '../src/features/evolution/types'
import { createWave1Adapters } from '../src/fixtures/wave1'
import { LocaleProvider } from '../src/i18n/LocaleProvider'
import type { FeatureSlotProps } from '../src/slots/types'

function snapshotFromFixture(subject = 'alpha', selectedCycleId?: string | null): EvolutionInspectorSnapshot {
  const data = createEvolutionFixtureData()
  const list = data.lists[subject] ?? null
  const cycles = data.cycles[subject] ?? {}
  const rounds = data.rounds[subject] ?? {}
  const observability = data.observability[subject] ?? null
  const selected = selectedCycleId === undefined
    ? pickDefaultCycleId({ list, cycles, observability })
    : selectedCycleId
  return {
    subject,
    list,
    observability,
    cycles,
    rounds,
    selectedCycleId: selected,
    error: null
  }
}

function renderInspector(snapshot: EvolutionInspectorSnapshot, extras: Partial<FeatureSlotProps['adapters']> = {}) {
  const adapters = createWave1Adapters({
    selectedSubjectId: snapshot.subject,
    ...extras
  })
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <EvolutionInspector
        slotId="evolutionInspector"
        adapters={adapters}
        snapshot={snapshot}
        loading={false}
        navFixtureCycleId="cycle-20260815-closed"
      />
    </LocaleProvider>
  )
}

describe('Evolution Inspector component', () => {
  it('registers through the evolutionInspector slot without editing the App shell', () => {
    const html = renderToStaticMarkup(
      <JeaApp
        locale="en"
        features={[createEvolutionInspectorFeature({ client: createEvolutionFixtureClient() })]}
      />
    )
    expect(html).toContain('data-slot="evolutionInspector"')
    expect(html).toContain('data-testid="evolution-inspector"')
    expect(html).toContain('data-testid="column-conversation"')
    expect(html).toContain('data-testid="conversation-draft"')
  })

  it('shows the open cycle first and a compact timeline with steps', () => {
    const snapshot = snapshotFromFixture('alpha')
    const html = renderInspector(snapshot)
    expect(html).toContain('data-state="open"')
    expect(html).toContain('cycle-20260816-open')
    expect(html).toContain('cycle-20260815-closed')
    expect(html).toContain('data-testid="evolution-timeline"')
    expect(html).toContain('reactor')
    expect(html).toContain('data-testid="evolution-open-cycle-fixture"')
    const core = projectEvolutionCore(snapshot)
    expect(core.selected_cycle_id).toBe('cycle-20260816-open')
    expect(core.selected_kind).toBe('open')
    expect(projectTimeline(snapshot)[0]?.steps.some((step) => step.name === 'reactor')).toBe(true)
  })

  it('renders report, diary, verify, and evidence summaries for a historical cycle', () => {
    const snapshot = snapshotFromFixture('alpha', 'cycle-20260815-closed')
    const html = renderInspector(snapshot)
    expect(html).toContain('data-state="historical"')
    expect(html).toContain('Closed historical cycle')
    expect(html).toContain('data-testid="evolution-section-report"')
    expect(html).toContain('data-testid="evolution-section-diary"')
    expect(html).toContain('data-testid="evolution-section-verify"')
    expect(html).toContain('data-testid="evolution-section-evidence"')
    const core = projectEvolutionCore(snapshot)
    expect(core.report_available).toBe(true)
    expect(core.diary_count).toBe(1)
    expect(core.verify_semantic_status).toBe('ok')
    expect(core.receipt_count).toBe(3)
  })

  it('renders a visible stale state instead of keeping a green open status', () => {
    const html = renderInspector({
      ...snapshotFromFixture('alpha'),
      stale: true
    })
    expect(html).toContain('data-state="stale"')
    expect(html).toContain('data-stale="true"')
    expect(html).toContain('Evolution status is stale')
    expect(html).not.toContain('data-state="open"')
  })

  it('keeps timeline and section controls keyboard reachable', () => {
    const html = renderInspector(snapshotFromFixture('alpha'))
    expect(html).toContain('data-testid="evolution-cycle-cycle-20260816-open"')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-label="Cycle timeline"')
  })

  it('records a complete parity inventory without treating deferred as removed', () => {
    const marks = new Set(EVOLUTION_PARITY_INVENTORY.map((item) => item.mark))
    expect(marks.has('included')).toBe(true)
    expect(marks.has('legacy-only')).toBe(true)
    expect(marks.has('deferred')).toBe(true)
    expect(EVOLUTION_PARITY_INVENTORY.every((item) => item.feature.length > 0)).toBe(true)
    expect(EVOLUTION_PARITY_INVENTORY.filter((item) => item.mark === 'deferred').every((item) => /not implied removed|read-only|remains/i.test(item.notes))).toBe(true)
  })
})
