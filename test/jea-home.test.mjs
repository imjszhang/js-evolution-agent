import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeContext,
  inspectJeaHomeAuthority,
  JEA_HOME_MIGRATION_MARKER,
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
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

const temps = [];

function temp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temps.push(path);
  return path;
}

function runRegistryWriter(moduleUrl, env) {
  const script = `
    import { updateSubjectsRegistry } from ${JSON.stringify(moduleUrl)};
    const context = { sourceRoot: process.env.SOURCE_ROOT, jeaHome: process.env.JEA_HOME };
    const id = process.env.WRITER_ID;
    updateSubjectsRegistry(context, (registry) => ({
      default_subject: registry.default_subject,
      subjects: { ...registry.subjects, [id]: { data_namespace: id } },
    }));
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr || `registry writer exited ${code}`));
    });
  });
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('JEA Home resolver', () => {
  it('does not infer legacy runtime from a positional source root', () => {
    const sourceRoot = temp('jea-source-');
    const previousSwitch = globalThis.__JEA_TEST_LEGACY_ROOT_ARGUMENT__;
    const previousHome = process.env.JEA_HOME;
    globalThis.__JEA_TEST_LEGACY_ROOT_ARGUMENT__ = false;
    delete process.env.JEA_HOME;
    try {
      const context = createRuntimeContext(sourceRoot);
      expect(context.jeaHome).not.toBe(join(sourceRoot, 'runtime'));
      expect(context.jeaHomeSource).toBe('default');
    } finally {
      globalThis.__JEA_TEST_LEGACY_ROOT_ARGUMENT__ = previousSwitch;
      if (previousHome == null) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previousHome;
    }
  });

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

  it('serializes concurrent registry read-modify-write updates', async () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-shared-home-');
    const context = createRuntimeContext({ sourceRoot, jeaHome });
    writeSubjectsRegistry(context, {
      default_subject: 'seed',
      subjects: { seed: { data_namespace: 'seed' } },
    });
    const moduleUrl = pathToFileURL(resolve('src/infra/subjects.mjs')).href;
    await Promise.all(Array.from({ length: 8 }, (_, index) => runRegistryWriter(moduleUrl, {
      ...process.env,
      SOURCE_ROOT: sourceRoot,
      JEA_HOME: jeaHome,
      WRITER_ID: `writer-${index}`,
    })));
    const registry = readSubjectsRegistry(context);
    for (let index = 0; index < 8; index += 1) {
      expect(registry.subjects[`writer-${index}`]).toMatchObject({
        data_namespace: `writer-${index}`,
      });
    }
  });

  it('keeps disk ownership stable when a subject key changes', () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-home-');
    const context = createRuntimeContext({ sourceRoot, jeaHome });
    writeSubjectsRegistry(context, {
      default_subject: 'alpha',
      subjects: { alpha: { data_namespace: 'stable-data' } },
    });
    const before = runtimeForSubject(context, 'alpha').runtimeRoot;
    writeSubjectsRegistry(context, {
      default_subject: 'renamed',
      subjects: { renamed: { data_namespace: 'stable-data' } },
    });
    expect(runtimeForSubject(context, 'renamed').runtimeRoot).toBe(before);
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

  it('rejects an incomplete forged migration marker', () => {
    const sourceRoot = temp('jea-source-');
    const jeaHome = temp('jea-home-');
    mkdirSync(join(sourceRoot, 'runtime', 'subjects'), { recursive: true });
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
    writeFileSync(join(sourceRoot, 'runtime', 'subjects', 'registry.json'), '{"subjects":{}}\n');
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), '{"subjects":{"other":{}}}\n');
    writeFileSync(
      join(jeaHome, 'subjects', JEA_HOME_MIGRATION_MARKER),
      JSON.stringify({
        schema_version: 1,
        status: 'completed',
        source_subjects_root: join(sourceRoot, 'runtime', 'subjects'),
        target_subjects_root: join(jeaHome, 'subjects'),
      }),
    );
    const state = inspectJeaHomeAuthority({ sourceRoot, jeaHome });
    expect(state.code).toBe('dual_authority_conflict');
    expect(state.ok).toBe(false);
  });
});
