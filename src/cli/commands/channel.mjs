import { getProjectRoot } from '../utils/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { parseHeartbeatStaleMs } from '../utils/daemon-worker-state.mjs';
import { buildChannelProjection } from '../../channel/projection.mjs';
import { readChannelEvents } from '../../channel/audit.mjs';
import { writePendingInbound, listPendingInbound, listOutboxPending, writeOutboxMessage } from '../../channel/state.mjs';
import { normalizeOutboundMessage } from '../../channel/types.mjs';
import { readChannelTaskQueue } from '../../channel/task-queue.mjs';
import { enqueueNotifyIfOutboxPending, requestPresenceReactor } from '../../channel/wake.mjs';
import { runChannelTick } from '../../channel/dispatch.mjs';
import { runChannelNotifyTask } from '../../channel/tasks.mjs';
import { runChannelPresenceTask } from '../../channel/presence.mjs';
import { cancelDeprecatedChannelTasks } from '../../channel/queue-cleanup.mjs';
import { channelFeishuCommand } from './channel-feishu.mjs';
import { resolveFeishuConfig } from '../../channel/adapters/feishu/config.mjs';

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
  if (projection.presence?.config) {
    console.log(`presence: enabled=${projection.presence.config.enabled} planner=${projection.presence.config.planner ?? '-'}`);
  }
  if (projection.tasks.deprecated?.length) {
    console.log(`deprecated tasks: ${projection.tasks.deprecated.map((t) => `${t.type}(${t.status})`).join(', ')}`);
  }
}

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
      const wake = requestPresenceReactor(root, subject, {
        reason: 'manual_inbox_added',
        event: {
          type: 'manual_inbox_added',
          reason: flags.name ?? 'manual',
          payload_summary: { file: written.file },
        },
      });
      const result = {
        subject,
        ...written,
        task: wake.reactor_task,
        created: wake.reactor_created,
        event: wake.event,
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

  if (subcommand === 'send') {
    const dryRun = Boolean(flags['dry-run']);
    const target = flags.to && flags.to !== true ? flags.to : flags.target;
    const text = flags.text && flags.text !== true ? flags.text : null;
    if (!target || !text) {
      console.error('Usage: jea channel send --to TARGET --text TEXT [--dry-run]');
      return 2;
    }
    const outbound = normalizeOutboundMessage({
      channel: 'feishu',
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
    const projection = buildChannelProjection(root, subject, {
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    const hints = buildFeishuDoctorHints(root, subject, projection);
    const diagnostics = {
      subject,
      health: projection.health,
      queue: readChannelTaskQueue(root, subject),
      feishu: projection.feishu,
      hints,
    };
    if (flags.json) console.log(JSON.stringify(diagnostics, null, 2));
    else {
      printStatus(projection);
      for (const reason of projection.health.reasons ?? []) console.log(`reason: ${reason}`);
      for (const hint of hints) console.log(`hint: ${hint}`);
    }
    return projection.health.ok ? 0 : 1;
  }

  console.error('Usage: jea channel <status|events|inbox|outbox|send|tick|work|presence|queue|doctor|feishu> [--subject NAME] [--json]');
  return 2;
}
