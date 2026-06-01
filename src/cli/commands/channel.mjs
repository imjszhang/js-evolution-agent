import { getProjectRoot } from '../utils/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { parseHeartbeatStaleMs } from '../utils/daemon-worker-state.mjs';
import { buildChannelProjection } from '../../channel/projection.mjs';
import { readChannelEvents } from '../../channel/audit.mjs';
import { writePendingInbound, listPendingInbound, listOutboxPending, writeOutboxMessage } from '../../channel/state.mjs';
import { normalizeOutboundMessage } from '../../channel/types.mjs';
import { enqueueChannelTask, readChannelTaskQueue } from '../../channel/task-queue.mjs';
import { runChannelTick } from '../../channel/dispatch.mjs';
import { runChannelWatchTask, runChannelNotifyTask } from '../../channel/tasks.mjs';

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
}

export async function channelCommand({ subcommand, flags = {}, args = [], root = getProjectRoot() } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const subject = runtime.subject;

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
      const task = enqueueChannelTask(root, subject, {
        type: 'channel_ingest',
        priority: 20,
        idempotencyKey: `${subject}:channel_ingest:manual`,
      });
      const result = { subject, ...written, task: task.task, created: task.created };
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
    enqueueChannelTask(root, subject, {
      type: 'channel_notify',
      priority: 40,
      idempotencyKey: `${subject}:channel_notify:manual`,
    });
    if (flags.json) console.log(JSON.stringify(written, null, 2));
    else console.log(`queued outbound -> ${written.file}`);
    return 0;
  }

  if (subcommand === 'tick') {
    const result = runChannelTick(root, subject, { poll_inbound: Boolean(flags['poll-inbound']) });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`channel tick enqueued ${result.enqueued.filter((item) => item?.created).length} task(s)`);
    return 0;
  }

  if (subcommand === 'work') {
    const action = args[0] ?? 'watch';
    const result = action === 'notify'
      ? await runChannelNotifyTask(root, subject, flags)
      : await runChannelWatchTask(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`channel ${action} complete`);
    return 0;
  }

  if (subcommand === 'doctor') {
    const projection = buildChannelProjection(root, subject, {
      heartbeatStaleMs: parseHeartbeatStaleMs(flags['heartbeat-stale-ms']),
    });
    const diagnostics = {
      subject,
      health: projection.health,
      queue: readChannelTaskQueue(root, subject),
    };
    if (flags.json) console.log(JSON.stringify(diagnostics, null, 2));
    else {
      printStatus(projection);
      for (const reason of projection.health.reasons ?? []) console.log(`reason: ${reason}`);
    }
    return projection.health.ok ? 0 : 1;
  }

  console.error('Usage: jea channel <status|events|inbox|outbox|send|tick|work|doctor> [--subject NAME] [--json]');
  return 2;
}
