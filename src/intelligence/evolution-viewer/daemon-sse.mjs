/** @typedef {'daemon_event'|'round_added'|'round_updated'} SseMappingKind */

export const DAEMON_SSE_EVENT_TYPES = new Set([
  'worker_started',
  'worker_stopped',
  'worker_start_failed',
  'daemon_tick',
  'cycle_due',
  'cycle_step_enqueued',
  'cycle_event_dispatched',
  'cycle_step_completed',
  'cycle_reconciled',
  'cycle_abandoned',
  'task_enqueued',
  'task_claimed',
  'task_completed',
  'task_failed',
  'task_lease_renewed',
  'task_lease_renew_failed',
  'stale_lease_reclaimed',
  'evolution_mode_changed',
  'cycle_start_requested',
  'cycle_start_consumed',
  'cycle_start_deferred',
]);

const DEFAULT_TICK_MS = 300_000;

/**
 * @param {object} event
 * @returns {object|null}
 */
export function formatDaemonEventForApi(event) {
  if (!event?.type || !DAEMON_SSE_EVENT_TYPES.has(event.type)) return null;
  const payload = {
    event_type: event.type,
    status: event.status ?? null,
    cycle_id: event.cycle_id ?? null,
    task_id: event.task_id ?? null,
    step_type: event.step_type ?? null,
    task_type: event.task_type ?? null,
    recorded_at: event.recorded_at ?? event.timestamp ?? null,
    reason: event.reason ?? null,
    error_code: event.error_code ?? null,
  };
  if (event.type === 'evolution_mode_changed') {
    payload.from = event.from ?? null;
    payload.to = event.to ?? null;
    payload.source = event.source ?? null;
    payload.trigger = event.trigger ?? null;
  }
  return payload;
}

/**
 * Map evolution JSONL line to daemon SSE payload.
 * @param {object} event
 * @returns {{ kind: 'daemon_event', payload: object }|null}
 */
export function daemonSseFromEvolutionLine(event) {
  const payload = formatDaemonEventForApi(event);
  if (!payload) return null;
  return { kind: 'daemon_event', payload };
}

function eventTimestamp(event) {
  return event.recorded_at ?? event.timestamp ?? '';
}

function sortEventsNewestFirst(events) {
  return [...events].sort((a, b) => eventTimestamp(b).localeCompare(eventTimestamp(a)));
}

/**
 * @param {object[]} events - newest-first or any order
 * @returns {{ tick_ms: number, last_tick_at: string|null }}
 */
export function extractTickHintsFromEvents(events) {
  let tickMs = DEFAULT_TICK_MS;
  let lastTickAt = null;

  for (const event of sortEventsNewestFirst(events)) {
    if (!event?.type) continue;
    if (event.type === 'daemon_tick' && !lastTickAt) {
      lastTickAt = eventTimestamp(event) || null;
    }
    if (event.type === 'worker_started' && event.tick_ms != null) {
      const parsed = Number(event.tick_ms);
      if (Number.isFinite(parsed) && parsed > 0) tickMs = parsed;
    }
  }

  return { tick_ms: tickMs, last_tick_at: lastTickAt };
}

/**
 * @param {import('../store.mjs').IntelligenceStore} store
 * @param {string} subject
 * @param {number} [scanLimit=50]
 */
export function readTickHints(store, subject, scanLimit = 50) {
  if (!store?.readEvolutionEvents) {
    return { tick_ms: DEFAULT_TICK_MS, last_tick_at: null };
  }
  const events = store.readEvolutionEvents({ limit: scanLimit })
    .filter((event) => !event.subject || event.subject === subject);
  return extractTickHintsFromEvents(events);
}

/**
 * @param {import('../store.mjs').IntelligenceStore} store
 * @param {string} subject
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function readRecentDaemonEvents(store, subject, limit = 50) {
  if (!store?.readEvolutionEvents) return [];
  return sortEventsNewestFirst(
    store.readEvolutionEvents({ limit: Math.max(limit, 50) })
      .filter((event) => {
        if (event.subject && event.subject !== subject) return false;
        return DAEMON_SSE_EVENT_TYPES.has(event.type);
      }),
  )
    .map((event) => formatDaemonEventForApi(event))
    .filter(Boolean)
    .slice(0, limit);
}
