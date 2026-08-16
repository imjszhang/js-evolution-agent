import { runChannelDomainWorkerMulti } from '../../src/channel/domain-worker.mjs';
import { channelWorkOnce } from '../../src/daemon/daemon-core.mjs';

const [root, mode] = process.argv.slice(2);
let announced = false;
const announce = () => {
  if (announced) return;
  announced = true;
  process.stdout.write(`BLOCKED:${mode}\n`);
};
const never = () => {
  announce();
  return new Promise(() => {});
};

const role = mode === 'send' ? 'notify' : mode === 'agent' ? 'agent' : 'classifier';

await runChannelDomainWorkerMulti(root, 'alpha', { force: true }, {
  roles: [role],
  tickMs: 60_000,
  leaseMs: 1000,
  heartbeatStaleMs: 5000,
  workIntervalMs: 0,
  idleIntervalMs: 50,
  maxIterations: null,
  ensureListener: mode === 'listener' ? never : async () => ({ action: 'idle' }),
  channelWorkOnce: mode === 'send'
    ? (sourceRoot, subject, flags) => channelWorkOnce(sourceRoot, subject, {
      ...flags,
      adapterOptions: {
        cfg: {
          subject,
          enabled: true,
          listenerEnabled: false,
          mock: false,
          appId: 'cli_alpha',
          appSecret: 'fixture-secret',
          domain: 'feishu',
          sendTimeoutMs: 60_000,
        },
        sender: { sendText: never },
      },
    })
    : mode === 'agent'
      ? (sourceRoot, subject, flags) => channelWorkOnce(sourceRoot, subject, {
        ...flags,
        adapterOptions: {
          mock_execute: never,
        },
      })
      : async () => {
        announce();
        return { worked: false, ok: true, task: null };
      },
});
