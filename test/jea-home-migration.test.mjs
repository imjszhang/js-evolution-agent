import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('aborts activation if the source changes during copy', async () => {
    const fixture = makeFixture();
    await expect(migrateJeaHome(fixture, {
      afterCopy: () => {
        writeFileSync(join(fixture.subjectRoot, 'changed-after-copy.txt'), 'changed\n');
      },
    })).rejects.toMatchObject({ code: 'migration_source_changed' });
    expect(existsSync(join(fixture.jeaHome, 'subjects'))).toBe(false);
  });
});
