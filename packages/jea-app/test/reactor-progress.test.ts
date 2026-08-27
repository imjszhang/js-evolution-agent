import { describe, expect, it } from 'vitest'
import { createSubjectReadinessFixture } from '../src/features/fixtures'
import {
  displaySchedulerState,
  heartbeatAliveNoReplayFixture,
  isTruthfulCatchingUp,
  projectReactorControlPlane,
  REACTOR_FRESHNESS_FIXTURES,
  REACTOR_FRESHNESS_STATUSES,
  REACTOR_PROGRESS_FIXTURES,
  REACTOR_SCHEDULER_STATES,
  sanitizeReactorProgress,
  sumLane
} from '../src/features/reactor-progress'
import { projectEvolutionRuntime, projectOperatorSurface } from '../src/features/operator-projection'

const observabilityBase = {
  subject: 'alpha',
  attention: { items: [], summary: { count: 0 } },
  open_cycles: 0,
  evidence_pending_count: 8055,
  daemon_task_pending_count: 0
}

describe('reactor progress product projection', () => {
  it('covers every scheduler_state fixture without treating heartbeat as progress', () => {
    for (const state of REACTOR_SCHEDULER_STATES) {
      const progress = REACTOR_PROGRESS_FIXTURES[state]
      const plane = projectReactorControlPlane({
        host: 'electron',
        progress,
        observability: { ...observabilityBase, reactor_progress: progress }
      })
      expect(plane.progress?.scheduler_state).toBe(state)
      expect(plane.heartbeat_implies_progress).toBe(false)
      expect(plane.overlap_additive).toBe(false)
      expect(plane.evidence_is_work_count).toBe(false)
      if (state === 'catching_up') {
        expect(plane.catching_up_truthful).toBe(true)
        expect(plane.display_state).toBe('catching_up')
        expect(progress.activity?.current_task?.lane).toBe('replay')
        expect(progress.activity?.last_progress_at).toBeTruthy()
      } else {
        expect(plane.display_state).not.toBe('catching_up')
      }
    }
  })

  it('covers every freshness status on last-good snapshots', () => {
    for (const status of REACTOR_FRESHNESS_STATUSES) {
      const progress = REACTOR_FRESHNESS_FIXTURES[status]
      const plane = projectReactorControlPlane({ host: 'web', progress })
      expect(plane.freshness).toBe(status)
      expect(plane.projection_generation).toBeTruthy()
    }
  })

  it('does not show catching_up when the worker is alive and replay is idle', () => {
    const progress = heartbeatAliveNoReplayFixture()
    expect(progress.worker_liveness.alive).toBe(true)
    expect(progress.reactors.cognitive.replay.ready).toBe(8055)
    expect(progress.activity?.current_task).toBeUndefined()
    expect(isTruthfulCatchingUp(progress)).toBe(false)
    expect(displaySchedulerState(progress)).toBe('listening')
    const runtime = projectEvolutionRuntime(
      createSubjectReadinessFixture({ host: 'electron', cycle: 'running' }),
      { ...observabilityBase, reactor_progress: progress }
    )
    expect(runtime.intent).toBe('listening')
    expect(runtime.remaining_evidence).toBe(8055 + 20 + 4) // Cognitive + Rule + Memory open, not evidence_pending_count
  })

  it('rejects a lying catching_up snapshot that only has a heartbeat', () => {
    const lying = sanitizeReactorProgress({
      ...heartbeatAliveNoReplayFixture(),
      scheduler_state: 'catching_up',
      activity: {},
      worker_liveness: { alive: true, heartbeat_at: '2026-08-26T00:00:00.000Z' }
    })
    expect(isTruthfulCatchingUp(lying)).toBe(false)
    expect(displaySchedulerState(lying)).not.toBe('catching_up')
  })

  it('labels overlapping reactor counts as non-additive and never sums them into one work total', () => {
    const progress = REACTOR_PROGRESS_FIXTURES.listening
    const plane = projectReactorControlPlane({ host: 'electron', progress })
    expect(plane.overlap_additive).toBe(false)
    expect(plane.lanes.map((lane) => lane.reactor)).toEqual(['cognitive', 'rule', 'memory'])
    const cognitiveReplay = progress.reactors.cognitive.replay.ready
    const ruleReplay = progress.reactors.rule.replay.ready
    const memoryReplay = progress.reactors.memory.replay.ready
    expect(cognitiveReplay + ruleReplay + memoryReplay).toBeGreaterThan(cognitiveReplay)
    expect(plane.replay_ready).toBe(sumLane(progress, 'replay', 'ready'))
    expect(plane.progress?.reactor_overlap.additive).toBe(false)
    expect(plane.progress?.evidence_authority?.is_work_count).toBe(false)
  })

  it('keeps Electron and Web read snapshots identical while restricting local-only actions on Web', () => {
    const progress = REACTOR_PROGRESS_FIXTURES.queued
    const readiness = createSubjectReadinessFixture({
      host: 'electron',
      cycle: 'stopped',
      channel: 'stopped'
    })
    readiness.actions = readiness.actions.map((action) => ({
      ...action,
      allowed: action.id === 'start_cycle' || action.id === 'process_cycle_once' || action.id === 'pause_automatic_evolution'
    }))
    readiness.product_actions = [
      { id: 'pause_automatic_evolution', allowed: true, capability: 'write' },
      { id: 'check_now', allowed: true, capability: 'write' }
    ]
    const electron = projectReactorControlPlane({ host: 'electron', progress, readiness })
    const web = projectReactorControlPlane({ host: 'web', progress, readiness })
    expect(web.progress).toEqual(electron.progress)
    expect(web.display_state).toBe(electron.display_state)
    expect(web.realtime_ready).toBe(electron.realtime_ready)
    expect(electron.actions.find((action) => action.id === 'start_worker')?.allowed).toBe(true)
    expect(web.actions.find((action) => action.id === 'start_worker')?.allowed).toBe(false)
    expect(web.actions.find((action) => action.id === 'start_worker')?.reason).toBe('local_only_open_desktop')
    expect(web.actions.find((action) => action.id === 'start_replay_plan')?.allowed).toBe(false)
    expect(web.actions.find((action) => action.id === 'raise_budget')?.allowed).toBe(false)
    expect(web.actions.find((action) => action.id === 'raise_budget')?.reason).toBe('cli_llm_budget_only')
  })

  it('keeps budget-paused from auto-raising and points recovery at CLI', () => {
    const readiness = createSubjectReadinessFixture({
      host: 'electron',
      cycle: 'running',
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
    readiness.automation = { ...readiness.automation!, intent: 'paused_budget', blocker: 'rule_llm_budget_exhausted' }
    const plane = projectReactorControlPlane({
      host: 'electron',
      readiness,
      progress: REACTOR_PROGRESS_FIXTURES.paused_budget
    })
    expect(plane.display_state).toBe('paused_budget')
    expect(plane.actions.find((action) => action.id === 'check_now')?.allowed).toBe(false)
    expect(plane.actions.find((action) => action.id === 'check_now')?.reason).toBe('stay_budget_paused')
    expect(plane.actions.find((action) => action.id === 'raise_budget')?.allowed).toBe(false)
  })

  it('does not remap pending evidence to catching_up on the operator surface', () => {
    const readiness = createSubjectReadinessFixture({ host: 'electron', cycle: 'stalled' })
    const projection = projectOperatorSurface({
      readiness,
      host: 'electron',
      evolution: { roundCount: 4, openCycles: 0, latestStatus: 'closed', latestTldr: 'Latest cycle completed.' },
      observability: observabilityBase
    })
    expect(projection.evolution_runtime.intent).not.toBe('catching_up')
    expect(projection.evolution_runtime.remaining_evidence).toBe(0)
    expect(projection.reactor_control_plane.catching_up_truthful).toBe(false)
  })
})
