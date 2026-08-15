import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  mkdirSync(join(subjectRoot, 'data', 'evolution', 'cycle-state', 'cycle-1'), { recursive: true });
  mkdirSync(join(subjectRoot, 'data', 'evolution', 'records', 'cycle-1'), { recursive: true });
  mkdirSync(join(subjectRoot, 'data', 'channel', 'desktop', 'sessions'), { recursive: true });
  mkdirSync(join(subjectRoot, 'data', 'channel', 'outbox', 'pending'), { recursive: true });
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
  writeJsonFile(join(subjectRoot, 'data', 'evolution', 'pending_decisions.json'), {
    schema_version: 2,
    decisions: [{ id: 'approval-1', status: 'blocked', requires_approval: true }],
  });
  writeJsonFile(join(subjectRoot, 'data', 'evolution', 'cycle-state', 'cycle-1', 'intel.json'), {
    cycle_id: 'cycle-1',
    ok: true,
  });
  writeFileSync(
    join(subjectRoot, 'data', 'evolution', 'records', 'cycle-1', 'conversation.jsonl'),
    '{"role":"operator","content":"preserve me"}\n',
  );
  writeJsonFile(join(subjectRoot, 'data', 'channel', 'feishu-operator-binding.json'), {
    open_id: 'ou_fixture',
  });
  writeJsonFile(join(subjectRoot, 'data', 'channel', 'outbox', 'pending', 'message-1.json'), {
    id: 'message-1',
    text: 'pending delivery',
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

  it('uses the same default home from different checkouts and working directories', () => {
    const firstSource = mkdtempSync(join(tmpdir(), 'jea-checkout-a-'));
    const secondSource = mkdtempSync(join(tmpdir(), 'jea-checkout-b-'));
    const userHome = mkdtempSync(join(tmpdir(), 'jea-device-home-'));
    temps.push(firstSource, secondSource, userHome);
    const cli = resolve('src/cli/jea.mjs');
    const baseEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
    };
    delete baseEnv.JEA_HOME;
    const created = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'subject',
      'init',
      'shared',
      '--use',
    ], {
      cwd: firstSource,
      env: { ...baseEnv, JEA_PROJECT_ROOT: firstSource },
      encoding: 'utf8',
    });
    expect(created.status, created.stderr).toBe(0);

    const listed = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'subject',
      'list',
      '--json',
    ], {
      cwd: secondSource,
      env: { ...baseEnv, JEA_PROJECT_ROOT: secondSource },
      encoding: 'utf8',
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).subjects).toContainEqual({
      name: 'shared',
      default: true,
    });
    expect(existsSync(join(userHome, '.jea', 'subjects', 'registry.json'))).toBe(true);
    expect(existsSync(join(firstSource, 'runtime'))).toBe(false);
    expect(existsSync(join(secondSource, 'runtime'))).toBe(false);
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
    expect(JSON.parse(readFileSync(
      join(target, 'alpha-data', 'data', 'evolution', 'pending_decisions.json'),
      'utf8',
    )).decisions[0]).toMatchObject({ id: 'approval-1', requires_approval: true });
    expect(JSON.parse(readFileSync(
      join(target, 'alpha-data', 'data', 'evolution', 'cycle-state', 'cycle-1', 'intel.json'),
      'utf8',
    )).cycle_id).toBe('cycle-1');
    expect(JSON.parse(readFileSync(
      join(target, 'alpha-data', 'data', 'channel', 'feishu-operator-binding.json'),
      'utf8',
    )).open_id).toBe('ou_fixture');
    expect(JSON.parse(readFileSync(
      join(target, 'alpha-data', 'data', 'channel', 'outbox', 'pending', 'message-1.json'),
      'utf8',
    )).text).toBe('pending delivery');
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

  it.skipIf(process.platform === 'win32')('preserves file and directory permissions', async () => {
    const fixture = makeFixture();
    chmodSync(fixture.legacyRoot, 0o700);
    chmodSync(fixture.subjectRoot, 0o700);
    chmodSync(join(fixture.subjectRoot, '.env'), 0o600);
    await migrateJeaHome(fixture);
    expect(statSync(join(fixture.jeaHome, 'subjects')).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.jeaHome, 'subjects', 'alpha-data')).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.jeaHome, 'subjects', 'alpha-data', '.env')).mode & 0o777).toBe(0o600);
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

  it('blocks other runtime entrypoints while migration locks are held', async () => {
    const fixture = makeFixture();
    let authorityCode = null;
    await migrateJeaHome(fixture, {
      afterCopy: () => {
        authorityCode = inspectJeaHomeAuthority(fixture).code;
      },
    });
    expect(authorityCode).toBe('migration_in_progress');
  });

  it('never deletes target data that appears during migration', async () => {
    const fixture = makeFixture();
    const target = join(fixture.jeaHome, 'subjects');
    await expect(migrateJeaHome(fixture, {
      afterCopy: () => {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'concurrent-writer.txt'), 'preserve\n');
      },
    })).rejects.toMatchObject({ code: 'migration_target_changed' });
    expect(readFileSync(join(target, 'concurrent-writer.txt'), 'utf8')).toBe('preserve\n');
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

    const doctor = spawnSync(process.execPath, [
      '--preserve-symlinks',
      cli,
      'doctor',
    ], {
      env: { ...env, JEA_ACP_DOCTOR_HANDSHAKE: '0' },
      encoding: 'utf8',
    });
    expect(doctor.stdout).toContain(`Subject runtime root: ${join(fixture.jeaHome, 'subjects', 'alpha-data')}`);
    expect(doctor.stdout).toContain('Execution root: not configured');
  });
});
