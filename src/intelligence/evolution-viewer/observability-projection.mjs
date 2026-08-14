import { readPendingOperatorBriefs } from '../operator-briefs.mjs';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

const STALE_BRIEF_MS = 30 * 60 * 1000;

/**
 * @param {object} item
 */
function pushAttention(items, item) {
  if (!item?.title) return;
  const status = item.status ?? 'active';
  const blocking = item.blocking ?? status === 'active';
  items.push({
    severity: item.severity ?? 'info',
    kind: item.kind ?? 'general',
    status,
    category: item.category ?? (status === 'needs_ack' ? 'history' : 'current'),
    blocking,
    title: item.title,
    summary: item.summary ?? '',
    subject: item.subject,
    refs: item.refs ?? {},
    suggested_command: item.suggested_command ?? null,
  });
}

/**
 * @param {object[]} items
 */
export function summarizeAttention(items) {
  if (!items?.length) {
    return {
      count: 0,
      active_count: 0,
      historical_count: 0,
      blocking_count: 0,
      highest_severity: null,
      highest_active_severity: null,
      critical: 0,
      warning: 0,
      info: 0,
    };
  }
  const sorted = [...items].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const activeItems = items.filter((item) => item.status === 'active' && item.blocking !== false);
  const activeSorted = [...activeItems].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const counts = { critical: 0, warning: 0, info: 0 };
  const activeCounts = { active_critical: 0, active_warning: 0, active_info: 0 };
  for (const item of items) {
    if (counts[item.severity] != null) counts[item.severity] += 1;
    if (item.status === 'active' && item.blocking !== false) {
      const key = `active_${item.severity}`;
      if (activeCounts[key] != null) activeCounts[key] += 1;
    }
  }
  return {
    count: items.length,
    active_count: activeItems.length,
    historical_count: items.filter((item) => item.category === 'history' || item.status === 'needs_ack').length,
    blocking_count: activeItems.length,
    highest_severity: sorted[0]?.severity ?? null,
    highest_active_severity: activeSorted[0]?.severity ?? null,
    ...counts,
    ...activeCounts,
  };
}

function attentionFromDaemonHealth(subject, health) {
  const items = [];
  if (!health) return items;
  const status = health.status ?? 'unknown';
  if (health.ok !== false && (status === 'healthy' || status === 'idle')) {
    return items;
  }
  pushAttention(items, {
    severity: health.ok === false ? 'critical' : 'warning',
    kind: 'daemon_health',
    title: `Daemon: ${status}`,
    summary: (health.reasons ?? []).join(' · ') || 'Daemon health check',
    subject,
    suggested_command: `npm run jea -- daemon doctor --subject ${subject} --json`,
  });
  if (health.ok === false && health.suggestions?.length && items.length) {
    items[items.length - 1].summary = [
      items[items.length - 1].summary,
      health.suggestions[0],
    ].filter(Boolean).join(' — ');
  }
  return items;
}

function attentionFromReactor(subject, reactor) {
  const items = [];
  if (!reactor || reactor.ok !== false) return items;
  const details = [
    reactor.pending_verify?.count
      ? `pending verify: ${reactor.pending_verify.count}`
      : null,
    reactor.exec_intents?.uncertain
      ? `uncertain intents: ${reactor.exec_intents.uncertain}`
      : null,
    reactor.rule?.due_windows
      ? `rule windows due: ${reactor.rule.due_windows}`
      : null,
    reactor.memory?.due
      ? `memory due: ${reactor.memory.reason || 'yes'}`
      : null,
    reactor.lease?.stale ? 'lease stale' : null,
  ].filter(Boolean);
  pushAttention(items, {
    severity: 'critical',
    kind: 'reactor_backlog',
    title: `Reactor: ${reactor.status}`,
    summary: [
      (reactor.reasons ?? []).join(' · ') || 'Reactor backlog is stalled.',
      details.join(' · '),
    ].filter(Boolean).join(' — '),
    subject,
    refs: { reactor },
    suggested_command: `npm run jea -- daemon doctor --subject ${subject} --json`,
  });
  return items;
}

function attentionFromCycles(subject, cycles, { pipeline = null } = {}) {
  const items = [];
  if (pipeline === 'reactor') return items;
  for (const stuck of cycles?.stuck_steps ?? []) {
    pushAttention(items, {
      severity: 'critical',
      kind: 'stuck_step',
      title: `Step 卡住: ${stuck.step}`,
      summary: `${stuck.cycle_id}: ${stuck.reason ?? 'stuck'}`,
      subject,
      refs: { cycle_id: stuck.cycle_id, step: stuck.step },
      suggested_command: `npm run jea -- daemon doctor --subject ${subject} --json`,
    });
  }
  for (const drift of cycles?.drift_steps ?? []) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'step_drift',
      title: `Step 漂移: ${drift.step}`,
      summary: `${drift.cycle_id}: ${drift.reason ?? 'drift'}`,
      subject,
      refs: { cycle_id: drift.cycle_id, step: drift.step },
      suggested_command: `npm run jea -- daemon status --subject ${subject} --json`,
    });
  }
  if (cycles?.progress_stalled) {
    pushAttention(items, {
      severity: 'critical',
      kind: 'cycle_progress_stalled',
      title: 'Cycle 进展停滞',
      summary: `Open cycles: ${cycles.open_count ?? 0}`,
      subject,
      suggested_command: `npm run jea -- daemon doctor --subject ${subject} --json`,
    });
  }
  return items;
}

function daemonIsCurrentlyHealthy(health, cycles, { pipeline = null, reactor = null } = {}) {
  if (pipeline === 'reactor') {
    return health?.ok !== false && reactor?.ok !== false;
  }
  return health?.ok !== false
    && !cycles?.open_count
    && !cycles?.progress_stalled
    && !(cycles?.stuck_steps ?? []).length
    && !(cycles?.drift_steps ?? []).length;
}

function attentionFromTasks(subject, tasks, {
  health = null,
  cycles = null,
  pipeline = null,
  reactor = null,
} = {}) {
  const items = [];
  const historicalOnly = daemonIsCurrentlyHealthy(health, cycles, { pipeline, reactor });
  for (const task of tasks?.failed ?? []) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'task_failed',
      status: historicalOnly ? 'needs_ack' : 'active',
      category: historicalOnly ? 'history' : 'current',
      blocking: !historicalOnly,
      title: historicalOnly ? `历史失败任务: ${task.type}` : `任务失败: ${task.type}`,
      summary: `${task.task_id}: ${task.last_error_code ?? task.last_error ?? 'error'}`,
      subject,
      refs: { task_id: task.task_id },
      suggested_command: `npm run jea -- daemon tasks inspect ${task.task_id} --subject ${subject}`,
    });
  }
  for (const task of tasks?.expired_running ?? []) {
    pushAttention(items, {
      severity: 'critical',
      kind: 'task_lease_expired',
      status: 'active',
      category: 'current',
      blocking: true,
      title: `租约过期: ${task.type}`,
      summary: task.task_id,
      subject,
      refs: { task_id: task.task_id },
      suggested_command: `npm run jea -- daemon work --once --subject ${subject}`,
    });
  }
  return items;
}

function attentionFromChannel(subject, channel) {
  const items = [];
  if (!channel) return items;
  if (channel.health?.ok === false) {
    const historicalStale = channel.health?.status === 'stale'
      && !((channel.tasks?.counts?.pending ?? 0) > 0)
      && !((channel.tasks?.running ?? []).length)
      && !((channel.tasks?.failed ?? []).length)
      && !((channel.inbound?.pending_count ?? 0) > 0)
      && !((channel.outbox?.pending_count ?? 0) > 0)
      && !channel.feishu?.reload?.pending;
    pushAttention(items, {
      severity: historicalStale ? 'warning' : 'critical',
      kind: 'channel_health',
      status: historicalStale ? 'needs_ack' : 'active',
      category: historicalStale ? 'history' : 'current',
      blocking: !historicalStale,
      title: historicalStale
        ? `历史 Channel 状态: ${channel.health.status ?? 'unhealthy'}`
        : `Channel: ${channel.health.status ?? 'unhealthy'}`,
      summary: (channel.health.reasons ?? []).join(' · '),
      subject,
      suggested_command: `npm run jea -- channel doctor --subject ${subject} --json`,
    });
  }
  const inPending = channel.inbound?.pending_count ?? 0;
  const outPending = channel.outbox?.pending_count ?? 0;
  if (inPending >= 5) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'channel_inbound_backlog',
      title: '入站积压',
      summary: `${inPending} pending inbound`,
      subject,
      suggested_command: `npm run jea -- channel status --subject ${subject} --json`,
    });
  }
  if (outPending >= 5) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'channel_outbox_backlog',
      title: '出站积压',
      summary: `${outPending} pending outbox`,
      subject,
      suggested_command: `npm run jea -- channel outbox --subject ${subject} --json`,
    });
  }
  const pendingSpeech = channel.presence?.pending_speech_generation?.length ?? 0;
  if (pendingSpeech > 0) {
    pushAttention(items, {
      severity: 'info',
      kind: 'pending_speech',
      title: '待生成话术',
      summary: `${pendingSpeech} speech generation pending`,
      subject,
      suggested_command: `npm run jea -- channel events --subject ${subject} --limit 20`,
    });
  }
  if (channel.feishu?.listener?.fingerprint_stale) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'feishu_listener_stale',
      title: 'Feishu listener 配置过期',
      summary: 'Listener fingerprint does not match current config',
      subject,
      suggested_command: `npm run jea -- channel events --subject ${subject} --limit 10`,
    });
  }
  if (channel.feishu?.reload?.pending) {
    pushAttention(items, {
      severity: 'info',
      kind: 'feishu_reload_pending',
      title: 'Feishu 热加载待处理',
      summary: channel.feishu.reload.request?.reason ?? 'reload requested',
      subject,
    });
  }
  for (const task of channel.tasks?.failed ?? []) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'channel_task_failed',
      title: `Channel 任务失败: ${task.type}`,
      summary: `${task.task_id}: ${task.last_error_code ?? 'error'}`,
      subject,
      refs: { task_id: task.task_id },
      suggested_command: `npm run jea -- channel doctor --subject ${subject} --json`,
    });
  }
  return items;
}

function attentionFromBriefs(subject, operatorInputs) {
  const items = [];
  if (operatorInputs?.stale_pending_count > 0) {
    pushAttention(items, {
      severity: 'warning',
      kind: 'stale_operator_brief',
      title: 'Operator brief 长时间未消费',
      summary: `${operatorInputs.stale_pending_count} brief(s) older than 30m`,
      subject,
      suggested_command: `npm run jea -- intel brief list --subject ${subject}`,
    });
  }
  return items;
}

function buildOperatorInputs(runtimeRoot, subject) {
  const pending = readPendingOperatorBriefs(runtimeRoot, { limit: 20 });
  const now = Date.now();
  const briefs = (pending.briefs ?? []).map((brief) => {
    const created = Date.parse(brief.created_at ?? '');
    const age_ms = Number.isFinite(created) ? now - created : null;
    return {
      id: brief.id,
      kind: brief.kind,
      summary: String(brief.summary ?? '').slice(0, 200),
      priority: brief.priority ?? 'medium',
      created_at: brief.created_at ?? null,
      age_ms,
      stale: age_ms != null && age_ms >= STALE_BRIEF_MS,
    };
  });
  return {
    pending_count: pending.total_valid ?? briefs.length,
    stale_pending_count: briefs.filter((b) => b.stale).length,
    recent: briefs.slice(0, 8),
  };
}

function buildCycleDiagnostics(daemon) {
  const cycles = daemon?.cycles ?? {};
  const reactorPrimary = daemon?.pipeline === 'reactor';
  return {
    open_count: cycles.open_count ?? 0,
    progress_stalled: reactorPrimary ? false : Boolean(cycles.progress_stalled),
    oldest_open_cycle_age_ms: cycles.oldest_open_cycle_age_ms ?? null,
    stuck_steps: reactorPrimary ? [] : (cycles.stuck_steps ?? []),
    drift_steps: reactorPrimary ? [] : (cycles.drift_steps ?? []),
    reactor: daemon?.reactor ?? null,
    wake_policy: daemon?.wake_policy ?? null,
    recent: (cycles.recent ?? []).map((cycle) => ({
      cycle_id: cycle.cycle_id,
      status: cycle.status ?? null,
      opened_at: cycle.opened_at ?? null,
      steps: cycle.steps ?? {},
      running_steps: cycle.running_steps ?? [],
      stuck_steps: cycle.stuck_steps ?? [],
    })),
    failed_tasks: daemon?.tasks?.failed ?? [],
    expired_running: daemon?.tasks?.expired_running ?? [],
    health_suggestions: daemon?.health?.suggestions ?? [],
  };
}

function buildChannelDiagnostics(channel) {
  if (!channel) return null;
  const workers = channel.workers ?? {};
  return {
    health: channel.health ?? null,
    worker: channel.worker ?? null,
    workers: {
      status: workers.status ?? null,
      running_count: workers.running_count ?? 0,
      stale_count: workers.stale_count ?? 0,
      zombie_count: workers.zombie_count ?? 0,
      roles: workers.roles ?? [],
    },
    classifier: channel.classifier ?? null,
    presence: {
      config: channel.presence?.config ?? null,
      reactor: channel.presence?.reactor ?? null,
      pending_speech_generation: channel.presence?.pending_speech_generation ?? [],
      event_queue: channel.presence?.event_queue ?? null,
    },
    feishu: channel.feishu ?? null,
    inbound_pending: channel.inbound?.pending_count ?? 0,
    outbox_pending: channel.outbox?.pending_count ?? 0,
    tasks: {
      counts: channel.tasks?.counts ?? {},
      running: channel.tasks?.running ?? [],
      failed: channel.tasks?.failed ?? [],
      deprecated: channel.tasks?.deprecated ?? [],
    },
  };
}

/**
 * Build read-only observability projection for one subject.
 * @param {object} options
 * @param {string} options.subject
 * @param {string} options.runtimeRoot
 * @param {object} options.daemon - output of buildDaemonProjection
 */
export function buildSubjectObservability({ subject, runtimeRoot, daemon, repo_links = null }) {
  const operator_inputs = buildOperatorInputs(runtimeRoot, subject);
  const cycle_diagnostics = buildCycleDiagnostics(daemon);
  const channel_diagnostics = buildChannelDiagnostics(daemon?.channel);

  const attentionItems = [
    ...attentionFromDaemonHealth(subject, daemon?.health),
    ...attentionFromReactor(subject, daemon?.reactor),
    ...attentionFromCycles(subject, daemon?.cycles, { pipeline: daemon?.pipeline }),
    ...attentionFromTasks(subject, daemon?.tasks, {
      health: daemon?.health,
      cycles: daemon?.cycles,
      pipeline: daemon?.pipeline,
      reactor: daemon?.reactor,
    }),
    ...attentionFromChannel(subject, daemon?.channel),
    ...attentionFromBriefs(subject, operator_inputs),
  ].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const attention = {
    items: attentionItems,
    summary: summarizeAttention(attentionItems),
  };

  return {
    schema_version: 1,
    subject,
    generated_at: new Date().toISOString(),
    attention,
    cycle_diagnostics,
    channel_diagnostics,
    operator_inputs,
    repo_links,
    evolution_mode: daemon?.evolution_mode ?? null,
    evolution_mode_source: daemon?.evolution_mode_source ?? null,
  };
}

/**
 * Diagnostics slice for one open cycle (for cycle detail API).
 * @param {string} cycleId
 * @param {object} observability
 */
export function cycleDiagnosticsForId(cycleId, observability) {
  const cycle = observability?.cycle_diagnostics?.recent?.find((c) => c.cycle_id === cycleId);
  const stuck = (observability?.cycle_diagnostics?.stuck_steps ?? [])
    .filter((s) => s.cycle_id === cycleId);
  const drift = (observability?.cycle_diagnostics?.drift_steps ?? [])
    .filter((d) => d.cycle_id === cycleId);
  return {
    cycle: cycle ?? null,
    stuck_steps: stuck,
    drift_steps: drift,
  };
}
