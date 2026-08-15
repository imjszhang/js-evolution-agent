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

const projectRoot = resolve(process.cwd());
const outputDir = mkdtempSync(join(tmpdir(), 'jea-desktop-smoke-'));
const output = join(outputDir, 'report.json');
const entry = join(projectRoot, 'apps', 'desktop', 'out', 'main', 'index.js');

if (!existsSync(entry)) {
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
    JEA_PROJECT_ROOT: projectRoot,
    JEA_DESKTOP_SMOKE: output,
  },
  windowsHide: true,
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  child.kill('SIGKILL');
}, 30_000);

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code));
}).finally(() => clearTimeout(timeout));

try {
  if (exitCode !== 0) throw new Error(`Desktop smoke exited with code ${exitCode}.`);
  if (!existsSync(output)) throw new Error('Desktop smoke did not write a report.');
  const report = JSON.parse(readFileSync(output, 'utf8'));
  if (!report?.inProcess?.ok || !report?.renderer?.ok) {
    throw new Error(`Desktop smoke failed: ${JSON.stringify(report)}`);
  }
  const artifacts = join(projectRoot, 'test-artifacts');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(artifacts, `desktop-smoke-${process.platform}.json`),
    `${JSON.stringify({ platform: process.platform, ...report }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
