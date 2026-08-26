import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaClientProvider } from '../src/features/client-context'
import { createSubjectReadinessFixture } from '../src/features/fixtures'
import { EvolutionInspector } from '../src/features/evolution/EvolutionInspector'
import { ReactorProgressPanel } from '../src/features/evolution/ReactorProgressPanel'
import { createWave1Adapters } from '../src/fixtures/wave1'
import { LocaleProvider } from '../src/i18n/LocaleProvider'
import {
  REACTOR_FRESHNESS_FIXTURES,
  REACTOR_FRESHNESS_STATUSES,
  REACTOR_PROGRESS_FIXTURES,
  REACTOR_SCHEDULER_STATES
} from '../src/features/reactor-progress'
import type { EvolutionInspectorSnapshot } from '../src/features/evolution/types'

function renderPanel(
  state: keyof typeof REACTOR_PROGRESS_FIXTURES,
  host: 'electron' | 'web' = 'electron',
  extras: Partial<React.ComponentProps<typeof ReactorProgressPanel>> = {}
) {
  const progress = REACTOR_PROGRESS_FIXTURES[state]
  const readiness = createSubjectReadinessFixture({
    host,
    cycle: state === 'blocked' ? 'stopped' : 'running',
    channel: 'running',
    conversation: 'running'
  })
  readiness.reactor_progress = progress
  readiness.product_actions = [
    { id: 'pause_automatic_evolution', allowed: true, capability: 'write' },
    { id: 'check_now', allowed: true, capability: 'write' },
    { id: 'view_blocker', allowed: true, capability: 'readonly' }
  ]
  return renderToStaticMarkup(
    <LocaleProvider initialLocale="en">
      <JeaClientProvider host={host}>
        <ReactorProgressPanel
          readiness={readiness}
          observability={{
            subject: 'alpha',
            attention: { items: [], summary: {} },
            open_cycles: 0,
            reactor_progress: progress
          }}
          host={host}
          {...extras}
        />
      </JeaClientProvider>
    </LocaleProvider>
  )
}

describe('ReactorProgressPanel', () => {
  it('renders a distinct fixture for every scheduler_state', () => {
    for (const state of REACTOR_SCHEDULER_STATES) {
      const html = renderPanel(state)
      expect(html).toContain('data-testid="reactor-progress"')
      expect(html).toContain(`data-scheduler-state="${state === 'catching_up' ? 'catching_up' : state === 'listening' ? 'listening' : state}"`)
      expect(html).toContain('data-overlap-additive="false"')
      expect(html).toContain('data-evidence-is-work="false"')
      expect(html).toContain('Cognitive, Rule, and Memory counts may overlap')
      expect(html).toContain('data-testid="reactor-action-start_replay_plan"')
      expect(html).toContain('data-allowed="false"')
    }
  })

  it('renders honest freshness labels for last-good snapshots', () => {
    for (const status of REACTOR_FRESHNESS_STATUSES) {
      const progress = REACTOR_FRESHNESS_FIXTURES[status]
      const html = renderToStaticMarkup(
        <LocaleProvider initialLocale="en">
          <ReactorProgressPanel
            observability={{
              subject: 'alpha',
              attention: { items: [], summary: {} },
              open_cycles: 0,
              reactor_progress: progress
            }}
            host="web"
          />
        </LocaleProvider>
      )
      expect(html).toContain(`data-freshness="${status}"`)
      expect(html).toContain('generation 4')
    }
  })

  it('shows listening, not catching_up, for heartbeat-alive replay debt', () => {
    const html = renderPanel('listening')
    expect(html).toContain('data-scheduler-state="listening"')
    expect(html).toContain('data-catching-up="false"')
    expect(html).toContain('data-worker-alive="true"')
    expect(html).toContain('8055')
    expect(html).not.toContain('data-scheduler-state="catching_up"')
    expect(html).toContain('alive (heartbeat only)')
  })

  it('shows catching_up details only for an active replay task', () => {
    const html = renderPanel('catching_up')
    expect(html).toContain('data-catching-up="true"')
    expect(html).toContain('task-replay-1')
    expect(html).toContain('replay_batch')
    expect(html).toContain('replay batch 8')
  })

  it('disables local-only worker actions on Web with the same read snapshot', () => {
    const electron = renderPanel('queued', 'electron')
    const web = renderPanel('queued', 'web')
    expect(web).toContain('data-scheduler-state="queued"')
    expect(electron).toContain('data-scheduler-state="queued"')
    expect(electron).toContain('data-testid="reactor-action-start_worker"')
    expect(web).toContain('Desktop app or CLI')
    expect(web).toContain('data-allowed="false"')
  })

  it('surfaces budget used/remaining/limit and CLI recovery without a mutate control', () => {
    const readiness = createSubjectReadinessFixture({
      host: 'electron',
      cycle: 'running',
      blocker: 'rule_llm_budget_exhausted',
      llmBudget: {
        schema: 'llm_budget_status.v1',
        period_id: 'period-legacy',
        state: 'exhausted',
        used_tokens: 989000,
        remaining_tokens: 11000,
        token_budget: 1000000,
        used_spend_usd: 2.34,
        remaining_spend_usd: 7.66,
        spend_budget_usd: 10,
        cycle_admission: 'parked',
        shared_ledger: true,
        blocked_reason: 'llm_token_budget_exhausted'
      }
    })
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <ReactorProgressPanel
          readiness={readiness}
          observability={{
            subject: 'alpha',
            attention: { items: [], summary: {} },
            open_cycles: 0,
            reactor_progress: REACTOR_PROGRESS_FIXTURES.paused_budget
          }}
          host="electron"
        />
      </LocaleProvider>
    )
    expect(html).toContain('data-scheduler-state="paused_budget"')
    expect(html).toContain('989000/1000000 tokens remaining 11000')
    expect(html).toContain('jea llm budget raise')
    expect(html).not.toContain('data-testid="reactor-action-raise_budget"')
  })

  it('mounts the panel inside Evolution Inspector from a last-good snapshot', () => {
    const progress = REACTOR_PROGRESS_FIXTURES.listening
    const snapshot: EvolutionInspectorSnapshot = {
      subject: 'alpha',
      list: { subject: 'alpha', namespace: 'alpha-data', round_count: 0, cycles: [] },
      observability: {
        subject: 'alpha',
        attention: { items: [], summary: {} },
        open_cycles: 0,
        evidence_pending_count: 8055,
        reactor_progress: progress
      },
      cycles: {},
      rounds: {},
      selectedCycleId: null,
      error: null
    }
    const html = renderToStaticMarkup(
      <LocaleProvider initialLocale="en">
        <EvolutionInspector
          slotId="evolutionInspector"
          adapters={createWave1Adapters({ selectedSubjectId: 'alpha' })}
          snapshot={snapshot}
          loading={false}
        />
      </LocaleProvider>
    )
    expect(html).toContain('data-testid="reactor-progress"')
    expect(html).toContain('data-scheduler-state="listening"')
    expect(html).toContain('Listening for evidence')
  })
})
