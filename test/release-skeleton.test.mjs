import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyForbiddenPath, scanArtifactTree, scanTextForLeaks } from '../scripts/release-artifact-scan.mjs';
import { evaluateVersions, runVersionPreflight } from '../scripts/release-version-preflight.mjs';
import { evaluateAuditWiring } from '../scripts/release-audit-gate.mjs';
import { evaluatePackageSmoke } from '../scripts/release-package-smoke.mjs';
import { evaluatePublishGuard } from '../scripts/release-publish-guard.mjs';
import { expectedArtifactNames, repoRootFrom } from '../scripts/release-lib.mjs';
import { runReleaseSkeleton } from '../scripts/release-skeleton.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const cleanRoot = join(repoRoot, 'test/fixtures/release/clean');
const missingRoot = join(repoRoot, 'test/fixtures/release/missing-assets');
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
  it('agrees on current root and desktop package versions and pending later slots', () => {
    const report = runVersionPreflight({ repoRoot, strict: false });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('agree_with_pending');
    expect(report.expected).toBe('0.1.0');
    expect(report.pending).toEqual(['bundled_cli', 'client_api', 'about_output']);
    const visible = report.sources.filter((item) => item.required);
    expect(visible.every((item) => item.version === '0.1.0')).toBe(true);
  });

  it('keeps missing later sources pending unless --strict', () => {
    const pending = evaluateVersions([
      { id: 'root_package', required: true, status: 'ok', version: '0.1.0' },
      { id: 'desktop_package', required: true, status: 'ok', version: '0.1.0' },
      { id: 'bundled_cli', required: false, status: 'skipped/pending', issue: 120 },
    ], { strict: false });
    expect(pending.ok).toBe(true);

    const strict = evaluateVersions(pending.sources, { strict: true });
    expect(strict.ok).toBe(false);
    expect(strict.failures.map((item) => item.code)).toContain('pending_required_in_strict');
  });

  it('fails when visible versions disagree', () => {
    const report = evaluateVersions([
      { id: 'root_package', required: true, status: 'ok', version: '0.1.0' },
      { id: 'desktop_package', required: true, status: 'ok', version: '0.2.0' },
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
  });
});

describe('release-package-smoke', () => {
  it('lists expected DMG/ZIP/SHA256SUMS names without requiring #120 artifacts', () => {
    const names = expectedArtifactNames('0.1.0');
    expect(names).toEqual({
      dmg: 'JEA-0.1.0-macos-arm64.dmg',
      zip: 'JEA-0.1.0-macos-arm64.zip',
      checksums: 'SHA256SUMS',
      packageSmoke: 'package-smoke.json',
      releaseNotes: 'RELEASE_NOTES.md',
    });
    const pending = evaluatePackageSmoke({ dir: join(repoRoot, 'dist/release') });
    expect(pending.ok).toBe(true);
    expect(pending.status).toBe('pending');
    expect(pending.issue).toBe(120);
  });

  it('fail-closes a partial artifact directory', () => {
    const dir = tempDir('jea-release-partial-');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.dmg'), 'placeholder');
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(false);
    expect(report.failures.map((item) => item.code)).toContain('incomplete_artifact_set');
  });

  it('accepts a complete placeholder artifact set with checksum names', () => {
    const dir = tempDir('jea-release-complete-');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.dmg'), 'dmg');
    writeFileSync(join(dir, 'JEA-0.1.0-macos-arm64.zip'), 'zip');
    writeFileSync(join(dir, 'SHA256SUMS'), [
      'aaaa  JEA-0.1.0-macos-arm64.dmg',
      'bbbb  JEA-0.1.0-macos-arm64.zip',
    ].join('\n'));
    writeFileSync(join(dir, 'package-smoke.json'), '{"ok":true}\n');
    writeFileSync(join(dir, 'RELEASE_NOTES.md'), 'draft\n');
    const report = evaluatePackageSmoke({ dir });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('smoked');
  });
});

describe('release-publish-guard', () => {
  it('is idle when publish is not requested and fail-closes without evidence', () => {
    expect(evaluatePublishGuard({ publish: false }).status).toBe('not_requested');
    const blocked = evaluatePublishGuard({ publish: true, evidenceDir: join(repoRoot, 'dist/release') });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('certification_evidence_missing');
  });

  it('still blocks incomplete evidence even if the file exists', () => {
    const dir = tempDir('jea-release-evidence-');
    writeFileSync(join(dir, 'certification-evidence.json'), JSON.stringify({
      status: 'pending',
      release: '0.1.0',
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
      'package_smoke_pending',
      'publish_guard_idle',
      'publish_guard_fail_closed',
      'scan_cli_clean',
    ]);
  });
});
