/**
 * Client API data-shape adapter for the 0.3.0 Reactor progress snapshot.
 * No scheduling or activation decisions — pass through validated backend fields.
 */
import type { ReactorProgressProjection } from './types'

const FRESHNESS = new Set(['fresh', 'stale', 'reconciling', 'degraded', 'unknown'])
const LANES = new Set(['realtime', 'replay'])
const SCHEDULER_STATES = new Set([
  'listening',
  'queued',
  'running',
  'catching_up',
  'paused_budget',
  'blocked',
  'waiting_approval',
  'stalled'
])

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

function adaptLane(value: unknown) {
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

function adaptReactorCounts(value: unknown) {
  const reactors = asRecord(value)
  if (!reactors) return {}
  const next: ReactorProgressProjection['reactors'] = {}
  for (const [name, counts] of Object.entries(reactors)) {
    const lanes = asRecord(counts)
    if (!lanes) continue
    const realtime = adaptLane(lanes.realtime)
    const replay = adaptLane(lanes.replay)
    if (!realtime || !replay) continue
    next[name] = { realtime, replay }
  }
  return next
}

/**
 * Shape the backend snapshot for Electron and Web. Do not invent scheduler
 * state names or fabricate zero/healthy counts.
 */
export function adaptReactorProgressProjection(input: unknown): ReactorProgressProjection | null {
  const snapshot = asRecord(input)
  if (!snapshot) return null
  const freshness = asRecord(snapshot.freshness)
  const liveness = asRecord(snapshot.worker_liveness)
  const freshnessStatus = asString(freshness?.status)
  const alive = asBoolean(liveness?.alive)
  if (!asString(snapshot.schema_version) || snapshot.projection_generation == null || !freshness || !liveness) {
    return null
  }
  if (!freshnessStatus || !FRESHNESS.has(freshnessStatus) || alive == null) return null

  const activity = asRecord(snapshot.activity)
  const currentTask = asRecord(activity?.current_task)
  const currentClaim = asRecord(activity?.current_claim)
  const currentBatch = asRecord(activity?.current_batch)
  const limits = asRecord(snapshot.limits)
  const stop = asRecord(snapshot.stop_reason)
  const overlap = asRecord(snapshot.reactor_overlap)
  const authority = asRecord(snapshot.evidence_authority)
  const schedulerState = asString(snapshot.scheduler_state)
  const adapted: ReactorProgressProjection = {
    schema_version: String(snapshot.schema_version),
    subject: asString(snapshot.subject),
    projection_generation: snapshot.projection_generation as string | number,
    projected_at: asString(snapshot.projected_at) || new Date().toISOString(),
    freshness: {
      as_of: asString(freshness.as_of) || new Date().toISOString(),
      status: freshnessStatus as ReactorProgressProjection['freshness']['status'],
      stale_after_ms: asCount(freshness.stale_after_ms) ?? undefined,
      reason: asString(freshness.reason) ?? undefined
    },
    worker_liveness: {
      alive,
      heartbeat_at: asString(liveness.heartbeat_at) ?? undefined
    },
    reactors: adaptReactorCounts(snapshot.reactors),
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
  if (schedulerState && SCHEDULER_STATES.has(schedulerState)) {
    adapted.scheduler_state = schedulerState as ReactorProgressProjection['scheduler_state']
  }
  if (authority) {
    adapted.evidence_authority = {
      envelope_count: asCount(authority.envelope_count) ?? undefined,
      is_work_count: false
    }
  }
  if (asRecord(snapshot.sources)) adapted.sources = asRecord(snapshot.sources) as ReactorProgressProjection['sources']
  if (asRecord(snapshot.throughput)) adapted.throughput = asRecord(snapshot.throughput) as ReactorProgressProjection['throughput']
  return adapted
}
