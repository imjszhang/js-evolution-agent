import { describe, expect, it } from 'vitest'
import { createSubjectReadinessFixture } from '../src/features/fixtures'
import {
  OPERATOR_COUNT_SOURCES,
  projectEvolutionSummary,
  projectOperatorSurface
} from '../src/features/operator-projection'

const observability = {
  subject: 'alpha',
  attention: {
    items: [{
      severity: 'warning',
      kind: 'daemon_health',
      status: 'active',
      category: 'current',
      blocking: true,
      title: 'Daemon needs attention',
      summary: 'A worker is stale.'
    }],
    summary: { count: 1 }
  },
  open_cycles: 0,
  evidence_pending_count: 7,
  daemon_task_pending_count: 3
}

describe('operator surface projection', () => {
  it('derives the real summary from Client API cycle and observability projections', () => {
    const summary = projectEvolutionSummary({
      subject: 'alpha',
      namespace: 'alpha-data',
      round_count: 9,
      cycles: [
        {
          cycle_id: 'older',
          generated_at: '2026-08-20T00:00:00.000Z',
          tldr: 'Older summary.',
          has_diary: true,
          status: 'closed'
        },
        {
          cycle_id: 'latest',
          generated_at: '2026-08-21T00:00:00.000Z',
          tldr: 'Latest real summary.',
          has_diary: false,
          status: 'open'
        }
      ]
    }, {
      ...observability,
      open_cycles: 2
    })

    expect(summary).toEqual({
      roundCount: 9,
      openCycles: 2,
      latestStatus: 'open',
      latestTldr: 'Latest real summary.'
    })
  })

  it('keeps mixed-domain truth and each count source separate', () => {
    const readiness = createSubjectReadinessFixture({
      host: 'electron',
      channel: 'running',
      conversation: 'running',
      cycle: 'stalled'
    })
    readiness.actions = readiness.actions.map((action) => ({
      ...action,
      allowed: action.id === 'process_cycle_once'
    }))
    readiness.allowed_actions = ['process_cycle_once']
    const projection = projectOperatorSurface({
      readiness,
      observability,
      host: 'electron',
      evolution: {
        roundCount: 4,
        openCycles: 0,
        latestStatus: 'closed',
        latestTldr: 'Latest cycle completed.'
      }
    })

    expect(projection.conversation_readiness.state).toBe('running')
    expect(projection.evolution_summary.latestStatus).toBe('closed')
    expect(projection.observability_attention.count).toBe(1)
    expect(projection.evidence_pending).toEqual({ count: 7, ...OPERATOR_COUNT_SOURCES.evidencePending })
    expect(projection.daemon_task_pending).toEqual({ count: 3, ...OPERATOR_COUNT_SOURCES.daemonTaskPending })
    expect(projection.allowed_remediation_actions.map((action) => action.id)).toEqual(['process_cycle_once'])
    expect(projection.evolution_runtime.intent).toBe('catching_up')
    expect(projection.evolution_runtime.remaining_evidence).toBe(7)
  })

  it('does not infer evidence from flattened attention fields and hides local actions on Web', () => {
    const readiness = createSubjectReadinessFixture({ host: 'web', channel: 'stopped', cycle: 'stopped' })
    const projection = projectOperatorSurface({
      readiness,
      host: 'web',
      evolution: { roundCount: 0, openCycles: 0, latestStatus: null, latestTldr: null },
      observability: {
        ...observability,
        evidence_pending_count: 0,
        attention: { ...observability.attention, backlog_count: 99 } as typeof observability.attention
      }
    })

    expect(projection.evidence_pending.count).toBe(0)
    expect(projection.allowed_remediation_actions.every((action) => action.capability !== 'local-only')).toBe(true)
  })
})
