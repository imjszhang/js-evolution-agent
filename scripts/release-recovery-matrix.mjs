/**
 * Bounded / packaged recovery matrix for the current release.
 *
 * Linux CI runs --bounded (isolated Home + dir fixture, no JEA.app).
 * macOS release can pass --app / --packaged against a dir-only or JEA.app tree.
 * Never writes ~/.jea or repo runtime/. Mock-only.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, RELEASE_VERSION, repoRootFrom } from './release-lib.mjs';
import {
  applyRecoveryFixture,
  assertNoCheckoutDiscovery,
  createIsolatedRecoveryHome,
  DIAGNOSTIC_CANARIES,
  RECOVERY_FIXTURE_NAMES,
  scanRedactedDiagnostics,
  seedDiagnosticsCanaries,
  snapshotCleanup,
  writeChannelFixture,
  writeCycleFixture,
  writePackagedDirFixture,
  writeRunningChannelRecovery,
} from './release-recovery-fixtures.mjs';
import { productStatusPayload } from '../src/cli/commands/product.mjs';
import {
  currentStatus,
  webStartCommand,
  webStatusCommand,
  webStopCommand,
  webUrlCommand,
} from '../src/cli/commands/web.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { readinessCodeView, readSubjectReadiness } from '../src/product/subject-readiness.mjs';
import {
  loadBuildMetadata,
  writeBuildMetadata,
} from '../src/product/build-metadata.mjs';
import {
  looksLikePackagedApp,
  packagedSourceRootFromApp,
} from '../src/product/app-paths.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import { spawnStandInProcess, waitForExit } from './release-recovery-process.mjs';
import { processCycleOnce } from '../src/daemon/cycle-process-once.mjs';
import { listEligibleEvidence, readClaimLedger } from '../src/evolution/reactor/claim-ledger.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { runChannelClassifierTask } from '../src/channel/classifier.mjs';
import { runChannelPresenceTask } from '../src/channel/presence.mjs';
import { runChannelNotifyTask } from '../src/channel/tasks.mjs';
import { sendDesktopInboundMessage, readDesktopSession } from '../src/channel/adapters/desktop/index.mjs';
import { statusHasSecrets } from './release-product-journey.mjs';

const DEFAULT_WEB_PORT = 18791;
const WEB_BUNDLE = 'apps/desktop/out/web-host/server-main.mjs';

function timed(id, run) {
  const started = Date.now();
  return Promise.resolve()
    .then(run)
    .then((result) => {
      const duration_ms = Date.now() - started;
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        return { id, duration_ms, ...result, ok: result.ok !== false };
      }
      return { id, duration_ms, ok: Boolean(result), detail: result };
    })
    .catch((error) => ({
      id,
      duration_ms: Date.now() - started,
      ok: false,
      detail: error?.message || String(error),
    }));
}

function sameCodes(left, right) {
  return JSON.stringify(readinessCodeView(left)) === JSON.stringify(readinessCodeView(right));
}

export function evaluateReadinessConformance(runtime, subject, fixtureName) {
  const electron = readSubjectReadiness(runtime, subject, { hostKind: 'electron' });
  const web = readSubjectReadiness(runtime, subject, { hostKind: 'web' });
  const cli = productStatusPayload(runtime, { subject }, { hostKind: 'electron' });
  const codesMatch = sameCodes(electron, web) && sameCodes(cli, electron);
  const webNoLocal = !web.allowed_actions.includes('start_channel')
    && !web.allowed_actions.includes('start_cycle')
    && !web.allowed_actions.includes('repair_worker_state');
  const blockedNoStart = !(
    (electron.cycle.state === 'blocked' && electron.cycle.reasons.includes('cycle_running'))
    && electron.allowed_actions.includes('start_cycle')
  );
  const notes = [];
  if (fixtureName === 'dead-pid-zombie') {
    if (electron.cycle.state !== 'zombie' && electron.channel.state !== 'zombie') {
      notes.push('expected_zombie');
    }
  }
  if (fixtureName === 'reactor-backlog-stalled') {
    if (electron.cycle.state !== 'stalled' || !electron.allowed_actions.includes('process_cycle_once')) {
      notes.push('expected_process_cycle_once');
    }
    if (!web.allowed_actions.includes('process_cycle_once')) notes.push('web_missing_process_cycle_once');
  }
  if (fixtureName === 'externally-attached') {
    if (electron.cycle.state !== 'attached' && electron.channel.state !== 'attached') {
      notes.push('expected_attached');
    }
  }
  return {
    ok: codesMatch && webNoLocal && blockedNoStart && notes.length === 0,
    codesMatch,
    webNoLocal,
    electron,
    web,
    cli,
    notes,
  };
}

async function captureIo(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value) => { logs.push(String(value)); };
  console.error = (value) => { errors.push(String(value)); };
  try {
    const code = await run();
    return { code, logs, errors, text: [...logs, ...errors].join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

export async function runChannelJourney(runtime, subject) {
  const previousMock = process.env.JEA_FORCE_MOCK;
  process.env.JEA_FORCE_MOCK = '1';
  process.env.JEA_HOME = runtime.jeaHome;
  const worker = spawnStandInProcess({ detached: true });
  try {
    initData(runtime.sourceRoot, { subject, all: true });
    const before = readSubjectReadiness(runtime, subject, { hostKind: 'electron' });
    if (before.channel.state !== 'stopped' || before.conversation.state !== 'blocked') {
      return {
        ok: false,
        detail: `expected stopped/blocked, got channel=${before.channel.state} conversation=${before.conversation.state}`,
        before,
        child: worker,
      };
    }
    if (!before.allowed_actions.includes('start_channel')) {
      return { ok: false, detail: 'stopped channel did not recommend start_channel', before, child: worker };
    }

    writeRunningChannelRecovery(runtime, subject, { pid: worker.pid });
    const afterStart = readSubjectReadiness(runtime, subject, { hostKind: 'electron' });
    if (afterStart.channel.state !== 'running' && afterStart.channel.state !== 'attached') {
      return { ok: false, detail: `channel not recovered: ${afterStart.channel.state}`, afterStart, child: worker };
    }

    sendDesktopInboundMessage(runtime, subject, {
      session_id: 'main',
      text: '同意发布候选',
      message_id: 'recovery-matrix-channel-1',
    });
    const classified = await runChannelClassifierTask(runtime, subject);
    const presence = await runChannelPresenceTask(runtime, subject);
    await runChannelNotifyTask(runtime, subject);
    const page = readDesktopSession(runtime, subject, 'main', { tail: 20 });
    const assistant = (page.records || []).filter((record) => record.role === 'assistant');
    const leakedApproval = JSON.stringify(page).includes('approval_granted');
    const workerAlive = isProcessAlive(worker.pid);
    return {
      ok: classified.classified > 0
        && Boolean(presence.plan?.kind || presence.skipped)
        && assistant.length > 0
        && assistant.every((record) => String(record.content || '').trim().length > 0)
        && !leakedApproval
        && workerAlive
        && worker.pid !== process.pid,
      classified: classified.classified,
      assistant: assistant.length,
      leakedApproval,
      workerPid: worker.pid,
      workerAlive,
      before,
      afterStart,
      child: worker,
    };
  } finally {
    if (previousMock == null) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previousMock;
  }
}

export async function runCycleJourney(runtime, subject) {
  const previous = {
    JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
    JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
  };
  process.env.JEA_FORCE_MOCK = '1';
  process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
  process.env.JEA_HOME = runtime.jeaHome;
  try {
    initData(runtime.sourceRoot, { subject });
    applyRecoveryFixture(runtime, 'reactor-backlog-stalled', { subject });
    const first = await processCycleOnce(runtime.sourceRoot, subject, {
      mock: true,
      'skip-investigate': true,
    });
    const paths = runtimeForSubject(runtime, subject);
    const pending = listEligibleEvidence(paths.dataRoot, { reactor: 'cognitive' });
    const claims = readClaimLedger(paths.dataRoot).claims.filter((claim) => claim.reactor === 'cognitive');
    const handled = claims.filter((claim) => claim.status === 'handled');
    const second = await processCycleOnce(runtime.sourceRoot, subject, {
      mock: true,
      'skip-investigate': true,
    });
    const claimsAfter = readClaimLedger(paths.dataRoot).claims
      .filter((claim) => claim.reactor === 'cognitive' && claim.status === 'handled');
    const fixtureKey = 'brief-stalled-product-status';
    const fixtureHandled = claimsAfter.filter((claim) => (
      (claim.evidence_keys || []).some((key) => String(key).includes(fixtureKey))
      || (claim.event_ids || []).some((id) => String(id).includes(fixtureKey))
      || String(claim.id || '').includes(fixtureKey)
    ));
    const stillEligible = listEligibleEvidence(paths.dataRoot, { reactor: 'cognitive' })
      .some((envelope) => (
        String(envelope.id ?? '').includes(fixtureKey)
        || String(envelope.payload?.id ?? '').includes(fixtureKey)
        || String(envelope.evidence_key ?? '').includes(fixtureKey)
      ));
    return {
      ok: (first.status === 'ok' || first.status === 'idle')
        && ['ok', 'idle'].includes(second.status)
        && fixtureHandled.length <= 1
        && !stillEligible,
      first: first.status,
      second: second.status,
      handled: handled.length,
      handledAfter: claimsAfter.length,
      fixtureHandled: fixtureHandled.length,
      fixtureStillEligible: stillEligible,
    };
  } finally {
    if (previous.JEA_FORCE_MOCK == null) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previous.JEA_FORCE_MOCK;
    if (previous.JEA_REACTOR_SKIP_INVESTIGATE == null) delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
    else process.env.JEA_REACTOR_SKIP_INVESTIGATE = previous.JEA_REACTOR_SKIP_INVESTIGATE;
  }
}

export async function runExternalAttachJourney(runtime, subject, { child } = {}) {
  const daemon = child || spawnStandInProcess({ detached: true });
  const product = spawnStandInProcess({ detached: false });
  try {
    applyRecoveryFixture(runtime, 'externally-attached', { subject, livePid: daemon.pid });
    const readiness = readSubjectReadiness(runtime, subject, { hostKind: 'electron' });
    const attached = readiness.cycle.state === 'attached' || readiness.channel.state === 'attached';
    const productGone = await waitForExit(product);
    const stillAlive = isProcessAlive(daemon.pid);
    return {
      ok: stillAlive
        && productGone
        && attached
        && !readiness.allowed_actions.includes('stop_managed'),
      pid: daemon.pid,
      productPid: product.pid,
      stillAlive,
      productGone,
      attached,
      cycle: readiness.cycle.state,
      channel: readiness.channel.state,
      child: daemon,
      product,
    };
  } catch (error) {
    await waitForExit(product);
    return { ok: false, detail: error.message, child: daemon, product };
  }
}

export async function runThreeRestartCycles(runtime, subject, {
  withWeb = false,
  port = DEFAULT_WEB_PORT,
} = {}) {
  const cycles = [];
  for (let index = 0; index < 3; index += 1) {
    applyRecoveryFixture(runtime, 'mixed-domain', { subject });
    if (withWeb) {
      await webStopCommand({ context: runtime }).catch(() => {});
      const started = await captureIo(() => webStartCommand({
        flags: { port: port + index, 'no-open': true },
        context: runtime,
      }));
      const status = currentStatus(runtime.jeaHome);
      const stopped = await captureIo(() => webStopCommand({ context: runtime }));
      const after = currentStatus(runtime.jeaHome);
      const pidGone = !status.pid || !isProcessAlive(status.pid);
      cycles.push({
        index,
        ok: started.code === 0 && stopped.code === 0 && after.running === false && pidGone,
        web: true,
        started: started.code,
        stopped: stopped.code,
        after,
      });
    } else {
      const product = spawnStandInProcess({ detached: false });
      writeChannelFixture(runtime, subject, {
        status: 'running',
        pid: product.pid,
        heartbeat_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      });
      writeCycleFixture(runtime, subject, {
        status: 'running',
        pid: product.pid,
        heartbeat_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
      });
      const productGone = await waitForExit(product);
      writeChannelFixture(runtime, subject, { status: 'stopped', pid: null });
      writeCycleFixture(runtime, subject, { status: 'stopped', pid: null, heartbeat_at: null });
      const readiness = readSubjectReadiness(runtime, subject, { hostKind: 'electron' });
      const snap = snapshotCleanup(runtime.jeaHome);
      const falseStale = readiness.cycle.state === 'zombie'
        || readiness.cycle.state === 'stale'
        || readiness.channel.state === 'zombie'
        || readiness.channel.state === 'stale';
      cycles.push({
        index,
        ok: productGone
          && !falseStale
          && !currentStatus(runtime.jeaHome).running,
        web: false,
        productPid: product.pid,
        productGone,
        cycle: readiness.cycle.state,
        channel: readiness.channel.state,
        held: snap.held.length,
        locks: snap.locks.length,
      });
    }
  }
  return { ok: cycles.every((item) => item.ok), cycles };
}

export async function runWebHostJourney(runtime, {
  port = DEFAULT_WEB_PORT,
  repoRoot,
} = {}) {
  const bundle = existsSync(join(repoRoot, WEB_BUNDLE));
  if (!bundle) {
    const stopped = currentStatus(runtime.jeaHome);
    const captured = await captureIo(() => webStatusCommand({
      flags: { json: true },
      context: runtime,
    }));
    let payload = null;
    try {
      payload = JSON.parse(captured.logs.join('\n'));
    } catch {
      payload = null;
    }
    return {
      ok: captured.code === 0 && payload && payload.running === false && !statusHasSecrets(payload),
      skipped: 'no_web_bundle',
      stopped,
      payload,
    };
  }

  await webStopCommand({ context: runtime }).catch(() => {});
  const start = await captureIo(() => webStartCommand({
    flags: { port, 'no-open': true },
    context: runtime,
  }));
  const status = await captureIo(() => webStatusCommand({
    flags: { json: true },
    context: runtime,
  }));
  let statusJson = null;
  try {
    statusJson = JSON.parse(status.logs.join('\n'));
  } catch {
    statusJson = null;
  }
  const url = await captureIo(() => webUrlCommand({ context: runtime }));
  const stop = await captureIo(() => webStopCommand({ context: runtime }));
  const after = currentStatus(runtime.jeaHome);
  return {
    ok: start.code === 0
      && status.code === 0
      && statusJson?.running === true
      && !statusHasSecrets(statusJson)
      && url.code === 0
      && /access_token=/.test(url.logs.join('\n'))
      && stop.code === 0
      && after.running === false,
    start: start.code,
    status: statusJson,
    url: url.code,
    stop: stop.code,
    after,
  };
}

export function runDiagnosticsScan(runtime) {
  seedDiagnosticsCanaries(runtime.jeaHome);
  const report = {
    host: { jea_home: runtime.jeaHome, subject: 'alpha' },
    env: { DEEPSEEK_API_KEY: DIAGNOSTIC_CANARIES.apiKey },
    session: { access_token: DIAGNOSTIC_CANARIES.webToken },
    daemon: { owner_secret: DIAGNOSTIC_CANARIES.ownerToken },
    readiness: readSubjectReadiness(runtime, 'alpha', { hostKind: 'electron' }),
  };
  return scanRedactedDiagnostics(report, { jeaHome: runtime.jeaHome });
}

export function evaluatePackagedProvenance({ sourceRoot, repoRoot, expectedCommit = null }) {
  const loaded = loadBuildMetadata({ sourceRoot, collect: false });
  const discovery = assertNoCheckoutDiscovery({ sourceRoot, repoRoot });
  const commitOk = expectedCommit ? loaded.commit === expectedCommit : Boolean(loaded.commit);
  return {
    ok: discovery.ok && commitOk && Boolean(loaded.build_id),
    loaded,
    discovery,
    commitOk,
  };
}

function resolvePackagedRoot({ repoRoot, appPath, metadata }) {
  if (appPath && looksLikePackagedApp(appPath)) {
    return {
      kind: 'app',
      sourceRoot: packagedSourceRootFromApp(appPath),
      appPath,
      metadata: loadBuildMetadata({ sourceRoot: packagedSourceRootFromApp(appPath), collect: false }),
    };
  }
  const dir = join(tmpdir(), `jea-recovery-packaged-${process.pid}`);
  const fixture = writePackagedDirFixture({
    outDir: dir,
    metadata: metadata || {
      version: RELEASE_VERSION,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirty: false,
      built_at: '2026-08-17T00:00:00.000Z',
      platform: process.platform,
      arch: process.arch,
    },
  });
  return {
    kind: 'dir',
    sourceRoot: fixture.sourceRoot,
    appPath: null,
    metadata: fixture.metadata,
    disposable: dir,
  };
}

export async function runRecoveryMatrix({
  repoRoot,
  mode = 'bounded',
  appPath = null,
  withWeb = false,
  keepHome = false,
  outDir = null,
  webPort = DEFAULT_WEB_PORT,
} = {}) {
  const previousHome = process.env.JEA_HOME;
  const previousProject = process.env.JEA_PROJECT_ROOT;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.JEA_FORCE_MOCK = '1';

  const packaged = resolvePackagedRoot({
    repoRoot,
    appPath: mode === 'packaged' ? appPath : null,
  });
  const home = createIsolatedRecoveryHome({
    prefix: 'jea-recovery-matrix-',
    metadata: packaged.metadata,
  });
  process.env.JEA_HOME = home.jeaHome;
  process.env.JEA_PROJECT_ROOT = packaged.sourceRoot;

  const steps = [];
  let attachChild = null;

  try {
    steps.push(await timed('isolated_home', () => ({
      ok: home.jeaHome.startsWith(tmpdir()) && !home.jeaHome.includes(`${repoRoot}/runtime`),
      jeaHome: keepHome ? home.jeaHome : '(temp)',
    })));

    steps.push(await timed('packaged_provenance', () => (
      evaluatePackagedProvenance({
        sourceRoot: packaged.sourceRoot,
        repoRoot,
        expectedCommit: packaged.metadata?.commit,
      })
    )));

    if (mode === 'packaged' && appPath) {
      steps.push(await timed('packaged_app', () => ({
        ok: looksLikePackagedApp(appPath),
        appPath,
        sourceRoot: packaged.sourceRoot,
      })));
    }

    for (const name of RECOVERY_FIXTURE_NAMES) {
      steps.push(await timed(`fixture_${name}`, () => {
        const fixtureHome = createIsolatedRecoveryHome({
          prefix: `jea-recovery-${name}-`,
          metadata: packaged.metadata,
        });
        applyRecoveryFixture(fixtureHome.runtime, name);
        const conformance = evaluateReadinessConformance(fixtureHome.runtime, fixtureHome.subject, name);
        if (!keepHome) {
          rmSync(fixtureHome.jeaHome, { recursive: true, force: true });
          rmSync(fixtureHome.sourceRoot, { recursive: true, force: true });
        }
        return { ...conformance, fixture: name };
      }));
    }

    const channel = await timed('channel_journey', () => runChannelJourney(home.runtime, home.subject));
    steps.push(channel);
    if (channel.child?.pid) {
      await waitForExit(channel.child);
      delete channel.child;
    }
    steps.push(await timed('cycle_journey', () => runCycleJourney(home.runtime, home.subject)));

    const attach = await runExternalAttachJourney(home.runtime, home.subject);
    attachChild = attach.child;
    steps.push({
      id: 'external_attach',
      ok: attach.ok,
      duration_ms: 0,
      pid: attach.pid,
      stillAlive: attach.stillAlive,
      cycle: attach.cycle,
      channel: attach.channel,
      detail: attach.detail,
    });
    if (attachChild?.pid && isProcessAlive(attachChild.pid)) {
      try { process.kill(attachChild.pid, 'SIGTERM'); } catch { /* test cleanup */ }
    }

    const restartHome = createIsolatedRecoveryHome({
      prefix: 'jea-recovery-restarts-',
      metadata: packaged.metadata,
    });
    steps.push(await timed('three_restarts', async () => {
      const result = await runThreeRestartCycles(restartHome.runtime, restartHome.subject, {
        withWeb: withWeb && existsSync(join(repoRoot, WEB_BUNDLE)),
        port: webPort,
      });
      if (!keepHome) {
        rmSync(restartHome.jeaHome, { recursive: true, force: true });
        rmSync(restartHome.sourceRoot, { recursive: true, force: true });
      }
      return result;
    }));

    steps.push(await timed('web_host', () => runWebHostJourney(home.runtime, {
      port: webPort,
      repoRoot,
    })));

    steps.push(await timed('diagnostics_redaction', () => runDiagnosticsScan(home.runtime)));

    const ok = steps.every((item) => item.ok);
    const report = {
      ok,
      status: ok ? 'passed' : 'failed',
      mode,
      release: RELEASE_VERSION,
      certification: RELEASE_VERSION,
      platform: `${process.platform}-${process.arch}`,
      build_id: packaged.metadata?.build_id ?? loadBuildMetadata({ sourceRoot: packaged.sourceRoot, collect: false }).build_id,
      commit: packaged.metadata?.commit ?? null,
      dirty: packaged.metadata?.dirty ?? null,
      generated_at: new Date().toISOString(),
      jeaHome: keepHome ? home.jeaHome : '(removed)',
      wroteUserHome: false,
      steps,
    };
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'recovery-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
      if (packaged.metadata) writeBuildMetadata(outDir, packaged.metadata);
      report.evidence = join(outDir, 'recovery-matrix.json');
    }
    return report;
  } finally {
    if (attachChild?.pid && isProcessAlive(attachChild.pid)) {
      try { process.kill(attachChild.pid, 'SIGKILL'); } catch { /* test cleanup */ }
    }
    await webStopCommand({ context: home.runtime }).catch(() => {});
    if (!keepHome) {
      rmSync(home.jeaHome, { recursive: true, force: true });
      rmSync(home.sourceRoot, { recursive: true, force: true });
      if (packaged.disposable) rmSync(packaged.disposable, { recursive: true, force: true });
    }
    if (previousHome == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
    if (previousProject == null) delete process.env.JEA_PROJECT_ROOT;
    else process.env.JEA_PROJECT_ROOT = previousProject;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const mode = args.packaged ? 'packaged' : 'bounded';
  const report = await runRecoveryMatrix({
    repoRoot,
    mode,
    appPath: args.app || process.env.JEA_APP_PATH || join(repoRoot, 'dist/release/build/mac-arm64/JEA.app'),
    withWeb: Boolean(args['with-web']),
    keepHome: Boolean(args['keep-home']),
    outDir: args.out ? resolve(args.out) : null,
    webPort: args.port ? Number(args.port) : DEFAULT_WEB_PORT,
  });
  report.script = 'release-recovery-matrix';
  report.messages = [
    `status ${report.status}`,
    `mode ${report.mode}`,
    ...report.steps.map((item) => `${item.ok ? 'ok' : 'fail'} ${item.id}${item.detail ? `: ${item.detail}` : ''}`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
