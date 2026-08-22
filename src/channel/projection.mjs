import { summarizeWorkerState } from '../daemon/daemon-worker-state.mjs';
import { summarizeChannelTaskQueue, readChannelTaskQueue } from './task-queue.mjs';
import { readChannelWorkerState, summarizeChannelWorkersState } from './worker-state.mjs';
import { classifierConfigForApi, resolveClassifierConfig } from './classifier-config.mjs';
import { readChannelEvents } from './audit.mjs';
import {
  findOutboxByIdempotencyKey,
  listOutboxPending,
  listPendingInbound,
  readChannelReloadRequest,
  readChannelReloadState,
  readPresenceState,
  reconcilePendingSpeechGeneration,
} from './state.mjs';
import {
  feishuListenerConfigFingerprint,
  getFeishuListenerStatus,
} from './adapters/feishu/listener.mjs';
import { resolveFeishuConfig, feishuConfigForApi } from './adapters/feishu/config.mjs';
import { presenceConfigForApi, resolvePresenceConfig } from './presence-config.mjs';
import {
  desktopConfigForApi,
  listDesktopSessions,
  resolveDesktopConfig,
} from './adapters/desktop/index.mjs';
import { readJsonSafe } from '../infra/files.mjs';
import { DEPRECATED_CHANNEL_TASK_TYPES } from './types.mjs';
import { listChannelEvents, summarizeChannelEventQueue } from './event-queue.mjs';

function listDeprecatedQueueTasks(queue) {
  return (queue.tasks ?? [])
    .filter((task) => DEPRECATED_CHANNEL_TASK_TYPES.includes(task.type)
      && ['pending', 'running'].includes(task.status))
    .map((task) => ({
      task_id: task.task_id,
      type: task.type,
      status: task.status,
    }));
}

function summarizeAgentRunTasks(queue) {
  const rows = (queue.tasks ?? []).filter((task) => task.type === 'channel_agent_run');
  return {
    pending: rows.filter((task) => task.status === 'pending').length,
    running: rows.filter((task) => task.status === 'running').map((task) => ({
      task_id: task.task_id,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
      channel_agent_run_id: task.input?.request?.channel_agent_run_id ?? null,
      candidate_id: task.input?.request?.candidate_id ?? null,
    })),
    failed: rows.filter((task) => task.status === 'failed').slice(0, 5).map((task) => ({
      task_id: task.task_id,
      attempts: task.attempts,
      channel_agent_run_id: task.input?.request?.channel_agent_run_id ?? null,
      last_error: task.last_error,
    })),
  };
}

function summarizeDeliveryPipeline(root, subject, { limit = 50 } = {}) {
  const rows = listChannelEvents(root, subject, { type: 'speech_generation_requested' })
    .slice(-Math.max(0, limit))
    .reverse()
    .map((event) => {
      const requestedTarget = event.payload?.target ?? event.payload_summary?.target ?? null;
      const requestedTransport = String(requestedTarget ?? '').startsWith('desktop:')
        ? 'desktop'
        : null;
      const idempotencyKey = event.outbox_idempotency_key
        ?? event.payload?.idempotency_key
        ?? event.payload_summary?.idempotency_key
        ?? null;
      const delivery = findOutboxByIdempotencyKey(root, subject, idempotencyKey);
      const outbound = delivery?.payload?.outbound ?? delivery?.payload ?? {};
      const transport = outbound.channel ?? event.transport ?? requestedTransport;
      const target = outbound.target ?? event.target ?? requestedTarget;
      const status = event.status === 'failed'
        ? 'failed'
        : delivery?.status === 'sent'
          ? 'delivered'
          : delivery?.status === 'failed'
            ? 'failed'
            : delivery?.status === 'pending'
              ? 'queued'
              : event.status === 'handled'
                ? (event.delivery_status ?? 'queued')
                : event.status;
      return {
        event_id: event.id,
        intent_id: event.payload?.intent_id ?? event.event_ref ?? null,
        candidate_id: event.payload?.candidate_id ?? null,
        message_id: event.payload?.reply_to_message_id ?? null,
        status,
        attempts: event.attempts ?? 0,
        max_attempts: event.max_attempts ?? 1,
        next_attempt_at: event.next_attempt_at ?? null,
        last_error: delivery?.status === 'failed'
          ? (delivery.payload?.reason ?? event.last_error ?? null)
          : event.last_error ?? null,
        transport,
        target,
        created_at: event.created_at,
        handled_at: event.handled_at ?? null,
      };
    });
  return {
    pending: rows.filter((row) => ['pending', 'claimed', 'queued'].includes(row.status)),
    failed: rows.filter((row) => row.status === 'failed'),
    delivered: rows.filter((row) => row.status === 'delivered'),
  };
}

function resolveFeishuListenerDisplay({ config, listenerStatus, reloadState, worker, workers }) {
  if (!config?.enabled) return { display_status: 'disabled', display_reason: 'feishu_disabled' };
  if (config.mock) return { display_status: 'mock', display_reason: 'feishu_mock' };
  if (!config.listenerEnabled) return { display_status: 'disabled', display_reason: 'listener_disabled' };
  if (listenerStatus?.running) {
    return {
      display_status: listenerStatus.connected ? 'connected' : 'running',
      display_reason: listenerStatus.connected ? 'listener_connected' : 'listener_running',
    };
  }
  if (worker?.running || workers?.running_count > 0) {
    return { display_status: 'not_observed', display_reason: 'listener_process_local' };
  }
  if (!config.appId || !config.appSecret) {
    return { display_status: 'credentials_missing', display_reason: 'credentials_missing' };
  }
  if (reloadState?.last_error) {
    return { display_status: 'error', display_reason: 'reload_error' };
  }
  return { display_status: 'off', display_reason: 'listener_not_running' };
}

export function buildChannelProjection(root, subject, { heartbeatStaleMs = 60_000, eventLimit = 20 } = {}) {
  const queue = readChannelTaskQueue(root, subject);
  const summary = summarizeChannelTaskQueue(queue);
  const rawWorker = readChannelWorkerState(root, subject);
  const workers = summarizeChannelWorkersState(rawWorker, { staleMs: heartbeatStaleMs });
  const legacyWorker = rawWorker?.workers ? null : rawWorker;
  const worker = legacyWorker
    ? summarizeWorkerState(legacyWorker, { staleMs: heartbeatStaleMs })
    : {
      status: workers.status,
      running: workers.running_count > 0,
      fresh: workers.fresh_count > 0,
      stale: workers.stale_count > 0,
      zombie: workers.zombie_count > 0,
      pid_alive: workers.running_count > 0,
      pid: rawWorker?.coordinator?.pid ?? null,
      worker_id: null,
      heartbeat_at: rawWorker?.heartbeat_at ?? null,
      stop_requested_at: rawWorker?.stop_requested_at ?? null,
      tick_ms: rawWorker?.tick_ms ?? null,
      last_work_result: null,
      last_error: null,
    };
  const pendingInbound = listPendingInbound(root, subject, { limit: 20 });
  const pendingOutbox = listOutboxPending(root, subject, { limit: 20 });
  const feishuConfig = resolveFeishuConfig(root, subject);
  const desktopConfig = resolveDesktopConfig(root, subject);
  const desktopSessions = listDesktopSessions(root, subject);
  const listenerStatus = getFeishuListenerStatus(root, subject);
  const reloadState = readChannelReloadState(root, subject);
  const reloadRequest = readChannelReloadRequest(root, subject);
  const expectedFingerprint = feishuListenerConfigFingerprint(feishuConfig);
  const deprecatedTasks = listDeprecatedQueueTasks(queue);
  const health = (() => {
    const reasons = [];
    if (legacyWorker && worker.zombie) reasons.push('Channel worker pid is not alive');
    if (legacyWorker && worker.stale) reasons.push('Channel worker heartbeat is stale');
    if (workers.zombie_count) reasons.push(`${workers.zombie_count} channel role worker(s) zombie`);
    if (workers.stale_count) reasons.push(`${workers.stale_count} channel role worker(s) stale`);
    if ((summary.counts.pending ?? 0) > 0 && !worker.running && !workers.running_count) {
      reasons.push('Channel tasks are pending without a fresh worker');
    }
    if (deprecatedTasks.length) {
      reasons.push(`Deprecated channel tasks in queue: ${deprecatedTasks.map((t) => t.type).join(', ')}`);
    }
    if (reasons.length) {
      return {
        status: workers.zombie_count || worker.zombie ? 'worker_zombie' : (workers.stale_count || worker.stale ? 'stale' : 'blocked'),
        ok: false,
        reasons,
      };
    }
    return { status: worker.running ? 'healthy' : 'idle', ok: true, reasons: [] };
  })();
  return {
    subject,
    generated_at: new Date().toISOString(),
    health,
    worker,
    workers,
    classifier: classifierConfigForApi(resolveClassifierConfig(root, subject)),
    tasks: {
      total: summary.total,
      counts: summary.counts,
      deprecated: deprecatedTasks,
      next_task: summary.next_task ? {
        task_id: summary.next_task.task_id,
        type: summary.next_task.type,
        attempts: summary.next_task.attempts,
        priority: summary.next_task.priority,
        idempotency_key: summary.next_task.idempotency_key,
      } : null,
      running: summary.running.map((task) => ({
        task_id: task.task_id,
        type: task.type,
        lease_owner: task.lease_owner,
        lease_expires_at: task.lease_expires_at,
      })),
      failed: summary.failed.slice(0, 10).map((task) => ({
        task_id: task.task_id,
        type: task.type,
        attempts: task.attempts,
        last_error_code: task.last_error_code,
        last_error: task.last_error,
      })),
      agent_runs: summarizeAgentRunTasks(queue),
    },
    inbound: {
      pending_count: pendingInbound.length,
      pending_files: pendingInbound,
    },
    outbox: {
      pending_count: pendingOutbox.length,
      pending_files: pendingOutbox,
    },
    recent_events: readChannelEvents(root, subject, { limit: eventLimit }),
    presence: (() => {
      reconcilePendingSpeechGeneration(root, subject);
      const presenceState = readPresenceState(root, subject);
      return {
        config: presenceConfigForApi(resolvePresenceConfig(root, subject)),
        state: presenceState,
        event_queue: summarizeChannelEventQueue(root, subject),
        reactor: presenceState.reactor ?? null,
        pending_speech_generation: presenceState.pending_speech_generation ?? [],
        delivery_pipeline: summarizeDeliveryPipeline(root, subject),
      };
    })(),
    feishu: {
      config: feishuConfigForApi(feishuConfig),
      listener: {
        ...listenerStatus,
        ...resolveFeishuListenerDisplay({
          config: feishuConfig,
          listenerStatus,
          reloadState,
          worker,
          workers,
        }),
        expected_config_fingerprint: expectedFingerprint,
        fingerprint_stale: Boolean(
          listenerStatus.running
          && listenerStatus.config_fingerprint
          && listenerStatus.config_fingerprint !== expectedFingerprint,
        ),
      },
      reload: {
        pending: Boolean(reloadRequest),
        request: reloadRequest ? {
          reason: reloadRequest.reason ?? null,
          requested_at: reloadRequest.requested_at ?? null,
          changed: reloadRequest.changed ?? [],
        } : null,
        last_reload_at: reloadState.last_reload_at ?? null,
        last_reload_reason: reloadState.last_reload_reason ?? null,
        last_error: reloadState.last_error ?? null,
        last_error_code: reloadState.last_error_code ?? null,
        last_error_at: reloadState.last_error_at ?? null,
        listener_state: reloadState.listener_state ?? listenerStatus.state ?? 'stopped',
        listener_state_at: reloadState.listener_state_at ?? null,
        config_fingerprint: reloadState.config_fingerprint ?? null,
        retry_attempt: reloadState.retry_attempt ?? 0,
        backoff_ms: reloadState.backoff_ms ?? null,
        next_retry_at: reloadState.next_retry_at ?? null,
      },
    },
    desktop: {
      config: desktopConfigForApi(desktopConfig),
      session_count: desktopSessions.length,
      sessions: desktopSessions.slice(-20).reverse(),
    },
  };
}
