import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
import {
  createDesktopSmokeFixture,
  removeDesktopSmokeFixture,
  runtimeSubjectsChanged,
  snapshotRuntimeSubjects,
} from './desktop-smoke-fixture.mjs';

const projectRoot = resolve(process.cwd());
const outputDir = mkdtempSync(join(tmpdir(), 'jea-desktop-smoke-'));
const output = join(outputDir, 'report.json');
const entry = join(projectRoot, 'apps', 'desktop', 'out', 'main', 'index.js');
const fixture = createDesktopSmokeFixture();
const runtimeBefore = snapshotRuntimeSubjects(projectRoot);

if (!existsSync(entry)) {
  removeDesktopSmokeFixture(fixture.root);
  rmSync(outputDir, { recursive: true, force: true });
  throw new Error('Desktop build output is missing; run npm run desktop:build first.');
}

const electronArgs = [
  ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
  entry,
];
const child = spawn(electron, electronArgs, {
  cwd: projectRoot,
  env: {
    ...process.env,
    JEA_PROJECT_ROOT: fixture.root,
    JEA_DESKTOP_SMOKE: output,
    JEA_DESKTOP_SMOKE_SUBJECT: fixture.subject,
    JEA_ACP_CLAUDE_CODE_BIN: process.execPath,
    JEA_ACP_CLAUDE_CODE_ARGS: JSON.stringify([
      join(projectRoot, 'test', 'fixtures', 'fake-acp-agent.mjs'),
    ]),
  },
  windowsHide: true,
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
}, 45_000);

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code));
}).finally(() => clearTimeout(timeout));

try {
  if (exitCode !== 0) throw new Error(`Desktop smoke exited with code ${exitCode}.`);
  if (!existsSync(output)) throw new Error('Desktop smoke did not write a report.');
  const report = JSON.parse(readFileSync(output, 'utf8'));
  const stages = report?.stages ?? {};
  const stagesOk = ['projection', 'channel', 'notifications', 'acp']
    .every((name) => stages[name]?.ok);
  if (!report?.inProcess?.ok || !report?.renderer?.ok || !stagesOk) {
    throw new Error(`Desktop smoke failed: ${JSON.stringify(report)}`);
  }
  const runtimeAfter = snapshotRuntimeSubjects(projectRoot);
  if (runtimeSubjectsChanged(runtimeBefore, runtimeAfter)) {
    throw new Error('Desktop smoke wrote to the real runtime/subjects directory');
  }
  const artifacts = join(projectRoot, 'test-artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(artifacts, `desktop-smoke-${process.platform}.json`),
    `${JSON.stringify({
      platform: process.platform,
      fixture_root: fixture.root,
      acp_execution_root: stages.acp?.execution_root ?? null,
      ...report,
    }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ...report,
    fixture_root: fixture.root,
    acp_execution_root: stages.acp?.execution_root ?? null,
  }, null, 2)}\n`);
} finally {
  removeDesktopSmokeFixture(fixture.root);
  rmSync(outputDir, { recursive: true, force: true });
}
