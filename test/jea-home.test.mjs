import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeContext,
  inspectJeaHomeAuthority,
  resolveJeaHome,
  subjectsHomeDir,
} from '../src/infra/jea-home.mjs';
import {
  getSubjectRuntimeRoot,
  readSubjectsRegistry,
  subjectsRegistryFile,
  subjectsRuntimeDir,
  writeSubjectsRegistry,
} from '../src/infra/subjects.mjs';

const temps = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temps.push(path);
  return path;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('JEA Home resolver', () => {
  it('uses a device-level hidden directory by default', () => {
    const sourceRoot = temp('jea-source-');
    const fakeHome = temp('jea-user-home-');
    const result = resolveJeaHome({ env: {}, sourceRoot, homedir: fakeHome });
    expect(result.path).toBe(join(fakeHome, '.jea'));
    expect(result.source).toBe('default');
  });

  it('resolves a relative override from source root, not cwd', () => {
    const sourceRoot = temp('jea-source-');
    const result = resolveJeaHome({
      env: { JEA_HOME: '../shared-jea-home' },
      sourceRoot,
      homedir: temp('jea-user-home-'),
    });
    expect(result.path).toBe(resolve(sourceRoot, '../shared-jea-home'));
    expect(result.source).toBe('env');
  });

  it('recognizes explicit legacy compatibility mode', () => {
    const sourceRoot = temp('jea-source-');
    const result = resolveJeaHome({
      env: { JEA_HOME: join(sourceRoot, 'runtime') },
      sourceRoot,
    });
    expect(result.source).toBe('legacy_compat');
    expect(subjectsHomeDir(createRuntimeContext({
      sourceRoot,
      jeaHome: result.path,
    }))).toBe(join(sourceRoot, 'runtime', 'subjects'));
  });

  it('resolves registry and namespace paths from JEA Home', () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-home-');
    const context = createRuntimeContext({ sourceRoot, jeaHome });
    expect(subjectsRuntimeDir(context)).toBe(join(jeaHome, 'subjects'));
    expect(subjectsRegistryFile(context)).toBe(join(jeaHome, 'subjects', 'registry.json'));
    expect(getSubjectRuntimeRoot(context, {
      name: 'alpha',
      data_namespace: 'alpha-data',
    })).toBe(join(jeaHome, 'subjects', 'alpha-data'));
  });

  it('shares one registry across independent checkouts', () => {
    const firstSource = temp('jea-source-a-');
    const secondSource = temp('jea-source-b-');
    const jeaHome = temp('jea-shared-home-');
    const first = createRuntimeContext({ sourceRoot: firstSource, jeaHome });
    const second = createRuntimeContext({ sourceRoot: secondSource, jeaHome });
    writeSubjectsRegistry(first, {
      default_subject: 'alpha',
      subjects: { alpha: { data_namespace: 'alpha-data' } },
    });
    expect(readSubjectsRegistry(second).default_subject).toBe('alpha');
    expect(subjectsRegistryFile(first)).toBe(subjectsRegistryFile(second));
  });
});

describe('JEA Home authority', () => {
  it('requires migration when only legacy Subject data exists', () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-home-');
    mkdirSync(join(sourceRoot, 'runtime', 'subjects'), { recursive: true });
    writeFileSync(join(sourceRoot, 'runtime', 'subjects', 'registry.json'), '{}\n');
    const state = inspectJeaHomeAuthority({ sourceRoot, jeaHome });
    expect(state.code).toBe('migration_required');
    expect(state.ok).toBe(false);
  });

  it('fails closed when legacy and home data coexist without a marker', () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-home-');
    mkdirSync(join(sourceRoot, 'runtime', 'subjects'), { recursive: true });
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
    writeFileSync(join(sourceRoot, 'runtime', 'subjects', 'registry.json'), '{}\n');
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), '{}\n');
    const state = inspectJeaHomeAuthority({ sourceRoot, jeaHome });
    expect(state.code).toBe('dual_authority_conflict');
    expect(state.ok).toBe(false);
  });
});
