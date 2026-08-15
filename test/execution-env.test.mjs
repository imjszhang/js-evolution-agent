import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionEnv } from '../src/actions/execution-env.mjs';
import { loadProjectEnv } from '../src/infra/project.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const jeaCli = join(repoRoot, 'src', 'cli', 'jea.mjs');
const DOTENV_INJECT_RE = /\[dotenv@\d/;

describe('execution env loading', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('lets execution root .env override stale base env values', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-env-'));
    writeFileSync(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=from-execution-root\n', 'utf-8');

    const { env } = buildExecutionEnv(tempDir, {
      baseEnv: { ...process.env, DEEPSEEK_API_KEY: 'stale-shell-value' },
    });

    expect(env.DEEPSEEK_API_KEY).toBe('from-execution-root');
  });

  it('loads project .env over pre-set process env when override is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-project-env-'));
    writeFileSync(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=from-project-env\n', 'utf-8');
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'stale-shell-value';

    try {
      loadProjectEnv(tempDir);
      expect(process.env.DEEPSEEK_API_KEY).toBe('from-project-env');
    } finally {
      if (previous == null) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it('does not print dotenv inject logs when loading a project .env', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-dotenv-quiet-'));
    writeFileSync(join(tempDir, '.env'), 'JEA_DOTENV_QUIET_PROBE=1\n', 'utf-8');
    const logs = [];
    const originalLog = console.log;
    const originalInfo = console.info;
    console.log = (...args) => { logs.push(args.join(' ')); };
    console.info = (...args) => { logs.push(args.join(' ')); };
    try {
      loadProjectEnv(tempDir);
      expect(process.env.JEA_DOTENV_QUIET_PROBE).toBe('1');
      expect(logs.join('\n')).not.toMatch(DOTENV_INJECT_RE);
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      delete process.env.JEA_DOTENV_QUIET_PROBE;
    }
  });

  it('keeps CLI, doctor, daemon, and JSON output free of dotenv inject logs', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-dotenv-cli-'));
    writeFileSync(join(tempDir, '.env'), 'JEA_DOTENV_QUIET_PROBE=cli\n', 'utf-8');
    const commands = [
      ['help'],
      ['doctor'],
      ['data', 'status', '--json'],
      ['daemon', 'status', '--json'],
    ];
    for (const args of commands) {
      const result = spawnSync(process.execPath, ['--preserve-symlinks', jeaCli, ...args], {
        cwd: repoRoot,
        env: { ...process.env, JEA_PROJECT_ROOT: tempDir },
        encoding: 'utf-8',
      });
      const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
      expect(combined, args.join(' ')).not.toMatch(DOTENV_INJECT_RE);
    }

    const oada = spawnSync(
      process.execPath,
      ['--preserve-symlinks', '--input-type=module', '-e', 'await import("./oada.config.mjs")'],
      { cwd: repoRoot, env: { ...process.env }, encoding: 'utf-8' },
    );
    expect(`${oada.stdout || ''}\n${oada.stderr || ''}`).not.toMatch(DOTENV_INJECT_RE);
  });
});
