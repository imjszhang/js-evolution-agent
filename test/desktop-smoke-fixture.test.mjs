import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDesktopSmokeFixture,
  removeDesktopSmokeFixture,
  runtimeSubjectsChanged,
  snapshotRuntimeSubjects,
  SMOKE_FIXTURE_SUBJECT,
} from '../scripts/desktop-smoke-fixture.mjs';

const temps = [];

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('desktop smoke fixture', () => {
  it('creates an isolated JEA root without touching a real runtime', () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'jea-real-root-'));
    temps.push(realRoot);
    mkdirSync(join(realRoot, 'runtime', 'subjects'), { recursive: true });
    writeFileSync(join(realRoot, 'runtime', 'subjects', 'keep.json'), 'keep\n');
    const before = snapshotRuntimeSubjects(realRoot);

    const fixture = createDesktopSmokeFixture();
    temps.push(fixture.root);
    expect(fixture.subject).toBe(SMOKE_FIXTURE_SUBJECT);
    const registry = JSON.parse(readFileSync(
      join(fixture.root, 'runtime', 'subjects', 'registry.json'),
      'utf8',
    ));
    expect(registry.subjects[SMOKE_FIXTURE_SUBJECT].channels.desktop.enabled).toBe(true);
    writeFileSync(
      join(fixture.root, 'runtime', 'subjects', SMOKE_FIXTURE_SUBJECT, 'data', 'touched.json'),
      '{"ok":true}\n',
    );

    expect(runtimeSubjectsChanged(before, snapshotRuntimeSubjects(realRoot))).toBe(false);
    removeDesktopSmokeFixture(fixture.root);
  });
});
