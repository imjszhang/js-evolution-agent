/** @typedef {{ status?: string }|string} StepInfo */

export const PATCH_WORTHY_DAEMON_EVENTS = new Set([
  'cycle_step_completed',
  'cycle_step_enqueued',
  'cycle_event_dispatched',
  'task_claimed',
  'task_completed',
  'task_failed',
  'cycle_abandoned',
  'cycle_reconciled',
]);

/**
 * @param {Record<string, StepInfo|string>|null|undefined} steps
 */
export function stepsFingerprint(steps) {
  if (!steps || typeof steps !== 'object') return '';
  const out = {};
  for (const [name, raw] of Object.entries(steps)) {
    out[name] = typeof raw === 'string' ? raw : (raw?.status ?? 'pending');
  }
  return JSON.stringify(out);
}

/**
 * @param {object[]|null|undefined} tasks
 */
export function tasksFingerprint(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return '';
  const out = tasks.map((t) => ({
    task_id: t.task_id,
    type: t.type,
    status: t.status,
    attempts: t.attempts ?? 0,
  }));
  return JSON.stringify(out);
}

/**
 * @param {object|null|undefined} state
 */
export function daemonBarFingerprint(state) {
  if (!state) return '';
  const worker = state.worker ?? {};
  const health = state.health ?? {};
  const counts = state.tasks?.counts ?? {};
  const running = state.tasks?.running?.[0] ?? null;
  return JSON.stringify({
    health: health.status ?? null,
    worker_running: Boolean(worker.running),
    worker_stale: Boolean(worker.stale),
    counts: {
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      failed: counts.failed ?? 0,
    },
    running_task: running ? { task_id: running.task_id, type: running.type } : null,
    last_tick_at: state.last_tick_at ?? null,
  });
}

/**
 * @param {object|null|undefined} state
 */
export function activeCyclesFingerprint(state) {
  const cycles = state?.cycles?.recent ?? [];
  if (!Array.isArray(cycles) || !cycles.length) return '';
  const out = cycles.map((cycle) => ({
    cycle_id: cycle.cycle_id,
    status: cycle.status ?? null,
    steps: cycle.steps ?? {},
    abandoned: Boolean(cycle.meta?.abandoned),
  }));
  return JSON.stringify(out);
}

/**
 * @param {object} data
 * @param {'cycle'|'round'} mode
 */
export function buildDetailCacheFromData(data, mode) {
  const diaries = data.diaries ?? [];
  return {
    cycle_id: data.cycle_id,
    mode,
    steps_fp: stepsFingerprint(data.steps),
    cycle_status: data.cycle_status ?? null,
    tasks_fp: mode === 'cycle' ? tasksFingerprint(data.tasks) : '',
    diary_count: diaries.length,
    has_report: Boolean(data.has_report ?? data.report_html),
  };
}

/**
 * @param {ReturnType<typeof buildDetailCacheFromData>} cache
 * @param {object} data
 * @param {'cycle'|'round'} mode
 */
export function detailCacheNeedsPatch(cache, data, mode) {
  if (!cache || cache.cycle_id !== data.cycle_id || cache.mode !== mode) {
    return { header: true, tasks: mode === 'cycle', diary: true };
  }
  const next = buildDetailCacheFromData(data, mode);
  return {
    header: cache.steps_fp !== next.steps_fp || cache.cycle_status !== next.cycle_status,
    tasks: mode === 'cycle' && cache.tasks_fp !== next.tasks_fp,
    diary: cache.diary_count !== next.diary_count,
  };
}
