import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyForbiddenPath, scanArtifactTree, scanTextForLeaks } from '../scripts/release-artifact-scan.mjs';
import { evaluateVersions, runVersionPreflight } from '../scripts/release-version-preflight.mjs';
import { evaluateAuditWiring } from '../scripts/release-audit-gate.mjs';
import { evaluatePackageSmoke } from '../scripts/release-package-smoke.mjs';
import { evaluatePublishGuard } from '../scripts/release-publish-guard.mjs';
import { evaluateAttachAssets, evaluateSourceRun } from '../scripts/release-attach-assets.mjs';
import { expectedArtifactNames, releaseAttachAssetNames, RELEASE_VERSION, repoRootFrom } from '../scripts/release-lib.mjs';
import { CONTROL_PLANE_TARGET_ID } from '../src/intelligence/control-plane-target.mjs';
import { runReleaseSkeleton } from '../scripts/release-skeleton.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const cleanRoot = join(repoRoot, 'test/fixtures/release/clean');
const missingRoot = join(repoRoot, 'test/fixtures/release/missing-assets');
const temps = [];
const RELEASE_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeAttachEvidence(dir, {
  commit = RELEASE_COMMIT,
  dirty = false,
  packageStatus = 'packaged',
  certificationStatus = 'certified',
} = {}) {
  const buildId = `${RELEASE_VERSION}+${commit.slice(0, 7)}.20260822T000000`;
  const generatedAt = new Date().toISOString();
  writeFileSync(join(dir, 'build-metadata.json'), `${JSON.stringify({
    schema_version: 1,
    product: 'jea',
    version: RELEASE_VERSION,
    commit,
    dirty,
    built_at: '2026-08-22T00:00:00.000Z',
    platform: 'darwin',
    arch: 'arm64',
    build_id: buildId,
  })}\n`);
  writeFileSync(join(dir, 'package-smoke.json'), `${JSON.stringify({
    ok: true,
    status: packageStatus,
    commit,
    dirty,
    build_id: buildId,
    generated_at: generatedAt,
  })}\n`);
  writeFileSync(join(dir, 'SHA256SUMS'), [
    `${sha256(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`))}  JEA-${RELEASE_VERSION}-macos-arm64.dmg`,
    `${sha256(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.zip`))}  JEA-${RELEASE_VERSION}-macos-arm64.zip`,
  ].join('\n') + '\n');
  const identity = {
    build_id: buildId,
    commit,
    dirty,
    generated_at: generatedAt,
  };
  writeFileSync(join(dir, 'recovery-matrix.json'), `${JSON.stringify({
    ok: true,
    status: 'passed',
    mode: 'packaged',
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'product-journey.json'), `${JSON.stringify({
    ok: true,
    status: 'journey_passed',
    runner: 'packaged',
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'launch-smoke.json'), `${JSON.stringify({
    ok: true,
    status: 'passed',
    launched_app: true,
    duration_ms: 15_000,
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'soak-report.json'), `${JSON.stringify({
    ok: true,
    status: 'passed',
    launched_app: true,
    duration_ms: 1_800_000,
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'closure-audit.json'), `${JSON.stringify({
    ok: true,
    status: 'passed',
    gate: { target_id: '0.2.0-belief-loop' },
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'control-plane-audit.json'), `${JSON.stringify({
    ok: true,
    status: 'passed',
    gate: { target_id: CONTROL_PLANE_TARGET_ID },
    ...identity,
  })}\n`);
  writeFileSync(join(dir, 'certification-evidence.json'), `${JSON.stringify({
    status: certificationStatus,
    release: RELEASE_VERSION,
    platform: 'macos-arm64',
    issue77: 'ok',
    ...identity,
    steps: [
      { id: 'product_journey', ok: true, status: 'passed', ...identity },
      { id: 'packaged_launch_smoke', ok: true, status: 'passed', duration_ms: 15_000, ...identity },
      { id: 'recovery_matrix', ok: true, status: 'passed', ...identity },
      { id: 'soak', ok: true, status: 'passed', duration_ms: 1_800_000, ...identity },
      {
        id: 'closure_audit',
        ok: true,
        status: 'passed',
        detail: '0.2.0-belief-loop',
        ...identity,
      },
      {
        id: 'control_plane_audit',
        ok: true,
        status: 'passed',
        detail: CONTROL_PLANE_TARGET_ID,
        ...identity,
      },
    ],
    recovery_matrix: { id: 'recovery_matrix', ok: true, status: 'passed', ...identity },
    soak: { id: 'soak', ok: true, status: 'passed', duration_ms: 1_800_000, ...identity },
    closure_audit: {
      id: 'closure_audit',
      ok: true,
      status: 'passed',
      detail: '0.2.0-belief-loop',
      ...identity,
    },
    control_plane_audit: {
      id: 'control_plane_audit',
      ok: true,
      status: 'passed',
      detail: CONTROL_PLANE_TARGET_ID,
      ...identity,
    },
  })}\n`);
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('release-artifact-scan', () => {
  it('accepts the committed clean fixture and required asset names', () => {
    const report = scanArtifactTree({ root: cleanRoot });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('clean');
    expect(report.manifest.status).toBe('present');
    expect(report.missingAssets).toEqual([]);
    expect(report.files).toEqual(expect.arrayContaining([
      'release-manifest.json',
      'resources/host/package.json',
      'resources/web/index.html',
      'resources/cli/jea',
      'resources/policies/authority/CONSTITUTION.md',
      'resources/policies/authority/GUIDE.md',
    ]));
  });

  it('rejects a manifest whose required runtime/web/cli/policy assets are missing', () => {
    const report = scanArtifactTree({ root: missingRoot });
    expect(report.ok).toBe(false);
    expect(report.missingAssets.map((item) => item.group).sort()).toEqual([
      'cli',
      'policy',
      'runtime',
      'web',
    ]);
  });

  it('rejects secrets, user runtime, git/agent state, tests, and developer paths', () => {
    const root = tempDir('jea-release-dirty-');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.agent-field'), { recursive: true });
    mkdirSync(join(root, 'runtime/subjects/demo'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY=not-a-real-key\n');
    writeFileSync(join(root, 'credentials.json'), '{"token":"x"}\n');
    writeFileSync(join(root, '.git/config'), '[core]\n');
    writeFileSync(join(root, '.agent-field/state.json'), '{}\n');
    writeFileSync(join(root, 'runtime/subjects/demo/standing_memory.json'), '{}\n');
    writeFileSync(join(root, 'src/example.test.mjs'), 'export const n = 1;\n');
    writeFileSync(join(root, 'leak.txt'), 'built on /Users/developer/github/js-evolution-agent\n');

    const report = scanArtifactTree({ root });
    expect(report.ok).toBe(false);
    const codes = report.violations.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      'secret_file',
      'secret_content',
      'credentials',
      'git_or_agent_state',
      'user_runtime',
      'tests',
      'developer_absolute_path',
    ]));
  });

  it('classifies well-known forbidden names without scanning a tree', () => {
    expect(classifyForbiddenPath('.env.local').code).toBe('secret_file');
    expect(classifyForbiddenPath('id_ed25519').code).toBe('credentials');
    expect(classifyForbiddenPath('pending_decisions.json').code).toBe('user_runtime');
    expect(classifyForbiddenPath('src/foo.spec.ts').code).toBe('tests');
    expect(scanTextForLeaks('C:\\Users\\js\\project')).toEqual([
      expect.objectContaining({ code: 'developer_absolute_path' }),
    ]);
  });
});

describe('release-version-preflight', () => {
  it('agrees on every package, lockfile, resource, and runtime version surface', () => {
    const report = runVersionPreflight({ repoRoot, strict: false });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('agree');
    expect(report.expected).toBe('0.3.0');
    expect(report.pending).toEqual([]);
    const visible = report.sources.filter((item) => item.required);
    expect(visible.map((item) => item.id)).toEqual([
      'root_package',
      'desktop_package',
      'jea_app_package',
      'host_package',
      'lockfile_root',
      'lockfile_root_package',
      'lockfile_desktop_package',
      'lockfile_jea_app_package',
      'bundled_cli',
      'resource_cli',
      'client_api',
      'about_output',
      'client_api_fallback',
      'electron_builder',
      'release_lib',
      'product_identity',
      'acp_runtime',
    ]);
    expect(visible.every((item) => item.version === '0.3.0')).toBe(true);
    expect(runVersionPreflight({ repoRoot, strict: true }).ok).toBe(true);
  });

  it('keeps missing later sources pending unless --strict', () => {
    const pending = evaluateVersions([
      { id: 'root_package', required: true, status: 'ok', version: '0.3.0' },
      { id: 'desktop_package', required: true, status: 'ok', version: '0.3.0' },
      { id: 'bundled_cli', required: false, status: 'skipped/pending', issue: 120 },
    ], { strict: false });
    expect(pending.ok).toBe(true);

    const strict = evaluateVersions(pending.sources, { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.failures.map((item) => item.code)).toContain('pending_required_in_strict');
  });

  it('fails when visible versions disagree', () => {
    const report = evaluateVersions([
      { id: 'root_package', required: true, status: 'ok', version: '0.3.0' },
      { id: 'desktop_package', required: true, status: 'ok', version: '0.4.0' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures.map((item) => item.code)).toEqual(expect.arrayContaining([
      'version_mismatch',
      'version_disagree',
    ]));
  });
});

describe('release-audit-gate', () => {
  it('requires audit:ci, ci-audit.mjs, baseline #77, and release workflow wiring', () => {
    const report = evaluateAuditWiring({ repoRoot });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('wired');
    expect(report.issue).toContain('issues/77');
    expect(report.checks.every((item) => item.ok)).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'frozen_closure_target',
      ok: true,
    }));
  });

  it('propagates an invalid frozen closure target as a release gate failure', () => {
    const root = tempDir('jea-invalid-closure-target-');
    const targetDir = join(root, 'policies', 'release');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'closure-target-0.2.0.json'), '{}\n');

    const report = evaluateAuditWiring({ repoRoot: root });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'frozen_closure_target',
      ok: false,
    }));
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'closure_target_changed',
    }));
  });

  it('re-evaluates closure audit evidence and propagates missing metrics', () => {
    const dir = tempDir('jea-invalid-closure-audit-');
    const auditPath = join(dir, 'closure-audit.json');
    writeFileSync(auditPath, `${JSON.stringify({
      schema_version: 'closure-audit.v1',
      ok: true,
      status: 'passed',
      metrics: {},
      diagnostics: [],
    })}\n`);

    const report = evaluateAuditWiring({
      repoRoot,
      closureAuditPath: auditPath,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'closure_audit_result',
      ok: false,
    }));
    expect(report.failures).toContainEqual(expect.objectContaining({
      code: 'closure_audit_failed',
    }));
  });
});

describe('release-package-smoke', () => {
  it('lists expected DMG/ZIP/SHA256SUMS names and accepts local pending or smoked artifacts', () => {
    const names = expectedArtifactNames(RELEASE_VERSION);
    expect(names).toEqual({
      dmg: `JEA-${RELEASE_VERSION}-macos-arm64.dmg`,
      zip: `JEA-${RELEASE_VERSION}-macos-arm64.zip`,
      checksums: 'SHA256SUMS',
      packageSmoke: 'package-smoke.json',
      releaseNotes: 'RELEASE_NOTES.md',
      buildMetadata: 'build-metadata.json',
    });
    const local = evaluatePackageSmoke({ dir: join(repoRoot, 'test/fixtures/release/no-artifacts') });
    expect(local.ok).toBe(true);
    expect(['pending', 'smoked']).toContain(local.status);
    expect(local.issue).toBe(122);
  });

  it('fail-closes a partial artifact directory', () => {
    const dir = tempDir('jea-release-partial-');
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`), 'placeholder');
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(false);
    expect(report.failures.map((item) => item.code)).toContain('incomplete_artifact_set');
  });

  it('accepts a complete artifact set with exact SHA256 digests', () => {
    const dir = tempDir('jea-release-complete-');
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`), 'dmg');
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.zip`), 'zip');
    writeFileSync(join(dir, 'SHA256SUMS'), [
      `${createHash('sha256').update('dmg').digest('hex')}  JEA-${RELEASE_VERSION}-macos-arm64.dmg`,
      `${createHash('sha256').update('zip').digest('hex')}  JEA-${RELEASE_VERSION}-macos-arm64.zip`,
    ].join('\n'));
    writeFileSync(join(dir, 'package-smoke.json'), '{"ok":true,"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n');
    writeFileSync(join(dir, 'build-metadata.json'), JSON.stringify({
      schema_version: 1,
      product: 'jea',
      version: RELEASE_VERSION,
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      dirty: false,
      built_at: '2026-08-17T00:00:00.000Z',
      platform: 'darwin',
      arch: 'arm64',
    }));
    writeFileSync(join(dir, 'RELEASE_NOTES.md'), 'draft\n');
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('smoked');
  });

  it('rejects a tampered installer whose digest no longer matches SHA256SUMS', () => {
    const dir = tempDir('jea-release-tampered-');
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`), 'original');
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.zip`), 'zip');
    writeFileSync(join(dir, 'SHA256SUMS'), [
      `${createHash('sha256').update('original').digest('hex')}  JEA-${RELEASE_VERSION}-macos-arm64.dmg`,
      `${createHash('sha256').update('zip').digest('hex')}  JEA-${RELEASE_VERSION}-macos-arm64.zip`,
    ].join('\n'));
    writeFileSync(join(dir, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`), 'tampered');
    writeFileSync(join(dir, 'build-metadata.json'), JSON.stringify({
      version: RELEASE_VERSION,
      commit: RELEASE_COMMIT,
      dirty: false,
      built_at: new Date().toISOString(),
      platform: 'darwin',
      arch: 'arm64',
    }));
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(false);
    expect(report.failures.map((item) => item.code)).toContain('checksum_mismatch');
  });
});

describe('release-attach-assets', () => {
  it('lists the official 0.3.0 upload allowlist', () => {
    expect(releaseAttachAssetNames(RELEASE_VERSION)).toEqual([
      `JEA-${RELEASE_VERSION}-macos-arm64.dmg`,
      `JEA-${RELEASE_VERSION}-macos-arm64.zip`,
      'SHA256SUMS',
      'package-smoke.json',
      'RELEASE_NOTES.md',
      'build-metadata.json',
      'recovery-matrix.json',
      'product-journey.json',
      'launch-smoke.json',
      'soak-report.json',
      'closure-audit.json',
      'control-plane-audit.json',
      'certification-evidence.json',
    ]);
  });

  it('accepts a complete allowlisted directory and ignores extras', () => {
    const dir = tempDir('jea-attach-complete-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) {
      writeFileSync(join(dir, name), `${name}\n`);
    }
    writeAttachEvidence(dir);
    writeFileSync(join(dir, 'README.txt'), 'ignored extra\n');
    const report = evaluateAttachAssets({
      dir,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('ready');
    expect(report.files.map((file) => file.name)).toEqual(releaseAttachAssetNames(RELEASE_VERSION));
  });

  it('rejects tampered checksums, missing journey/launch evidence, and build mismatch', () => {
    const tampered = tempDir('jea-attach-tampered-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(tampered, name), `${name}\n`);
    writeAttachEvidence(tampered);
    writeFileSync(join(tampered, `JEA-${RELEASE_VERSION}-macos-arm64.dmg`), 'tampered after checksumming');
    expect(evaluateAttachAssets({
      dir: tampered,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).rejected.map((item) => item.reason)).toContain('checksum_mismatch');

    const missingJourney = tempDir('jea-attach-missing-journey-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(missingJourney, name), `${name}\n`);
    writeAttachEvidence(missingJourney);
    rmSync(join(missingJourney, 'product-journey.json'));
    expect(evaluateAttachAssets({
      dir: missingJourney,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).missing).toContain('product-journey.json');

    const missingLaunch = tempDir('jea-attach-missing-launch-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(missingLaunch, name), `${name}\n`);
    writeAttachEvidence(missingLaunch);
    rmSync(join(missingLaunch, 'launch-smoke.json'));
    expect(evaluateAttachAssets({
      dir: missingLaunch,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).missing).toContain('launch-smoke.json');

    const mismatch = tempDir('jea-attach-build-mismatch-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(mismatch, name), `${name}\n`);
    writeAttachEvidence(mismatch);
    const launch = JSON.parse(readFileSync(join(mismatch, 'launch-smoke.json'), 'utf8'));
    writeFileSync(join(mismatch, 'launch-smoke.json'), JSON.stringify({
      ...launch,
      build_id: `${RELEASE_VERSION}+bbbbbbb.20260822T000000`,
    }));
    expect(evaluateAttachAssets({
      dir: mismatch,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).rejected.map((item) => item.reason)).toContain('build_mismatch');
  });

  it('fail-closes a missing installer, a bad tag, or a secret file', () => {
    const dir = tempDir('jea-attach-bad-');
    writeFileSync(join(dir, 'SHA256SUMS'), 'checksums\n');
    expect(evaluateAttachAssets({ dir, tag: `v${RELEASE_VERSION}` }).reason).toBe('incomplete_artifact_set');
    expect(evaluateAttachAssets({ dir, tag: 'v0.4.0' }).reason).toBe('tag_version_mismatch');
    writeFileSync(join(dir, '.env'), 'DEEPSEEK_API_KEY=secret\n');
    const rejected = evaluateAttachAssets({ dir, tag: `v${RELEASE_VERSION}` });
    expect(rejected.ok).toBe(false);
    expect(rejected.rejected.map((item) => item.reason)).toContain('forbidden_file');
  });

  it('verifies source workflow, success conclusion, and exact tag SHA', () => {
    const valid = {
      path: '.github/workflows/release-macos.yml',
      conclusion: 'success',
      head_sha: RELEASE_COMMIT,
    };
    expect(evaluateSourceRun({ run: valid, targetSha: RELEASE_COMMIT }).ok).toBe(true);
    expect(evaluateSourceRun({
      run: { ...valid, path: '.github/workflows/test.yml' },
      targetSha: RELEASE_COMMIT,
    }).reason).toBe('source_workflow_mismatch');
    expect(evaluateSourceRun({
      run: { ...valid, conclusion: 'failure' },
      targetSha: RELEASE_COMMIT,
    }).reason).toBe('source_run_not_successful');
    expect(evaluateSourceRun({
      run: valid,
      targetSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }).reason).toBe('source_run_tag_sha_mismatch');
  });

  it('fail-closes dirty, mismatched, or uncertified downloaded provenance', () => {
    const dirtyDir = tempDir('jea-attach-dirty-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(dirtyDir, name), '{}\n');
    writeAttachEvidence(dirtyDir, { dirty: true });
    expect(evaluateAttachAssets({
      dir: dirtyDir,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).rejected.map((item) => item.reason)).toContain('dirty_source_tree');

    const pendingDir = tempDir('jea-attach-pending-');
    for (const name of releaseAttachAssetNames(RELEASE_VERSION)) writeFileSync(join(pendingDir, name), '{}\n');
    writeAttachEvidence(pendingDir, { certificationStatus: 'pending' });
    expect(evaluateAttachAssets({
      dir: pendingDir,
      tag: `v${RELEASE_VERSION}`,
      expectedCommit: RELEASE_COMMIT,
    }).rejected.map((item) => item.reason)).toContain('certification_not_complete');
  });

  it('keeps soak before final evidence and makes overwrite explicit in workflows', () => {
    const macos = readFileSync(join(repoRoot, '.github/workflows/release-macos.yml'), 'utf8');
    const attach = readFileSync(join(repoRoot, '.github/workflows/release-attach-assets.yml'), 'utf8');
    expect(macos.indexOf('30-minute packaged soak (release-only)'))
      .toBeLessThan(macos.indexOf('Write certification evidence from artifacts'));
    expect(macos.indexOf('Isolated product journey (packaged CLI)'))
      .toBeLessThan(macos.indexOf('Write certification evidence from artifacts'));
    expect(macos.indexOf('Packaged launch smoke (not the 30-minute soak)'))
      .toBeLessThan(macos.indexOf('Write certification evidence from artifacts'));
    expect(macos).toContain('dist/release/soak-report.json');
    expect(macos).toContain('JEA_CONTRACT_MODE: strict');
    expect(attach).toContain('JEA_CONTRACT_MODE: strict');
    expect(attach).toContain('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID"');
    expect(attach).toContain('.github/workflows/release-macos.yml');
    expect(attach).toContain('SOURCE_CONCLUSION');
    expect(attach).toContain('SOURCE_HEAD_SHA');
    expect(attach).toContain('Run publish guard before attachment');
    expect(attach).toContain('replace_existing_assets');
    expect(attach).toContain('"macos-release-${TAG#v}"');
    expect(attach).not.toContain('gh release upload "$TAG" "${FILES[@]}" --clobber');
  });
});

describe('release-publish-guard', () => {
  it('is idle when publish is not requested and fail-closes without evidence', () => {
    expect(evaluatePublishGuard({ publish: false }).status).toBe('not_requested');
    const blocked = evaluatePublishGuard({
      publish: true,
      evidenceDir: join(repoRoot, 'test/fixtures/release/no-artifacts'),
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('certification_evidence_missing');
  });

  it('still blocks incomplete evidence even if the file exists', () => {
    const dir = tempDir('jea-release-evidence-');
    writeFileSync(join(dir, 'certification-evidence.json'), JSON.stringify({
      status: 'pending',
      release: RELEASE_VERSION,
    }));
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('certification_not_complete');
  });
});

describe('release-skeleton orchestrator', () => {
  it('passes the committed Wave 1 fixture path', () => {
    const report = runReleaseSkeleton({ repoRoot });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('skeleton_ready');
    expect(report.publish).toBe(false);
    expect(report.steps.map((item) => item.id)).toEqual([
      'scan_clean_fixture',
      'scan_missing_assets_fixture',
      'version_preflight',
      'audit_gate_wired',
      'package_smoke',
      'publish_guard_idle',
      'publish_guard_fail_closed',
      'scan_cli_clean',
    ]);
  });
});
