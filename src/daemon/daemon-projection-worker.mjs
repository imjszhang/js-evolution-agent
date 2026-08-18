import { parentPort, workerData } from 'node:worker_threads';
import { buildDaemonProjectionUncached } from './daemon-projection.mjs';

const {
  root,
  subject,
  eventLimit = 20,
  heartbeatStaleMs = 60_000,
  flags = {},
} = workerData ?? {};

try {
  const projection = buildDaemonProjectionUncached(root, subject, {
    eventLimit,
    heartbeatStaleMs,
    flags,
  });
  parentPort.postMessage({ ok: true, projection });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
