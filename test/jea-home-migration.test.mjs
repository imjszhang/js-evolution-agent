import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  inspectJeaHomeAuthority,
  JEA_HOME_MIGRATION_MARKER,
} from '../src/infra/jea-home.mjs';
import {
  migrateJeaHome,
  scanMigrationTree,
} from '../src/infra/jea-home-migration.mjs';

const temps = [];

function makeFixture() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-migrate-source-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-migrate-home-'));
  temps.push(sourceRoot, jeaHome);
  const legacyRoot = join(sourceRoot, 'runtime', 'subjects');
  const subjectRoot = join(legacyRoot, 'alpha-data');
  mkdirSync(join(subjectRoot, 'data', 'evolution', 'tasks'), { recursive: true });
  mkdirSync(join(subjectRoot, 'data', 'channel', 'desktop', 'sessions'), { recursive: true });
  writeJsonFile(join(legacyRoot, 'registry.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        policy: 'SUBJECT.md',
      },
    },
  });
  writeFileSync(join(subjectRoot, 'SUBJECT.md'), '# Alpha\n\n## Subject\nalpha\n');
  writeFileSync(join(subjectRoot, 'SOUL.md'), '# Soul\n');
  writeJsonFile(join(subjectRoot, 'data', 'evolution', 'tasks', 'pending_tasks.json'), {
    schema_version: 1,
    tasks: [],
  });
  writeFileSync(
    join(subjectRoot, 'data', 'channel', 'desktop', 'sessions', 'main.jsonl'),
    '{"id":"message-1","text":"hello"}\n',
  );
  writeFileSync(join(subjectRoot, '.env'), 'JEA_AGENT_PROVIDER=llm_only\n');
  return { sourceRoot, jeaHome, legacyRoot, subjectRoot };
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('JEA Home migration', () => {
  it('keeps a fresh source checkout free of runtime data', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-fresh-source-'));
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-fresh-home-'));
    temps.push(sourceRoot, jeaHome);
    const cli = resolve('src/cli/jea.mjs');
    const env = {
      ...process.env,
      JEA_PROJECT_ROOT: sourceRoot,
      JEA_HOME: jeaHome,
    };
    const subject = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'subject',
      'init',
      'fresh',
      '--use',
    ], { env, encoding: 'utf8' });
    expect(subject.status, subject.stderr).toBe(0);
    const data = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'data',
      'init',
      '--all',
      '--subject',
      'fresh',
    ], { env, encoding: 'utf8' });
    expect(data.status, data.stderr).toBe(0);
    expect(existsSync(join(sourceRoot, 'runtime'))).toBe(false);
    expect(existsSync(join(jeaHome, 'subjects', 'fresh', 'data'))).toBe(true);
  });

  it('copies and verifies the complete Subject tree while preserving legacy data', async () => {
    const fixture = makeFixture();
    const before = scanMigrationTree(fixture.legacyRoot);
    const result = await migrateJeaHome(fixture);
    const target = join(fixture.jeaHome, 'subjects');

    expect(result.status).toBe('migrated');
    expect(result.legacy_preserved).toBe(true);
    expect(existsSync(fixture.legacyRoot)).toBe(true);
    expect(readFileSync(join(target, 'alpha-data', '.env'), 'utf8')).toContain('llm_only');
    expect(readFileSync(
      join(target, 'alpha-data', 'data', 'channel', 'desktop', 'sessions', 'main.jsonl'),
      'utf8',
    )).toContain('message-1');
    expect(scanMigrationTree(target).digest).toBe(before.digest);
    expect(JSON.parse(readFileSync(join(target, JEA_HOME_MIGRATION_MARKER), 'utf8')).status)
      .toBe('completed');
    expect(inspectJeaHomeAuthority(fixture).code).toBe('home_migrated');
  });

  it('supports dry-run without creating target data', async () => {
    const fixture = makeFixture();
    const result = await migrateJeaHome(fixture, { dryRun: true });
    expect(result.status).toBe('ready');
    expect(existsSync(join(fixture.jeaHome, 'subjects'))).toBe(false);
  });

  it('adopts an identical pre-copied target without merging', async () => {
    const fixture = makeFixture();
    const first = await migrateJeaHome(fixture);
    expect(first.status).toBe('migrated');
    rmSync(join(fixture.jeaHome, 'subjects', JEA_HOME_MIGRATION_MARKER));
    const second = await migrateJeaHome(fixture);
    expect(second.status).toBe('already_migrated');
  });

  it('fails closed when target and source differ', async () => {
    const fixture = makeFixture();
    mkdirSync(join(fixture.jeaHome, 'subjects'), { recursive: true });
    writeFileSync(join(fixture.jeaHome, 'subjects', 'registry.json'), '{"subjects":{}}\n');
    await expect(migrateJeaHome(fixture)).rejects.toMatchObject({
      code: 'dual_authority_conflict',
    });
  });

  it('blocks migration while a legacy worker is active', async () => {
    const fixture = makeFixture();
    writeJsonFile(join(
      fixture.subjectRoot,
      'data',
      'evolution',
      'daemon',
      'worker-state.json',
    ), {
      status: 'running',
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000,
    });
    await expect(migrateJeaHome(fixture)).rejects.toMatchObject({
      code: 'migration_writers_active',
    });
  });

  it('aborts activation if the source changes during copy', async () => {
    const fixture = makeFixture();
    await expect(migrateJeaHome(fixture, {
      afterCopy: () => {
        writeFileSync(join(fixture.subjectRoot, 'changed-after-copy.txt'), 'changed\n');
      },
    })).rejects.toMatchObject({ code: 'migration_source_changed' });
    expect(existsSync(join(fixture.jeaHome, 'subjects'))).toBe(false);
  });

  it('exposes migration through the CLI and blocks normal commands beforehand', () => {
    const fixture = makeFixture();
    const cli = resolve('src/cli/jea.mjs');
    const env = {
      ...process.env,
      JEA_PROJECT_ROOT: fixture.sourceRoot,
      JEA_HOME: fixture.jeaHome,
    };
    const blocked = spawnSync(process.execPath, ['--preserve-symlinks', cli, 'subject', 'list'], {
      env,
      encoding: 'utf8',
    });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('migrate-home');

    const migrated = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'data',
      'migrate-home',
      '--yes',
      '--json',
    ], {
      env,
      encoding: 'utf8',
    });
    expect(migrated.status).toBe(0);
    expect(JSON.parse(migrated.stdout).status).toBe('migrated');

    const status = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'data',
      'status',
      '--subject',
      'alpha',
      '--json',
    ], {
      env,
      encoding: 'utf8',
    });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).paths).toMatchObject({
      source_root: fixture.sourceRoot,
      jea_home: fixture.jeaHome,
      subject_runtime_root: join(fixture.jeaHome, 'subjects', 'alpha-data'),
    });
  });
});
