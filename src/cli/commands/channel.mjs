import { existsSync, readFileSync } from 'node:fs';
import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { parseHeartbeatStaleMs } from '../../daemon/daemon-worker-state.mjs';
import { buildChannelProjection } from '../../channel/projection.mjs';
import { readChannelEvents } from '../../channel/audit.mjs';
import { writePendingInbound, listPendingInbound, listOutboxPending, writeOutboxMessage } from '../../channel/state.mjs';
import { normalizeOutboundMessage } from '../../channel/types.mjs';
import { readChannelTaskQueue } from '../../channel/task-queue.mjs';
import { enqueueClassifierIfPendingInbound, enqueueNotifyIfOutboxPending } from '../../channel/wake.mjs';
import { runChannelTick } from '../../channel/dispatch.mjs';
import { runChannelNotifyTask } from '../../channel/tasks.mjs';
import { runChannelPresenceTask } from '../../channel/presence.mjs';
import { cancelDeprecatedChannelTasks } from '../../channel/queue-cleanup.mjs';
import { channelFeishuCommand } from './channel-feishu.mjs';
import { resolveFeishuConfig } from '../../channel/adapters/feishu/config.mjs';
import { probeFeishuNetwork, summarizeProxyEnv } from '../../channel/adapters/feishu/diagnostics.mjs';
import { readChannelWorkerState, reconcileChannelWorkerState } from '../../channel/worker-state.mjs';
import { isProcessAlive } from '../../infra/process-alive.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import {
  listDesktopSessions,
  readDesktopSession,
  sendDesktopInboundMessage,
} from '../../channel/adapters/desktop/index.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

async function readStdinText() {
  if (process.stdin.isTTY) throw new Error('stdin is a TTY; provide --file or pipe JSON via stdin');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonInput(flags = {}) {
  if (flags.file && typeof flags.file === 'string') {
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(flags.file, 'utf-8'));
  }
  if (flags.stdin || (!flags.file && !process.stdin.isTTY)) {
    return JSON.parse(await readStdinText());
  }
  throw new Error('No input provided. Use --file PATH or pipe JSON to stdin.');
}

function printStatus(projection) {
  console.log(`# Channel Status: ${projection.subject}`);
  console.log(`health: ${projection.health.status} ok=${projection.health.ok}`);
  console.log(`worker: ${projection.worker.status} pid=${projection.worker.pid ?? '-'} heartbeat=${projection.worker.heartbeat_at ?? '-'}`);
  console.log(`tasks: pending=${projection.tasks.counts.pending ?? 0} running=${projection.tasks.counts.running ?? 0} failed=${projection.tasks.counts.failed ?? 0}`);
  console.log(`inbound pending: ${projection.inbound.pending_count}`);
  console.log(`outbox pending: ${projection.outbox.pending_count}`);
  if (projection.feishu?.listener?.running != null) {
    console.log(`feishu listener: running=${projection.feishu.listener.running} connected=${projection.feishu.listener.connected}`);
  }
  if (projection.feishu?.reload?.pending) {
    console.log('feishu reload: pending');
  }
  if (projection.feishu?.reload?.next_retry_at) {
    console.log(`feishu retry: attempt=${projection.feishu.reload.retry_attempt ?? 0} backoff_ms=${projection.feishu.reload.backoff_ms ?? '-'} next=${projection.feishu.reload.next_retry_at}`);
  }
  if (projection.desktop?.config) {
    console.log(`desktop: enabled=${projection.desktop.config.enabled} sessions=${projection.desktop.session_count}`);
  }
  if (projection.presence?.config) {
    console.log(`presence: enabled=${projection.presence.config.enabled} planner=${projection.presence.config.planner ?? '-'}`);
  }
  if (projection.tasks.deprecated?.length) {
    console.log(`deprecated tasks: ${projection.tasks.deprecated.map((t) => `${t.type}(${t.status})`).join(', ')}`);
  }
}

function hasLiveChannelWorker(root, subject) {
  const state = readChannelWorkerState(root, subject);
  if (!state) return false;
  const roles = Object.values(state.workers ?? {});
  if (roles.some((worker) => ['running', 'stopping'].includes(worker.status) && isProcessAlive(worker.pid))) {
    return true;
  }
  return ['running', 'stopping'].includes(state.status) && isProcessAlive(state.pid);
}

function createChannelStore(runtime) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
  });
}

function parseLimit(flags, fallback = 20) {
  const limit = Number(flags.limit);
  return Number.isFinite(limit) ? limit : fallback;
}

function findDeliverableRecord(records, id) {
  return records.find((record) => (
    record?.deliverable_id === id
    || record?.channel_agent_run_id === id
    || record?.id === id
  )) ?? null;
}

function printDeliverableList(records) {
  if (!records.length) {
    console.log('(none)');
    return;
  }
  for (const record of records) {
    const created = record.created_at ?? record.recorded_at ?? '?';
    const id = record.deliverable_id ?? record.id ?? '?';
    const status = record.status ?? '-';
    const type = record.deliverable_type ?? 'message';
    const delivery = record.delivery_status ?? 'pending';
    const format = record.delivery_format ? `/${record.delivery_format}` : '';
    const label = String(record.title ?? record.objective ?? record.tldr ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    console.log(`${created} ${id} status=${status} type=${type} delivery=${delivery}${format}${label ? ` ${label}` : ''}`);
  }
}

const CHANNEL_QUEUE_BACKLOG_WARNING_THRESHOLD = 1_000;

function buildFeishuDoctorHints(root, subject, projection) {
  const hints = [];
  const feishu = resolveFeishuConfig(root, subject);
  if (!feishu.mock && (!feishu.appId || !feishu.appSecret)) {
    hints.push(`缺少飞书凭据。运行: npm run jea -- channel feishu setup --subject ${subject} --write-env`);
  }
  if (projection.worker.running && feishu.listenerEnabled && !feishu.mock && feishu.appId && feishu.appSecret) {
    const listener = projection.feishu?.listener ?? {};
    if (!listener.running) {
      hints.push('Channel worker 正在运行，但飞书 listener 未启动。等待 reload 或查看 channel events / reload-state。');
    }
  }
  if (projection.feishu?.reload?.pending) {
    hints.push('存在待处理的 channel reload 请求；运行中的 channel daemon 会在下一轮 loop 自动消费。');
  }
  if (projection.feishu?.reload?.last_error) {
    hints.push(`上次 listener reload 失败: ${projection.feishu.reload.last_error}`);
  }
  if (projection.feishu?.listener?.fingerprint_stale) {
    hints.push('飞书 listener 使用的配置 fingerprint 已过期；等待 channel daemon reload 或检查 reload-state。');
  }
  if (projection.tasks.deprecated?.length) {
    hints.push(
      '队列中存在已废弃的 channel_reply/channel_watch/channel_ingest 任务。执行 jea channel queue purge-deprecated --yes（或 doctor --purge-deprecated --yes）后重启 channel daemon。',
    );
  }
  const pendingTasks = Number(projection.tasks?.counts?.pending ?? 0);
  if (pendingTasks >= CHANNEL_QUEUE_BACKLOG_WARNING_THRESHOLD) {
    hints.push(
      `Channel 任务队列积压 ${pendingTasks} 个 pending task，可能拖慢新消息处理。请先检查任务来源和 worker 处理能力；JEA 不会自动清理 pending_tasks.json，清理前必须人工确认。`,
    );
  }
  if (projection.workers?.zombie_count > 0 || projection.health?.status === 'worker_zombie') {
    hints.push(
      '存在已死亡 PID 的 channel worker。执行 jea channel doctor --repair-worker-state --yes 收敛状态；status 只读，不会偷偷改盘。',
    );
  }
  if (projection.feishu?.reload?.next_retry_at) {
    hints.push(
      `飞书 listener 将按退避重试：attempt=${projection.feishu.reload.retry_attempt ?? 0} next=${projection.feishu.reload.next_retry_at}。可用 jea channel doctor --probe-network 区分 DNS / HTTPS / 权限 / 超时。`,
    );
  }
  const proxy = summarizeProxyEnv();
  if (proxy.present && !proxy.axios_compatible) {
    hints.push(
      `本机 ${proxy.protocol} 代理对 axios 不兼容（只会当 HTTP CONNECT 用）。飞书 HTTP 已改为直连；若 listener 仍超时，检查 WebSocket 出口，或改用 HTTP 代理。`,
    );
  }
  if (!projection.presence?.config?.enabled) {
    hints.push('channels.presence.enabled 为 false；channel 不会自动表达。请启用 presence 或检查 subjects.json。');
  }
  return hints;
}

export async function channelCommand({ subcommand, flags = {}, args = [], root = getProjectRoot() } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const subject = runtime.subject;

  if (subcommand === 'feishu') {
    const action = args[0] ?? 'setup';
    return channelFeishuCommand({ action, flags, root, subject });
  }

  if (subcommand === 'desktop') {
    const action = args[0] ?? 'sessions';
    if (action === 'send') {
      const session = flags.session && flags.session !== true ? flags.session : args[1];
      const text = flags.text && flags.text !== true ? flags.text : null;
      const messageId = flags.id && flags.id !== true ? flags.id : null;
      if (!text) {
        console.error('Usage: jea channel desktop send [--session ID] --text TEXT [--id MESSAGE_ID] [--json]');
        return 2;
      }
      const result = sendDesktopInboundMessage(root, subject, {
        session,
        text,
        message_id: messageId,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`queued desktop inbound ${result.message_id} -> ${result.target}`);
      return 0;
    }
    if (action === 'read' || action === 'session') {
      const session = args[1] ?? (flags.session && flags.session !== true ? flags.session : 'main');
      const result = readDesktopSession(root, subject, session, {
        offset: flags.offset ?? 0,
        limit: parseLimit(flags, 50),
        tail: flags.tail === true ? 20 : flags.tail,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const record of result.records) {
          console.log(`${record.offset} ${record.created_at} ${record.role}: ${record.content}`);
        }
      }
      return 0;
    }
    if (action === 'sessions' || action === 'list') {
      const sessions = listDesktopSessions(root, subject);
      if (flags.json) console.log(JSON.stringify({ subject, sessions }, null, 2));
      else if (!sessions.length) console.log('(none)');
      else sessions.forEach((item) => console.log(`${item.session_id} messages=${item.message_count} last=${item.last_message_at ?? '-'}`));
      return 0;
    }
    console.error('Usage: jea channel desktop <send|read|sessions> [--session ID] [--json]');
    return 2;
  }

  if (subcommand === 'status' || !subcommand) {
    const projection = buildChannelProjection(root, subject, {
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    if (flags.json) console.log(JSON.stringify(projection, null, 2));
    else printStatus(projection);
    return projection.health.ok ? 0 : 1;
  }

  if (subcommand === 'events') {
    const limit = Number.isFinite(Number(flags.limit)) ? Number(flags.limit) : 20;
    const events = readChannelEvents(root, subject, { limit });
    if (flags.json) console.log(JSON.stringify({ subject, events }, null, 2));
    else if (!events.length) console.log('No channel events found.');
    else {
      for (const event of events) {
        console.log(`${event.recorded_at || '?'} ${event.type || 'event'} status=${event.status || '-'}`);
      }
    }
    return 0;
  }

  if (subcommand === 'inbox') {
    const action = args[0] ?? 'list';
    if (action === 'put') {
      let payload;
      try {
        payload = await readJsonInput(flags);
      } catch (err) {
        console.error(`Failed to read channel inbox payload: ${err?.message || err}`);
        return 2;
      }
      const written = writePendingInbound(root, subject, payload, { label: flags.name ?? 'manual' });
      const classifier = enqueueClassifierIfPendingInbound(root, subject);
      const result = {
        subject,
        ...written,
        task: classifier.task ?? null,
        created: classifier.created ?? false,
        reason: classifier.reason ?? null,
      };
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`queued channel inbound -> ${written.file}`);
      return 0;
    }
    const files = listPendingInbound(root, subject, { limit: flags.limit ?? 20 });
    if (flags.json) console.log(JSON.stringify({ subject, files }, null, 2));
    else if (!files.length) console.log('(none)');
    else files.forEach((file) => console.log(file));
    return 0;
  }

  if (subcommand === 'outbox') {
    const files = listOutboxPending(root, subject, { limit: flags.limit ?? 20 });
    if (flags.json) console.log(JSON.stringify({ subject, files }, null, 2));
    else if (!files.length) console.log('(none)');
    else files.forEach((file) => console.log(file));
    return 0;
  }

  if (subcommand === 'deliverables') {
    const action = args[0] ?? 'list';
    const store = createChannelStore(runtime);
    if (action === 'list') {
      const deliverables = store.readChannelDeliverables({ limit: parseLimit(flags, 20) });
      if (flags.json) console.log(JSON.stringify({ subject, deliverables }, null, 2));
      else printDeliverableList(deliverables);
      return 0;
    }
    if (action === 'show') {
      const id = args[1] ?? (flags.id && flags.id !== true ? flags.id : null);
      if (!id) {
        console.error('Usage: jea channel deliverables show <deliverable_id|channel_agent_run_id> [--json]');
        return 2;
      }
      const records = store.readChannelDeliverables({ limit: parseLimit(flags, 1000) });
      const record = findDeliverableRecord(records, id);
      if (!record) {
        console.error(`Channel deliverable not found: ${id}`);
        return 1;
      }
      const markdown = record.md_path && existsSync(record.md_path)
        ? readFileSync(record.md_path, 'utf-8')
        : null;
      if (flags.json) console.log(JSON.stringify({ subject, deliverable: record, markdown }, null, 2));
      else if (markdown) console.log(markdown);
      else {
        console.log(`Deliverable found, but Markdown file is missing: ${record.md_path ?? '(no md_path)'}`);
        console.log(JSON.stringify(record, null, 2));
      }
      return 0;
    }
    console.error('Usage: jea channel deliverables [list|show <id>] [--limit N] [--json]');
    return 2;
  }

  if (subcommand === 'send') {
    const dryRun = Boolean(flags['dry-run']);
    const target = flags.to && flags.to !== true ? flags.to : flags.target;
    const text = flags.text && flags.text !== true ? flags.text : null;
    if (!target || !text) {
      console.error('Usage: jea channel send --to TARGET --text TEXT [--dry-run]');
      return 2;
    }
    const outbound = normalizeOutboundMessage({
      channel: String(target).toLowerCase().startsWith('desktop:') ? 'desktop' : 'feishu',
      target,
      text,
      subject,
      reason: 'manual_send',
      metadata: { mock: dryRun },
    });
    if (dryRun) {
      console.log(JSON.stringify({ dry_run: true, outbound }, null, 2));
      return 0;
    }
    const written = writeOutboxMessage(root, subject, outbound);
    const notify = enqueueNotifyIfOutboxPending(root, subject);
    const result = { ...written, notify_task: notify.task ?? null, notify_created: notify.created ?? false };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`queued outbound -> ${written.file}`);
    return 0;
  }

  if (subcommand === 'tick') {
    const result = runChannelTick(root, subject);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      const count = result.enqueued.filter((item) => item?.created || item?.reactor_created).length;
      console.log(`channel tick enqueued ${count} wake/task(s)`);
    }
    return 0;
  }

  if (subcommand === 'work') {
    const action = args[0] ?? 'notify';
    if (action === 'notify') {
      const result = await runChannelNotifyTask(root, subject, flags);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else console.log('channel notify complete');
      return 0;
    }
    console.error('Usage: jea channel work notify [--json]');
    return 2;
  }

  if (subcommand === 'presence') {
    const action = args[0] ?? 'run';
    if (action !== 'run') {
      console.error('Usage: jea channel presence [run] [--json] [--dry-run]');
      return 2;
    }
    const result = await runChannelPresenceTask(root, subject, {
      dry_run: Boolean(flags['dry-run']),
      skip_speech_generation: Boolean(flags['decision-only']),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`presence: stance=${result.plan?.stance} planner=${result.plan?.planner} applied=${result.execution?.applied}`);
      if (result.plan?.llm) console.log(`llm: ${result.plan.llm.status}${result.plan.llm.reason ? ` (${result.plan.llm.reason})` : ''}`);
    }
    if (result.notify_created) {
      await runChannelNotifyTask(root, subject, { limit: flags.limit ?? 10 });
    }
    return 0;
  }

  if (subcommand === 'queue') {
    const action = args[0] ?? 'list';
    if (action === 'purge-deprecated') {
      const dryRun = !flags.yes;
      const result = cancelDeprecatedChannelTasks(root, subject, { dryRun });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else if (dryRun) {
        const n = result.would_cancel?.length ?? 0;
        console.log(n ? `would cancel ${n} deprecated task(s); re-run with --yes` : 'no pending deprecated tasks');
        for (const t of result.would_cancel ?? []) console.log(`  ${t.type} ${t.task_id}`);
      } else {
        console.log(`cancelled ${result.cancelled.length} deprecated task(s)`);
        for (const t of result.cancelled) console.log(`  ${t.type} ${t.task_id}`);
        if (result.still_running?.length) {
          console.log(`still running (manual cancel): ${result.still_running.map((t) => t.type).join(', ')}`);
        }
      }
      return 0;
    }
    console.error('Usage: jea channel queue purge-deprecated [--yes] [--json]');
    return 2;
  }

  if (subcommand === 'doctor') {
    if (flags['purge-deprecated'] && flags.yes) {
      cancelDeprecatedChannelTasks(root, subject);
    }
    let repair = null;
    if (flags['repair-worker-state']) {
      if (!flags.yes) {
        console.error('Refusing to repair channel worker state without --yes');
        return 2;
      }
      repair = reconcileChannelWorkerState(root, subject, {
        staleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
      });
    }
    const projection = buildChannelProjection(root, subject, {
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    const hints = buildFeishuDoctorHints(root, subject, projection);
    let network = null;
    if (flags['probe-network'] || flags['probe-ws']) {
      const feishu = resolveFeishuConfig(root, subject);
      const liveWorker = hasLiveChannelWorker(root, subject);
      network = await probeFeishuNetwork(feishu, {
        probeWs: Boolean(flags['probe-ws']),
        liveWorker,
        timeoutMs: Math.min(feishu.connectTimeoutMs ?? 20_000, 8_000),
      });
    }
    const diagnostics = {
      subject,
      health: projection.health,
      queue: readChannelTaskQueue(root, subject),
      feishu: projection.feishu,
      hints,
      ...(repair ? { repair } : {}),
      ...(network ? { network } : {}),
    };
    if (flags.json) console.log(JSON.stringify(diagnostics, null, 2));
    else {
      printStatus(projection);
      for (const reason of projection.health.reasons ?? []) console.log(`reason: ${reason}`);
      for (const hint of hints) console.log(`hint: ${hint}`);
      if (repair) {
        console.log(`repair: changed=${repair.changed} roles=${repair.roles?.length ?? 0}`);
        for (const role of repair.roles ?? []) {
          console.log(`repair role: ${role.role} ${role.from}->${role.to} reason=${role.reason}`);
        }
      }
      if (network) {
        console.log(`network: ok=${network.ok} host=${network.host} proxy=${network.proxy?.present ? network.proxy.protocol : 'none'}`);
        for (const check of network.checks ?? []) {
          const kind = check.kind ? ` kind=${check.kind}` : '';
          const skipped = check.skipped ? ` skipped=${check.reason}` : '';
          const error = check.error ? ` error=${check.error}` : '';
          console.log(`network ${check.name}: ok=${check.ok}${kind}${skipped}${error}`);
        }
      }
    }
    return projection.health.ok && (network ? network.ok : true) ? 0 : 1;
  }

  console.error('Usage: jea channel <status|events|inbox|outbox|deliverables|send|desktop|tick|work|presence|queue|doctor|feishu> [--subject NAME] [--json]');
  console.error('       jea channel doctor [--repair-worker-state --yes] [--probe-network] [--probe-ws] [--purge-deprecated --yes]');
  return 2;
}
