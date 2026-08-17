import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleanProvenance,
  collectBuildMetadata,
  commitsMatch,
  loadBuildMetadata,
  writeBuildMetadata,
} from '../src/product/build-metadata.mjs';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import { stageAppResources } from '../scripts/stage-app-resources.mjs';
import { evaluatePackageSmoke } from '../scripts/release-package-smoke.mjs';
import { evaluatePublishGuard } from '../scripts/release-publish-guard.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const temps = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('build metadata provenance', () => {
  it('collects version, full SHA, timestamp, platform, arch, and dirty', () => {
    const metadata = collectBuildMetadata({
      repoRoot,
      now: () => '2026-08-17T04:32:54.000Z',
      platform: 'linux',
      arch: 'x64',
    });
    expect(metadata).toMatchObject({
      schema_version: 1,
      product: 'jea',
      version: '0.1.0',
      dirty: expect.any(Boolean),
      built_at: '2026-08-17T04:32:54.000Z',
      platform: 'linux',
      arch: 'x64',
    });
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.commit_short).toBe(metadata.commit.slice(0, 7));
    expect(metadata.build_id).toContain(metadata.commit_short);
  });

  it('writes and loads immutable metadata from the packaged tree', () => {
    const dir = tempDir('jea-build-meta-');
    const written = writeBuildMetadata(dir, {
      version: '0.1.0',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirty: false,
      built_at: '2026-08-17T04:32:54.000Z',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(existsSync(written.path)).toBe(true);
    const loaded = loadBuildMetadata({ sourceRoot: dir, collect: false });
    expect(loaded.commit).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(loaded.dirty).toBe(false);
    expect(loaded.platform).toBe('darwin');
    expect(loaded.arch).toBe('arm64');
  });

  it('rejects dirty provenance and missing commit unless allowDirty', () => {
    const dirty = assertCleanProvenance({
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirty: true,
    });
    expect(dirty).toMatchObject({ ok: false, status: 'dirty_provenance', reason: 'dirty_source_tree' });
    expect(assertCleanProvenance(dirty.metadata, { allowDirty: true }).ok).toBe(true);

    const missing = assertCleanProvenance({ dirty: false });
    expect(missing).toMatchObject({ ok: false, status: 'missing_commit', reason: 'commit_sha_missing' });
  });

  it('matches abbreviated and full commit SHAs for package smoke', () => {
    const full = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(commitsMatch(full, full)).toBe(true);
    expect(commitsMatch(full, 'aaaaaaa')).toBe(true);
    expect(commitsMatch('bbbbbbb', full)).toBe(false);
    expect(commitsMatch('', full)).toBe(false);
  });

  it('embeds collected metadata when staging app resources', () => {
    const outDir = tempDir('jea-stage-meta-');
    const metadata = {
      version: '0.1.0',
      commit: 'cccccccccccccccccccccccccccccccccccccccc',
      dirty: false,
      built_at: '2026-08-17T04:32:54.000Z',
      platform: 'linux',
      arch: 'x64',
    };
    const report = stageAppResources({
      repoRoot,
      outDir,
      withNodeModules: false,
      metadata,
    });
    expect(report.ok).toBe(true);
    const embedded = JSON.parse(readFileSync(join(outDir, 'resources/host/build-metadata.json'), 'utf8'));
    const productCopy = JSON.parse(readFileSync(join(outDir, 'jea/src/product/build-metadata.json'), 'utf8'));
    expect(embedded.commit).toBe(metadata.commit);
    expect(productCopy.commit).toBe(metadata.commit);
    expect(embedded.dirty).toBe(false);
  });
});

describe('package smoke commit certification', () => {
  it('fail-closes when installers exist without an embedded commit SHA', () => {
    const dir = tempDir('jea-smoke-missing-sha-');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.dmg'), 'dmg');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.zip'), 'zip');
    writeFileSync(join(dir, 'SHA256SUMS'), [
      'aaaa  JEA-0.1.0-macos-arm64.dmg',
      'bbbb  JEA-0.1.0-macos-arm64.zip',
    ].join('\n'));
    writeFileSync(join(dir, 'package-smoke.json'), '{"ok":true}\n');
    writeFileSync(join(dir, 'RELEASE_NOTES.md'), 'draft\n');
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(false);
    expect(report.failures.map((item) => item.code)).toContain('missing_build_metadata');
  });

  it('proves the embedded commit SHA matches the commit being certified', () => {
    const dir = tempDir('jea-smoke-match-');
    const commit = 'dddddddddddddddddddddddddddddddddddddddd';
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.dmg'), 'dmg');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.zip'), 'zip');
    writeFileSync(join(dir, 'SHA256SUMS'), [
      'aaaa  JEA-0.1.0-macos-arm64.dmg',
      'bbbb  JEA-0.1.0-macos-arm64.zip',
    ].join('\n'));
    writeFileSync(join(dir, 'package-smoke.json'), JSON.stringify({ ok: true, commit }));
    writeFileSync(join(dir, 'build-metadata.json'), JSON.stringify({
      schema_version: 1,
      product: 'jea',
      version: '0.1.0',
      commit,
      dirty: false,
      built_at: '2026-08-17T04:32:54.000Z',
      platform: 'darwin',
      arch: 'arm64',
    }));
    writeFileSync(join(dir, 'RELEASE_NOTES.md'), 'draft\n');
    const matched = evaluatePackageSmoke({ dir, expectedCommit: commit });
    expect(matched.ok).toBe(true);
    expect(matched.commit).toBe(commit);

    const mismatch = evaluatePackageSmoke({
      dir,
      expectedCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.failures.map((item) => item.code)).toContain('commit_mismatch');
  });
});

describe('release publish dirty provenance', () => {
  it('blocks certified evidence when the source tree is dirty', () => {
    const dir = tempDir('jea-publish-dirty-');
    writeFileSync(join(dir, 'certification-evidence.json'), JSON.stringify({
      status: 'certified',
      release: '0.1.0',
      platform: 'macos-arm64',
      issue77: 'ok',
      dirty: true,
    }));
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('dirty_source_tree');
  });

  it('blocks certified evidence when sidecar build-metadata.json is dirty', () => {
    const dir = tempDir('jea-publish-meta-dirty-');
    writeFileSync(join(dir, 'certification-evidence.json'), JSON.stringify({
      status: 'certified',
      release: '0.1.0',
      platform: 'macos-arm64',
      issue77: 'ok',
    }));
    writeFileSync(join(dir, 'build-metadata.json'), JSON.stringify({
      version: '0.1.0',
      commit: 'ffffffffffffffffffffffffffffffffffffffff',
      dirty: true,
    }));
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('dirty_source_tree');
  });
});
