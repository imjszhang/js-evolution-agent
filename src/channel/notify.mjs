import { createHash } from 'node:crypto';
import { resolveFeishuConfig } from './adapters/feishu/config.mjs';
import { buildDaemonProjection } from '../daemon/daemon-projection.mjs';
import { storeForSubject } from '../daemon/daemon-events.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { readPendingOperatorBriefs } from '../intelligence/channel-api.mjs';
import { cooldownActive, setCooldown, writeOutboxMessage } from './state.mjs';
import { normalizeOutboundMessage, nowIso } from './types.mjs';

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

function hashKey(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function routeTarget(root, subject) {
  return resolveFeishuConfig(root, subject).defaultChatId;
}

export function collectAttentionSignals(root, subject, { projection = null } = {}) {
  const store = storeForSubject(root, subject);
  const recentEvents = store?.readEvolutionEvents
    ? store.readEvolutionEvents({ limit: 100 }).filter((event) => !event.subject || event.subject === subject)
    : [];
  const view = projection ?? buildDaemonProjection(root, subject, { store });
  const signals = [];
  if (view.health && view.health.ok === false) {
    signals.push({
      type: 'daemon_health',
      severity: view.health.status === 'cycle_progress_stalled' ? 'high' : 'medium',
      title: `Daemon health: ${view.health.status}`,
      summary: (view.health.reasons ?? []).join('\n') || 'Daemon health is not ok.',
      key: `health:${view.health.status}`,
      refs: { health: view.health },
    });
  }
  for (const task of view.tasks?.failed ?? []) {
    signals.push({
      type: 'task_failed',
      severity: 'medium',
      title: `Task failed: ${task.type}`,
      summary: task.last_error || task.last_error_code || 'A daemon task failed.',
      key: `task_failed:${task.task_id}`,
      refs: { task },
    });
  }
  for (const drift of view.cycles?.drift_steps ?? []) {
    signals.push({
      type: 'cycle_drift',
      severity: 'high',
      title: `Cycle step drift: ${drift.cycle_id}:${drift.step}`,
      summary: 'Cycle-state is terminal while a matching daemon task is still running.',
      key: `cycle_drift:${drift.cycle_id}:${drift.step}`,
      refs: { drift },
    });
  }
  const lastClosedCycleId = view.cycles?.last_closed_cycle_id;
  if (lastClosedCycleId) {
    const diaryEvent = recentEvents.find((event) =>
      event.type === 'evolution_diary' && event.cycle_id === lastClosedCycleId);
    signals.push({
      type: 'cycle_completed',
      severity: 'low',
      title: `Cycle completed: ${lastClosedCycleId}`,
      summary: diaryEvent?.tldr || `Cycle ${lastClosedCycleId} has closed.`,
      key: `cycle_completed:${lastClosedCycleId}`,
      refs: {
        cycle_id: lastClosedCycleId,
        closed_at: view.cycles?.last_closed_at ?? null,
        diary_path: diaryEvent?.diary_path ?? null,
      },
    });
  }
  for (const event of recentEvents) {
    const serialized = JSON.stringify(event);
    if (!/requires_human_review|requires_approval/i.test(serialized)) continue;
    const cycleId = event.cycle_id ?? event.id ?? 'unknown';
    signals.push({
      type: 'requires_human_review',
      severity: 'high',
      title: `Human review required: ${cycleId}`,
      summary: event.tldr || event.summary || event.error || 'A recent cycle/action indicates human review is required.',
      key: `human_review:${cycleId}:${event.id ?? event.recorded_at ?? ''}`,
      refs: { event },
    });
  }
  const generatedMs = Date.parse(view.generated_at ?? '');
  const lastClosedMs = Date.parse(view.cycles?.last_closed_at ?? '');
  const idleMs = Number.isFinite(generatedMs) && Number.isFinite(lastClosedMs)
    ? generatedMs - lastClosedMs
    : 0;
  if (view.health?.status === 'idle'
    && view.evolution_mode === 'on_demand'
    && !view.cycles?.pending_cycle_start_request
    && idleMs > 60 * 60 * 1000) {
    signals.push({
      type: 'long_idle',
      severity: 'low',
      title: 'On-demand daemon idle',
      summary: `No cycle start request is pending; last closed cycle was about ${Math.round(idleMs / 60000)} minute(s) ago.`,
      key: `long_idle:${view.cycles?.last_closed_cycle_id ?? 'none'}`,
      refs: { idle_ms: idleMs, last_closed_cycle_id: view.cycles?.last_closed_cycle_id ?? null },
    });
  }
  const pendingBriefs = readPendingOperatorBriefs(runtimeForSubject(root, subject).runtimeRoot, { limit: 20 });
  for (const brief of pendingBriefs.briefs ?? []) {
    if (!['approval_request', 'verification_request'].includes(brief.kind)) continue;
    signals.push({
      type: 'operator_brief_pending',
      severity: brief.kind === 'approval_request' ? 'high' : 'low',
      title: `Pending ${brief.kind}`,
      summary: brief.summary,
      key: `brief:${brief.id}`,
      refs: { brief_id: brief.id },
    });
  }
  return signals;
}

function formatSignalMessage(subject, signal) {
  return [
    `JEA ${subject}: ${signal.title}`,
    '',
    signal.summary,
    '',
    `severity: ${signal.severity}`,
    `type: ${signal.type}`,
  ].filter(Boolean).join('\n');
}

export function enqueueNotificationsForSignals(root, subject, signals, {
  target = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  dryRun = false,
} = {}) {
  const resolvedTarget = target ?? routeTarget(root, subject);
  const results = [];
  if (!resolvedTarget) {
    return { enqueued: [], skipped: signals.map((signal) => ({ signal, reason: 'missing_target' })) };
  }
  for (const signal of signals) {
    const cooldownKey = `notify:${signal.key ?? hashKey(JSON.stringify(signal))}`;
    if (cooldownActive(root, subject, cooldownKey)) {
      results.push({ signal, skipped: true, reason: 'cooldown' });
      continue;
    }
    const outbound = normalizeOutboundMessage({
      channel: 'feishu',
      target: resolvedTarget,
      text: formatSignalMessage(subject, signal),
      subject,
      reason: signal.type,
      priority: signal.severity,
      idempotency_key: cooldownKey,
      metadata: {
        signal,
        dry_run: dryRun,
        generated_at: nowIso(),
        mock: dryRun
          || process.env.JEA_CHANNEL_FEISHU_MOCK === '1'
          || process.env.JEA_CHANNEL_LARK_MOCK === '1',
      },
    });
    const written = dryRun ? { file: null, message: outbound } : writeOutboxMessage(root, subject, outbound);
    if (!dryRun) setCooldown(root, subject, cooldownKey, cooldownMs, { signal_type: signal.type });
    results.push({ signal, skipped: false, outbound: written.message, file: written.file });
  }
  return {
    enqueued: results.filter((item) => !item.skipped),
    skipped: results.filter((item) => item.skipped),
  };
}
