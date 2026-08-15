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
  snapshotJeaHome,
  snapshotRuntimeSubjects,
} from './desktop-smoke-fixture.mjs';

const projectRoot = resolve(process.cwd());
const outputDir = mkdtempSync(join(tmpdir(), 'jea-desktop-smoke-'));
const output = join(outputDir, 'report.json');
const entry = join(projectRoot, 'apps', 'desktop', 'out', 'main', 'index.js');
let fixture = null;
let acpExecutionRoot = null;
let guardHome = null;
let child = null;
try {
  fixture = createDesktopSmokeFixture();
  acpExecutionRoot = mkdtempSync(join(tmpdir(), 'jea-smoke-acp-'));
  guardHome = mkdtempSync(join(tmpdir(), 'jea-smoke-user-home-'));
  const runtimeBefore = snapshotRuntimeSubjects(projectRoot);
  if (!existsSync(entry)) {
    throw new Error('Desktop build output is missing; run npm run desktop:build first.');
  }

  const electronArgs = [
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    entry,
  ];
  child = spawn(electron, electronArgs, {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: guardHome,
      USERPROFILE: guardHome,
      JEA_PROJECT_ROOT: projectRoot,
      JEA_HOME: fixture.jeaHome,
      JEA_DESKTOP_SMOKE: output,
      JEA_DESKTOP_SMOKE_SUBJECT: fixture.subject,
      JEA_DESKTOP_SMOKE_ACP_ROOT: acpExecutionRoot,
      JEA_ACP_CLAUDE_CODE_BIN: process.execPath,
      JEA_ACP_CLAUDE_CODE_ARGS: JSON.stringify([
        join(projectRoot, 'test', 'fixtures', 'fake-acp-agent.mjs'),
      ]),
    },
    windowsHide: true,
    stdio: 'inherit',
  });

  const timeout = setTimeout(() => {
    child?.kill('SIGKILL');
  }, 45_000);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  }).finally(() => clearTimeout(timeout));

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
  if (snapshotJeaHome(join(guardHome, '.jea')).files.length > 0) {
    throw new Error('Desktop smoke ignored the isolated JEA_HOME and wrote to the default home');
  }
  const artifacts = join(projectRoot, 'test-artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(artifacts, `desktop-smoke-${process.platform}.json`),
    `${JSON.stringify({
      platform: process.platform,
      fixture_jea_home: fixture.jeaHome,
      acp_execution_root: stages.acp?.execution_root ?? null,
      ...report,
    }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ...report,
    fixture_jea_home: fixture.jeaHome,
    acp_execution_root: stages.acp?.execution_root ?? null,
  }, null, 2)}\n`);
} finally {
  if (child && child.exitCode == null) child.kill('SIGKILL');
  removeDesktopSmokeFixture(fixture?.root);
  if (acpExecutionRoot) rmSync(acpExecutionRoot, { recursive: true, force: true });
  if (guardHome) rmSync(guardHome, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
}
