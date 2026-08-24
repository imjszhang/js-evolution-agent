/**
 * Shared recovery fixtures for the current release.
 *
 * Writers only. Readiness projection stays in service.getReadiness /
 * readSubjectReadiness — do not duplicate that logic here.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import lockfile from 'proper-lockfile';
import { writeChannelWorkerState } from '../src/channel/worker-state.mjs';
import { writeWorkerState } from '../src/daemon/daemon-worker-state.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';
import { isJeaSourceRoot } from '../src/product/app-paths.mjs';
import { redactMachinePaths } from '../src/product/path-redact.mjs';
import { redactSecrets } from '../src/intelligence/redaction.mjs';
import { getProjectRoot } from '../src/infra/project.mjs';

export const RECOVERY_SUBJECT = 'alpha';
export const DEAD_PID = 999_999_999;
export const RECOVERY_FIXTURE_NAMES = [
  'all-stopped',
  'mixed-domain',
  'dead-pid-zombie',
  'externally-attached',
  'reactor-backlog-stalled',
];

export const DIAGNOSTIC_CANARIES = Object.freeze({
  apiKey: 'sk-canary-api-key-142-should-never-export',
  webToken: 'jea-web-token-canary-142-aabbccddeeff',
  ownerToken: 'owner-token-canary-142-001122334455',
  messageBody: 'CANARY_MESSAGE_BODY_142_do_not_export_this_conversation',
});

export function nowIso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function asRuntime(runtime) {
  if (!runtime) throw new Error('runtime is required');
  if (typeof runtime === 'string') return { sourceRoot: runtime, jeaHome: process.env.JEA_HOME };
  return {
    sourceRoot: runtime.sourceRoot,
    jeaHome: runtime.jeaHome,
  };
}

export function createIsolatedRecoveryHome({
  subject = RECOVERY_SUBJECT,
  namespace = `${subject}-data`,
  prefix = 'jea-recovery-',
  metadata = null,
  withPolicies = true,
} = {}) {
  const sourceRoot = mkdtempSync(join(tmpdir(), `${prefix}src-`));
  const jeaHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));

  writeFileSync(join(sourceRoot, 'oada.config.mjs'), 'export default { version: 1 };\n');
  writeFileSync(join(sourceRoot, 'package.json'), `${JSON.stringify({
    name: 'jea',
    version: PRODUCT_VERSION,
    type: 'module',
  }, null, 2)}\n`);
  mkdirSync(join(sourceRoot, 'src', 'cli'), { recursive: true });
  writeFileSync(join(sourceRoot, 'src', 'cli', 'jea.mjs'), 'export async function main() { return 0; }\n');

  if (metadata) {
    mkdirSync(join(sourceRoot, 'src', 'product'), { recursive: true });
    writeBuildMetadata(join(sourceRoot, 'src', 'product'), metadata);
  }

  if (withPolicies) {
    mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true });
    mkdirSync(join(sourceRoot, 'policies', 'authority'), { recursive: true });
    writeFileSync(join(sourceRoot, 'policies', 'subjects', `${subject}.md`), [
      `# ${subject}`,
      '',
      '## Subject',
      `${subject} recovery fixture.`,
      '',
    ].join('\n'));
    writeFileSync(join(sourceRoot, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n\nRecovery fixture.\n');
    writeFileSync(join(sourceRoot, 'policies', 'authority', 'GUIDE.md'), '# Guide\n\nRecovery fixture.\n');
    writeFileSync(join(sourceRoot, 'policies', 'active-subject.json'), `${JSON.stringify({
      active: subject,
      policy: `subjects/${subject}.md`,
      data_namespace: namespace,
    }, null, 2)}\n`);
  }

  mkdirSync(join(jeaHome, 'subjects', namespace), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', namespace, 'SUBJECT.md'), [
    `# ${subject}`,
    '',
    '## Subject',
    'Recovery fixture subject with desktop Channel enabled.',
    '',
    '## Persona',
    'Concise operator-facing replies. Do not grant approvals.',
    '',
  ].join('\n'));
  writeFileSync(join(jeaHome, 'subjects', namespace, 'SOUL.md'), `# ${subject} Soul\nConcise.\n`);
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), `${JSON.stringify({
    default_subject: subject,
    subjects: {
      [subject]: {
        data_namespace: namespace,
        policy: 'SUBJECT.md',
        evolution: { pipeline: 'reactor' },
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          classifier: { enabled: true, mode: 'deterministic', batch_size: 20 },
          presence: {
            enabled: true,
            planner: 'deterministic',
            default_transport: 'desktop',
            default_target: 'desktop:main',
          },
        },
      },
    },
  }, null, 2)}\n`);
  mkdirSync(join(jeaHome, 'subjects', namespace, 'data', 'evolution'), { recursive: true });

  process.env.JEA_HOME = jeaHome;
  const runtime = { sourceRoot, jeaHome };
  return { sourceRoot, jeaHome, subject, namespace, runtime };
}

export function writeChannelFixture(runtime, subject, patch = {}) {
  const status = patch.status ?? 'stopped';
  const pid = patch.pid ?? null;
  const heartbeat = patch.heartbeat_at ?? null;
  const startedAt = patch.started_at ?? heartbeat;
  const workers = patch.workers ?? (status === 'stopped'
    ? {}
    : {
      notify: {
        role: 'notify',
        worker_id: 'channel-fixture',
        pid,
        status,
        started_at: startedAt,
        heartbeat_at: heartbeat,
        stale_after_ms: 60_000,
      },
    });
  return writeChannelWorkerState(asRuntime(runtime), subject, {
    subject,
    domain: 'channel',
    schema_version: 2,
    workers,
    coordinator: pid ? { pid, started_at: startedAt } : null,
    worker_id: null,
    pid,
    status,
    started_at: startedAt ?? null,
    heartbeat_at: heartbeat,
    stale_after_ms: 60_000,
  });
}

export function writeCycleFixture(runtime, subject, patch = {}) {
  return writeWorkerState(asRuntime(runtime), subject, {
    subject,
    worker_id: 'cycle-fixture',
    pid: null,
    status: 'stopped',
    started_at: null,
    heartbeat_at: null,
    stale_after_ms: 60_000,
    ...patch,
  });
}

export function writeRunningChannelRecovery(runtime, subject, { pid = process.pid } = {}) {
  const now = nowIso();
  return writeChannelFixture(runtime, subject, {
    pid,
    status: 'running',
    started_at: now,
    heartbeat_at: now,
    workers: {
      classifier: {
        role: 'classifier',
        worker_id: 'channel-recovery-classifier',
        pid,
        status: 'running',
        started_at: now,
        heartbeat_at: now,
        stale_after_ms: 60_000,
      },
    },
  });
}

export function applyRecoveryFixture(runtime, name, {
  subject = RECOVERY_SUBJECT,
  livePid = process.pid,
  deadPid = DEAD_PID,
} = {}) {
  const ctx = asRuntime(runtime);
  if (name === 'all-stopped') return { name };
  if (name === 'mixed-domain') {
    writeChannelFixture(ctx, subject, {
      pid: livePid,
      status: 'running',
      heartbeat_at: nowIso(),
      started_at: nowIso(),
    });
    return { name };
  }
  if (name === 'dead-pid-zombie') {
    writeCycleFixture(ctx, subject, {
      pid: deadPid,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000),
    });
    writeChannelFixture(ctx, subject, {
      pid: deadPid,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000),
    });
    return { name };
  }
  if (name === 'externally-attached') {
    writeCycleFixture(ctx, subject, {
      pid: livePid,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso(),
    });
    writeChannelFixture(ctx, subject, {
      pid: livePid,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso(),
    });
    return { name };
  }
  if (name === 'reactor-backlog-stalled') {
    const paths = runtimeForSubject(ctx, subject);
    writePendingOperatorBrief(paths.runtimeRoot, {
      id: 'brief-stalled-product-status',
      summary: 'stale evidence for product status',
      created_at: nowIso(-2 * 60 * 60 * 1000),
    });
    return { name };
  }
  throw new Error(`Unknown recovery fixture: ${name}`);
}

export function seedDiagnosticsCanaries(jeaHome, canaries = DIAGNOSTIC_CANARIES) {
  writeFileSync(join(jeaHome, '.env'), `DEEPSEEK_API_KEY=${canaries.apiKey}\n`);
  mkdirSync(join(jeaHome, 'web-host'), { recursive: true });
  writeFileSync(join(jeaHome, 'web-host', 'session'), canaries.webToken);
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon'), { recursive: true });
  writeFileSync(
    join(jeaHome, 'subjects', 'alpha', 'evolution', 'daemon', 'desktop-supervisor.json'),
    JSON.stringify({ owner_token: canaries.ownerToken, pid: 4242 }, null, 2),
  );
  return canaries;
}

export function scanRedactedDiagnostics(value, {
  jeaHome = null,
  canaries = DIAGNOSTIC_CANARIES,
  home = null,
} = {}) {
  const redacted = redactMachinePaths(redactSecrets(value), { home, jeaHome });
  const text = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
  const leaks = [];
  if (text.includes(canaries.apiKey)) leaks.push('api_key');
  if (text.includes(canaries.webToken)) leaks.push('web_token');
  if (text.includes(canaries.ownerToken)) leaks.push('owner_token');
  if (text.includes(canaries.messageBody)) leaks.push('message_body');
  if (/DEEPSEEK_API_KEY=/.test(text) && text.includes(canaries.apiKey)) leaks.push('env_api_key');
  if (jeaHome && text.includes(jeaHome)) leaks.push('jea_home_path');
  if (/(?:\/Users\/|\/home\/)[^/"'\s]+/.test(text) && !text.includes('<HOME>') && !text.includes('<JEA_HOME>')) {
    const rawHome = text.match(/(?:\/Users\/|\/home\/)[^/"'\s]+/);
    if (rawHome && !rawHome[0].includes('<')) leaks.push('machine_path');
  }
  return {
    ok: leaks.length === 0,
    leaks,
    text,
    redacted,
  };
}

export function writePackagedDirFixture({
  outDir,
  metadata,
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  const dest = resolve(outDir);
  mkdirSync(join(dest, 'src', 'cli'), { recursive: true });
  mkdirSync(join(dest, 'src', 'product'), { recursive: true });
  writeFileSync(join(dest, 'oada.config.mjs'), 'export default { version: 1 };\n');
  writeFileSync(join(dest, 'package.json'), `${JSON.stringify({
    name: 'jea',
    version: PRODUCT_VERSION,
    type: 'module',
  }, null, 2)}\n`);
  writeFileSync(join(dest, 'src', 'cli', 'jea.mjs'), 'export async function main() { return 0; }\n');
  const written = metadata
    ? writeBuildMetadata(join(dest, 'src', 'product'), metadata)
    : null;
  return {
    sourceRoot: dest,
    isPackagedRoot: isJeaSourceRoot(dest),
    metadata: written?.metadata ?? null,
  };
}

export function assertNoCheckoutDiscovery({ sourceRoot, repoRoot }) {
  const absSource = resolve(sourceRoot);
  const absRepo = resolve(repoRoot);
  const previous = process.env.JEA_PROJECT_ROOT;
  process.env.JEA_PROJECT_ROOT = absSource;
  let resolved;
  try {
    resolved = getProjectRoot();
  } finally {
    if (previous == null) delete process.env.JEA_PROJECT_ROOT;
    else process.env.JEA_PROJECT_ROOT = previous;
  }
  const isCheckoutRoot = absSource === absRepo;
  const insideRepo = isCheckoutRoot || absSource.startsWith(`${absRepo}${sep}`);
  return {
    // Dir-only / CI artifacts live under <repo>/dist/.../JEA.app. That is not
    // checkout discovery: fail only when the packaged source *is* the repo root,
    // or when getProjectRoot() walks away from the embedded tree.
    ok: resolved === absSource && isJeaSourceRoot(absSource) && !isCheckoutRoot,
    resolved,
    sourceRoot: absSource,
    repoRoot: absRepo,
    insideRepo,
    isCheckoutRoot,
    isJeaSourceRoot: isJeaSourceRoot(absSource),
  };
}

export function listLockFiles(root) {
  const files = [];
  if (!root || !existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.lock')) files.push(full);
    }
  }
  return files.sort();
}

export function heldLocks(root) {
  return listLockFiles(root).filter((file) => {
    try {
      return lockfile.checkSync(file.replace(/\.lock$/, '')) === true
        || lockfile.checkSync(file) === true;
    } catch {
      return false;
    }
  });
}

export function walkFiles(root) {
  const files = [];
  if (!root || !existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files.sort();
}

export function snapshotCleanup(jeaHome) {
  return {
    locks: listLockFiles(jeaHome),
    held: heldLocks(jeaHome),
    webState: existsSync(join(jeaHome, 'web-host', 'state.json')),
    files: walkFiles(jeaHome).length,
  };
}
