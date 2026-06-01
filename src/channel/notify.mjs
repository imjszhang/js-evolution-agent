import { createHash } from 'node:crypto';
import { resolveFeishuConfig } from './adapters/feishu/config.mjs';
import { buildDaemonProjection } from '../cli/utils/daemon-projection.mjs';
import { storeForSubject } from '../cli/utils/daemon-events.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { readPendingOperatorBriefs } from '../intelligence/operator-briefs.mjs';
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
