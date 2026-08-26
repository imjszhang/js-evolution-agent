/**
 * Product-layer Reactor control-plane projection.
 * Consumes Client API `ReactorProgressProjection` only — no scheduler or ledger writes.
 */
import type {
  ProductEvolutionIntent,
  ProductHostKind,
  ReactorFreshnessStatus,
  ReactorLaneCounts,
  ReactorProgressProjection,
  ReactorSchedulerState,
  RemediationActionView,
  SubjectReadiness
} from './client-types'
import type { EvolutionObservability } from './evolution/types'

export const REACTOR_SCHEDULER_STATES = [
  'listening',
  'queued',
  'running',
  'catching_up',
  'paused_budget',
  'blocked',
  'waiting_approval',
  'stalled'
] as const satisfies readonly ReactorSchedulerState[]

export const REACTOR_FRESHNESS_STATUSES = [
  'fresh',
  'stale',
  'reconciling',
  'degraded',
  'unknown'
] as const satisfies readonly ReactorFreshnessStatus[]

const SCHEDULER_SET = new Set<string>(REACTOR_SCHEDULER_STATES)
const FRESHNESS_SET = new Set<string>(REACTOR_FRESHNESS_STATUSES)
const LANES = new Set(['realtime', 'replay'])

export type ReactorActionId =
  | 'pause_automatic_evolution'
  | 'resume_automatic_evolution'
  | 'check_now'
  | 'process_cycle_once'
  | 'start_worker'
  | 'stop_worker'
  | 'start_replay_plan'
  | 'raise_budget'
  | 'view_blocker'
  | 'open_desktop'

export interface ReactorActionView {
  id: ReactorActionId
  allowed: boolean
  capability: 'readonly' | 'write' | 'local-only'
  reason: string | null
  command: string | null
}

export interface ReactorLaneSummary {
  reactor: string
  realtime: ReactorLaneCounts
  replay: ReactorLaneCounts
}

export interface ReactorControlPlaneView {
  progress: ReactorProgressProjection | null
  scheduler_state: ReactorSchedulerState | null
  display_state: ProductEvolutionIntent
  freshness: ReactorFreshnessStatus
  freshness_reason: string | null
  projection_generation: string | number | null
  worker_alive: boolean
  heartbeat_implies_progress: false
  catching_up_truthful: boolean
  overlap_additive: false
  evidence_is_work_count: false
  lanes: ReactorLaneSummary[]
  realtime_ready: number
  replay_ready: number
  primary_blocker: string | null
  actions: ReactorActionView[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asCount(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function emptyLane(): ReactorLaneCounts {
  return { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 0 }
}

function adaptLane(value: unknown): ReactorLaneCounts | null {
  const lane = asRecord(value)
  if (!lane) return null
  const ready = asCount(lane.ready)
  const claimed = asCount(lane.claimed)
  const deferred = asCount(lane.deferred)
  const blocked = asCount(lane.blocked)
  const handled = asCount(lane.handled_total)
  if (ready == null || claimed == null || deferred == null || blocked == null || handled == null) {
    return null
  }
  return {
    ready,
    claimed,
    deferred,
    blocked,
    handled_total: handled,
    open_total: asCount(lane.open_total) ?? (ready + claimed + deferred + blocked)
  }
}

/**
 * Browser-safe pass-through of the Client API snapshot.
 * Does not invent scheduler names or fabricate healthy/zero counts.
 */
export function sanitizeReactorProgress(input: unknown): ReactorProgressProjection | null {
  const snapshot = asRecord(input)
  if (!snapshot) return null
  const freshness = asRecord(snapshot.freshness)
  const liveness = asRecord(snapshot.worker_liveness)
  const freshnessStatus = asString(freshness?.status)
  const alive = asBoolean(liveness?.alive)
  if (!asString(snapshot.schema_version) || snapshot.projection_generation == null || !freshness || !liveness) {
    return null
  }
  if (!freshnessStatus || !FRESHNESS_SET.has(freshnessStatus) || alive == null) return null

  const activity = asRecord(snapshot.activity)
  const currentTask = asRecord(activity?.current_task)
  const currentClaim = asRecord(activity?.current_claim)
  const currentBatch = asRecord(activity?.current_batch)
  const limits = asRecord(snapshot.limits)
  const stop = asRecord(snapshot.stop_reason)
  const overlap = asRecord(snapshot.reactor_overlap)
  const authority = asRecord(snapshot.evidence_authority)
  const schedulerState = asString(snapshot.scheduler_state)
  const reactors: ReactorProgressProjection['reactors'] = {}
  const rawReactors = asRecord(snapshot.reactors) ?? {}
  for (const [name, counts] of Object.entries(rawReactors)) {
    const lanes = asRecord(counts)
    if (!lanes) continue
    const realtime = adaptLane(lanes.realtime)
    const replay = adaptLane(lanes.replay)
    if (!realtime || !replay) continue
    reactors[name] = { realtime, replay }
  }

  const adapted: ReactorProgressProjection = {
    schema_version: String(snapshot.schema_version),
    subject: asString(snapshot.subject),
    projection_generation: snapshot.projection_generation as string | number,
    projected_at: asString(snapshot.projected_at) || new Date().toISOString(),
    freshness: {
      as_of: asString(freshness.as_of) || new Date().toISOString(),
      status: freshnessStatus as ReactorFreshnessStatus,
      stale_after_ms: asCount(freshness.stale_after_ms) ?? undefined,
      reason: asString(freshness.reason) ?? undefined
    },
    worker_liveness: {
      alive,
      heartbeat_at: asString(liveness.heartbeat_at) ?? undefined
    },
    reactors,
    reactor_overlap: {
      additive: false,
      note: asString(overlap?.note) || 'reactor_counts_may_overlap_authoritative_evidence'
    }
  }
  if (activity) {
    adapted.activity = {
      current_stage: asString(activity.current_stage) ?? undefined,
      last_progress_at: asString(activity.last_progress_at) ?? undefined,
      current_task: currentTask && asString(currentTask.id)
        ? {
          id: String(currentTask.id),
          type: asString(currentTask.type) ?? undefined,
          lane: LANES.has(String(currentTask.lane || ''))
            ? String(currentTask.lane) as 'realtime' | 'replay'
            : undefined
        }
        : undefined,
      current_claim: currentClaim
        ? {
          claim_id: asString(currentClaim.claim_id) ?? undefined,
          reactor: asString(currentClaim.reactor) ?? undefined,
          lane: LANES.has(String(currentClaim.lane || ''))
            ? String(currentClaim.lane) as 'realtime' | 'replay'
            : undefined
        }
        : undefined,
      current_batch: currentBatch
        ? {
          batch_id: asString(currentBatch.batch_id) ?? undefined,
          candidate_id: asString(currentBatch.candidate_id) ?? undefined
        }
        : undefined
    }
  }
  if (limits) {
    adapted.limits = {
      replay_batch_limit: asCount(limits.replay_batch_limit) ?? undefined,
      replay_wall_clock_ms: asCount(limits.replay_wall_clock_ms) ?? undefined,
      token_reserve: asCount(limits.token_reserve) ?? undefined,
      spend_allowance: asCount(limits.spend_allowance) ?? undefined
    }
  }
  if (stop && asString(stop.class) && asString(stop.code)) {
    adapted.stop_reason = {
      class: String(stop.class),
      code: String(stop.code),
      detail: asString(stop.detail) ?? undefined
    }
  }
  if (schedulerState && SCHEDULER_SET.has(schedulerState)) {
    adapted.scheduler_state = schedulerState as ReactorSchedulerState
  }
  if (authority) {
    adapted.evidence_authority = {
      envelope_count: asCount(authority.envelope_count) ?? undefined,
      is_work_count: false
    }
  }
  return adapted
}

export function resolveReactorProgress(
  observability?: EvolutionObservability | null,
  dedicated?: ReactorProgressProjection | null
): ReactorProgressProjection | null {
  return dedicated ?? observability?.reactor_progress ?? null
}

export function hasActiveReplayWork(progress: ReactorProgressProjection | null | undefined): boolean {
  if (!progress?.activity) return false
  return progress.activity.current_task?.lane === 'replay'
    || progress.activity.current_claim?.lane === 'replay'
}

export function hasRecentProgress(progress: ReactorProgressProjection | null | undefined): boolean {
  return Boolean(asString(progress?.activity?.last_progress_at))
}

/**
 * catching_up is valid only with an active replay task/claim and a last-progress timestamp.
 * Heartbeat / worker_liveness.alive never qualifies.
 */
export function isTruthfulCatchingUp(progress: ReactorProgressProjection | null | undefined): boolean {
  return progress?.scheduler_state === 'catching_up'
    && hasActiveReplayWork(progress)
    && hasRecentProgress(progress)
}

export function displaySchedulerState(
  progress: ReactorProgressProjection | null | undefined,
  automationMode?: 'automatic' | 'paused' | null
): ProductEvolutionIntent {
  if (automationMode === 'paused') return 'paused'
  const state = progress?.scheduler_state
  if (state === 'catching_up') {
    return isTruthfulCatchingUp(progress) ? 'catching_up' : fallbackWithoutCatchUp(progress)
  }
  if (state && SCHEDULER_SET.has(state)) return state
  return fallbackWithoutCatchUp(progress)
}

function fallbackWithoutCatchUp(progress: ReactorProgressProjection | null | undefined): ProductEvolutionIntent {
  if (progress?.stop_reason?.class === 'paused_budget' || progress?.stop_reason?.code?.includes('budget')) {
    return 'paused_budget'
  }
  if (progress?.stop_reason) return 'blocked'
  const realtimeReady = sumLane(progress, 'realtime', 'ready')
  const replayReady = sumLane(progress, 'replay', 'ready')
  if (realtimeReady > 0 || replayReady > 0) return 'queued'
  return 'listening'
}

export function sumLane(
  progress: ReactorProgressProjection | null | undefined,
  lane: 'realtime' | 'replay',
  field: keyof ReactorLaneCounts
): number {
  if (!progress) return 0
  let total = 0
  for (const counts of Object.values(progress.reactors)) {
    const value = counts[lane][field]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/**
 * Per-reactor lane rows. Never add Cognitive+Rule+Memory into one work total.
 */
export function projectReactorLanes(progress: ReactorProgressProjection | null | undefined): ReactorLaneSummary[] {
  if (!progress) return []
  return Object.entries(progress.reactors).map(([reactor, lanes]) => ({
    reactor,
    realtime: lanes.realtime ?? emptyLane(),
    replay: lanes.replay ?? emptyLane()
  }))
}

function action(
  id: ReactorActionId,
  allowed: boolean,
  capability: ReactorActionView['capability'],
  reason: string | null,
  command: string | null
): ReactorActionView {
  return { id, allowed, capability, reason, command }
}

function readinessAction(readiness: SubjectReadiness | null | undefined, id: string): RemediationActionView | undefined {
  return (readiness?.product_actions ?? readiness?.actions ?? []).find((item) => item.id === id)
}

export function projectReactorActions(input: {
  readiness?: SubjectReadiness | null
  progress?: ReactorProgressProjection | null
  host: ProductHostKind
  displayState: ProductEvolutionIntent
}): ReactorActionView[] {
  const { readiness, progress, host, displayState } = input
  const product = new Map((readiness?.product_actions ?? []).map((item) => [item.id, item]))
  const diagnostic = new Map((readiness?.actions ?? []).map((item) => [item.id, item]))
  const paused = displayState === 'paused' || readiness?.automation?.mode === 'paused'
  const budgetPaused = displayState === 'paused_budget'
    || readiness?.llm_budget?.state === 'exhausted'

  const pause = product.get('pause_automatic_evolution')
  const resume = product.get('resume_automatic_evolution')
  const check = product.get('check_now') ?? diagnostic.get('process_cycle_once')
  const processOnce = diagnostic.get('process_cycle_once')
  const startCycle = diagnostic.get('start_cycle')
  const stopManaged = diagnostic.get('stop_managed')
  const viewBlocker = product.get('view_blocker')
  const openDesktop = diagnostic.get('open_desktop') ?? product.get('open_desktop')

  const startAllowed = host === 'electron' && Boolean(startCycle?.allowed)
  const stopAllowed = host === 'electron' && Boolean(stopManaged?.allowed)
  const localOnlyReason = host === 'web'
    ? 'local_only_open_desktop'
    : null

  const replayReady = sumLane(progress, 'replay', 'ready')
  const replayPlanReason = 'no_replay_plan_command'
  const raiseReason = 'cli_llm_budget_only'

  return [
    action(
      'pause_automatic_evolution',
      Boolean(pause?.allowed) && !paused,
      'write',
      pause?.allowed && !paused ? null : (paused ? 'already_paused' : 'pause_not_allowed'),
      'service.setAutomation'
    ),
    action(
      'resume_automatic_evolution',
      Boolean(resume?.allowed) && paused,
      'write',
      resume?.allowed && paused ? null : 'resume_not_allowed',
      'service.setAutomation'
    ),
    action(
      'check_now',
      Boolean(check?.allowed) && !budgetPaused,
      'write',
      budgetPaused
        ? 'stay_budget_paused'
        : (check?.allowed ? null : 'check_now_not_allowed'),
      'service.processCycleOnce'
    ),
    action(
      'process_cycle_once',
      Boolean(processOnce?.allowed) && !budgetPaused,
      'write',
      budgetPaused
        ? 'stay_budget_paused'
        : (processOnce?.allowed ? null : 'process_once_not_allowed'),
      'service.processCycleOnce'
    ),
    action(
      'start_worker',
      startAllowed,
      'local-only',
      startAllowed ? null : (localOnlyReason ?? 'start_worker_not_allowed'),
      startAllowed ? 'service.start' : null
    ),
    action(
      'stop_worker',
      stopAllowed,
      'local-only',
      stopAllowed ? null : (localOnlyReason ?? 'stop_worker_not_allowed'),
      stopAllowed ? 'service.stop' : null
    ),
    action(
      'start_replay_plan',
      false,
      'write',
      replayReady > 0 || displayState === 'catching_up'
        ? replayPlanReason
        : 'no_replay_ready',
      null
    ),
    action(
      'raise_budget',
      false,
      'readonly',
      raiseReason,
      null
    ),
    action(
      'view_blocker',
      Boolean(viewBlocker?.allowed || progress?.stop_reason || readiness?.llm_budget?.state === 'exhausted'),
      'readonly',
      viewBlocker?.allowed || progress?.stop_reason || readiness?.llm_budget?.state === 'exhausted'
        ? null
        : 'no_blocker',
      null
    ),
    action(
      'open_desktop',
      host === 'web' && Boolean(openDesktop?.allowed || localOnlyReason),
      'readonly',
      host === 'web' ? 'local_only_open_desktop' : 'electron_host',
      null
    )
  ]
}

export function projectReactorControlPlane(input: {
  readiness?: SubjectReadiness | null
  observability?: EvolutionObservability | null
  progress?: ReactorProgressProjection | null
  host: ProductHostKind
}): ReactorControlPlaneView {
  const progress = sanitizeReactorProgress(input.progress)
    ?? resolveReactorProgress(input.observability, input.readiness?.reactor_progress ?? null)
  const displayState = displaySchedulerState(progress, input.readiness?.automation?.mode)
  const lanes = projectReactorLanes(progress)
  return {
    progress,
    scheduler_state: progress?.scheduler_state ?? null,
    display_state: displayState,
    freshness: progress?.freshness.status ?? 'unknown',
    freshness_reason: progress?.freshness.reason ?? null,
    projection_generation: progress?.projection_generation ?? null,
    worker_alive: progress?.worker_liveness.alive === true,
    heartbeat_implies_progress: false,
    catching_up_truthful: isTruthfulCatchingUp(progress),
    overlap_additive: false,
    evidence_is_work_count: false,
    lanes,
    realtime_ready: sumLane(progress, 'realtime', 'ready'),
    replay_ready: sumLane(progress, 'replay', 'ready'),
    primary_blocker: progress?.stop_reason?.code
      ?? input.readiness?.automation?.blocker
      ?? input.readiness?.llm_budget?.blocked_reason
      ?? null,
    actions: projectReactorActions({
      readiness: input.readiness,
      progress,
      host: input.host,
      displayState
    })
  }
}

export function emptyLaneCounts(): ReactorLaneCounts {
  return emptyLane()
}

export function createReactorProgressFixture(
  state: ReactorSchedulerState,
  extras: Partial<ReactorProgressProjection> = {}
): ReactorProgressProjection {
  const now = extras.projected_at ?? '2026-08-26T00:00:00.000Z'
  const replayActive = state === 'catching_up'
  const realtimeActive = state === 'running'
  const queued = state === 'queued'
  const budget = state === 'paused_budget'
  const blocked = state === 'blocked' || state === 'waiting_approval' || state === 'stalled'
  const base: ReactorProgressProjection = {
    schema_version: '0.3.0',
    subject: extras.subject ?? 'alpha',
    projection_generation: extras.projection_generation ?? 4,
    projected_at: now,
    freshness: extras.freshness ?? { as_of: now, status: 'fresh' },
    worker_liveness: extras.worker_liveness ?? {
      alive: state !== 'blocked',
      heartbeat_at: now
    },
    scheduler_state: state,
    activity: extras.activity ?? {
      current_task: realtimeActive
        ? { id: 'task-realtime-1', type: 'cognitive_reaction', lane: 'realtime' }
        : replayActive
          ? { id: 'task-replay-1', type: 'cognitive_replay', lane: 'replay' }
          : undefined,
      current_claim: realtimeActive
        ? { claim_id: 'claim-rt-1', reactor: 'cognitive', lane: 'realtime' }
        : replayActive
          ? { claim_id: 'claim-rp-1', reactor: 'cognitive', lane: 'replay' }
          : undefined,
      current_batch: realtimeActive || replayActive
        ? { batch_id: 'batch-1', candidate_id: 'candidate-1' }
        : undefined,
      current_stage: realtimeActive ? 'cognitive_report' : replayActive ? 'replay_batch' : undefined,
      last_progress_at: realtimeActive || replayActive || state === 'stalled' ? now : undefined
    },
    limits: extras.limits ?? {
      replay_batch_limit: 8,
      replay_wall_clock_ms: 30_000,
      token_reserve: 12_000,
      spend_allowance: 2
    },
    stop_reason: extras.stop_reason ?? (
      budget
        ? { class: 'paused_budget', code: 'rule_llm_budget_exhausted', detail: 'token period exhausted' }
        : blocked && state === 'waiting_approval'
          ? { class: 'waiting_approval', code: 'requires_human_approval' }
          : blocked && state === 'stalled'
            ? { class: 'stalled', code: 'checkpoint_stale' }
            : blocked
              ? { class: 'blocked', code: 'cycle_stopped' }
              : undefined
    ),
    reactors: extras.reactors ?? {
      cognitive: {
        realtime: { ready: queued || realtimeActive ? 2 : 0, claimed: realtimeActive ? 1 : 0, deferred: 0, blocked: 0, handled_total: 3, open_total: queued || realtimeActive ? 2 : realtimeActive ? 1 : 0 },
        replay: { ready: replayActive || queued ? 5 : 8055, claimed: replayActive ? 1 : 0, deferred: budget ? 4 : 0, blocked: 0, handled_total: 10, open_total: replayActive ? 6 : 8055 }
      },
      rule: {
        realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 1, open_total: 0 },
        replay: { ready: 2, claimed: 0, deferred: 0, blocked: 0, handled_total: 4, open_total: 2 }
      },
      memory: {
        realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 1, open_total: 0 },
        replay: { ready: 1, claimed: 0, deferred: 0, blocked: 0, handled_total: 2, open_total: 1 }
      }
    },
    reactor_overlap: extras.reactor_overlap ?? {
      additive: false,
      note: 'reactor_counts_may_overlap_authoritative_evidence'
    },
    evidence_authority: extras.evidence_authority ?? {
      envelope_count: 9000,
      is_work_count: false
    }
  }
  return { ...base, ...extras, scheduler_state: state, reactor_overlap: { additive: false, note: base.reactor_overlap.note } }
}

export const REACTOR_PROGRESS_FIXTURES: Record<ReactorSchedulerState, ReactorProgressProjection> = {
  listening: createReactorProgressFixture('listening', {
    worker_liveness: { alive: true, heartbeat_at: '2026-08-26T00:00:00.000Z' },
    activity: {},
    reactors: {
      cognitive: {
        realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 3, open_total: 0 },
        replay: { ready: 8055, claimed: 0, deferred: 0, blocked: 0, handled_total: 10, open_total: 8055 }
      },
      rule: {
        realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 1, open_total: 0 },
        replay: { ready: 20, claimed: 0, deferred: 0, blocked: 0, handled_total: 4, open_total: 20 }
      },
      memory: {
        realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 1, open_total: 0 },
        replay: { ready: 4, claimed: 0, deferred: 0, blocked: 0, handled_total: 2, open_total: 4 }
      }
    }
  }),
  queued: createReactorProgressFixture('queued'),
  running: createReactorProgressFixture('running'),
  catching_up: createReactorProgressFixture('catching_up'),
  paused_budget: createReactorProgressFixture('paused_budget', {
    worker_liveness: { alive: true, heartbeat_at: '2026-08-26T00:00:00.000Z' },
    activity: {}
  }),
  blocked: createReactorProgressFixture('blocked', {
    worker_liveness: { alive: false }
  }),
  waiting_approval: createReactorProgressFixture('waiting_approval', {
    worker_liveness: { alive: true, heartbeat_at: '2026-08-26T00:00:00.000Z' }
  }),
  stalled: createReactorProgressFixture('stalled', {
    worker_liveness: { alive: true, heartbeat_at: '2026-08-26T00:00:00.000Z' },
    activity: {
      current_task: { id: 'task-stalled-1', type: 'cognitive_replay', lane: 'replay' },
      current_claim: { claim_id: 'claim-stale', reactor: 'cognitive', lane: 'replay' },
      current_stage: 'replay_batch',
      last_progress_at: '2026-08-25T00:00:00.000Z'
    }
  })
}

export const REACTOR_FRESHNESS_FIXTURES: Record<ReactorFreshnessStatus, ReactorProgressProjection> = {
  fresh: createReactorProgressFixture('listening', { freshness: { as_of: '2026-08-26T00:00:00.000Z', status: 'fresh' } }),
  stale: createReactorProgressFixture('listening', { freshness: { as_of: '2026-08-25T00:00:00.000Z', status: 'stale', reason: 'heartbeat_window_exceeded' } }),
  reconciling: createReactorProgressFixture('listening', { freshness: { as_of: '2026-08-26T00:00:00.000Z', status: 'reconciling', reason: 'incremental_rebuild' } }),
  degraded: createReactorProgressFixture('listening', { freshness: { as_of: '2026-08-26T00:00:00.000Z', status: 'degraded', reason: 'activation_ledger_unresolved' } }),
  unknown: createReactorProgressFixture('listening', { freshness: { as_of: '2026-08-26T00:00:00.000Z', status: 'unknown', reason: 'activation_ledger_unresolved' } })
}

export function heartbeatAliveNoReplayFixture(): ReactorProgressProjection {
  return REACTOR_PROGRESS_FIXTURES.listening
}

export { readinessAction }
