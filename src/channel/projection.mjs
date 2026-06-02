import { summarizeWorkerState } from '../cli/utils/daemon-worker-state.mjs';
import { summarizeChannelTaskQueue, readChannelTaskQueue } from './task-queue.mjs';
import { readChannelWorkerState } from './worker-state.mjs';
import { readChannelEvents } from './audit.mjs';
import {
  listOutboxPending,
  listPendingInbound,
  readChannelReloadRequest,
  readChannelReloadState,
} from './state.mjs';
import {
  feishuListenerConfigFingerprint,
  getFeishuListenerStatus,
} from './adapters/feishu/listener.mjs';
import { resolveFeishuConfig, feishuConfigForApi } from './adapters/feishu/config.mjs';
import { replyConfigForApi, resolveReplyConfig } from './reply.mjs';

export function buildChannelProjection(root, subject, { heartbeatStaleMs = 60_000, eventLimit = 20 } = {}) {
  const queue = readChannelTaskQueue(root, subject);
  const summary = summarizeChannelTaskQueue(queue);
  const rawWorker = readChannelWorkerState(root, subject);
  const worker = summarizeWorkerState(rawWorker, { staleMs: heartbeatStaleMs });
  const pendingInbound = listPendingInbound(root, subject, { limit: 20 });
  const pendingOutbox = listOutboxPending(root, subject, { limit: 20 });
  const feishuConfig = resolveFeishuConfig(root, subject);
  const listenerStatus = getFeishuListenerStatus(root, subject);
  const reloadState = readChannelReloadState(root, subject);
  const reloadRequest = readChannelReloadRequest(root, subject);
  const expectedFingerprint = feishuListenerConfigFingerprint(feishuConfig);
  const health = (() => {
    if (worker.zombie) return { status: 'worker_zombie', ok: false, reasons: ['Channel worker pid is not alive'] };
    if (worker.stale) return { status: 'stale', ok: false, reasons: ['Channel worker heartbeat is stale'] };
    if ((summary.counts.pending ?? 0) > 0 && !worker.running) {
      return { status: 'blocked', ok: false, reasons: ['Channel tasks are pending without a fresh worker'] };
    }
    return { status: worker.running ? 'healthy' : 'idle', ok: true, reasons: [] };
  })();
  return {
    subject,
    generated_at: new Date().toISOString(),
    health,
    worker,
    tasks: {
      total: summary.total,
      counts: summary.counts,
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
    feishu: {
      config: feishuConfigForApi(feishuConfig),
      reply: replyConfigForApi(resolveReplyConfig(root, subject)),
      listener: {
        ...listenerStatus,
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
        config_fingerprint: reloadState.config_fingerprint ?? null,
      },
    },
  };
}
