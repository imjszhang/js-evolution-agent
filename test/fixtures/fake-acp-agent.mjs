import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

const sessionId = 'fake-session-1';
let prompts = 0;
let releaseHang;
let permissionOutcome = 'not_requested';

function record(event, fields = {}) {
  if (!process.env.FAKE_ACP_LOG) return;
  appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify({ event, ...fields })}\n`);
}

function update(client, update) {
  return client.notify(methods.client.session.update, { sessionId, update });
}

const app = agent({ name: 'fake-jea-acp-agent' })
  .onRequest(methods.agent.initialize, ({ params }) => {
    record('initialize', { protocolVersion: params.protocolVersion });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { text: true },
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: 'fake-jea-acp-agent', version: '1.0.0' },
      authMethods: [],
    };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    record('session_new', {
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories ?? [],
    });
    return { sessionId };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    prompts += 1;
    record('prompt', { number: prompts });
    if (process.env.FAKE_ACP_HANG === '1') {
      await new Promise((resolve) => { releaseHang = resolve; });
      return { stopReason: 'cancelled' };
    }

    if (prompts === 1 && process.env.FAKE_ACP_PERMISSION_KIND) {
      const kind = process.env.FAKE_ACP_PERMISSION_KIND;
      const toolCall = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: `${kind} fixture file`,
        kind,
        status: 'pending',
        locations: process.env.FAKE_ACP_PERMISSION_PATH
          ? [{ path: process.env.FAKE_ACP_PERMISSION_PATH }]
          : [],
        rawInput: process.env.FAKE_ACP_PERMISSION_PATH
          ? { path: process.env.FAKE_ACP_PERMISSION_PATH }
          : {},
      };
      await update(client, toolCall);
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      permissionOutcome = response.outcome.outcome === 'selected'
        ? response.outcome.optionId
        : response.outcome.outcome;
      await update(client, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: permissionOutcome === 'allow' ? 'completed' : 'failed',
        rawOutput: { permissionOutcome },
      });
    }

    let text = 'Initial work completed; verify the receipt.';
    if (prompts === 2 && process.env.FAKE_ACP_INVALID_FIRST_VERIFY === '1') {
      text = JSON.stringify({ status: 'partial' });
    } else if (prompts >= 2) {
      text = JSON.stringify({
        status: 'completed',
        summary: 'fake ACP action completed',
        action_type: 'agent_run',
        evidence: { permission_outcome: permissionOutcome, prompt_count: prompts },
        outputs: { fake: true },
      });
    }
    await update(client, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    record('cancel', { sessionId: params.sessionId });
    if (process.env.FAKE_ACP_IGNORE_CANCEL !== '1') releaseHang?.();
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    record('session_close', { sessionId: params.sessionId });
    return {};
  });

if (process.env.FAKE_ACP_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => record('sigterm_ignored'));
}

const connection = app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
await connection.closed;
if (process.env.FAKE_ACP_IGNORE_SIGTERM === '1') {
  await new Promise(() => setInterval(() => {}, 1_000));
}

