import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  invalidateJeaLinksCache,
  isLinkRef,
  parseLinkRef,
  preflightAll,
  repolinkConfigExists,
  resolveMachinePath,
  summarizeDoctorLinkChecks,
  warmJeaLinksCache,
  getCachedLinkHealthSummary,
  invalidateLinkHealthCache,
} from '../src/infra/links/index.mjs';
import {
  diagnoseSubjectRuntimeConfig,
  resolveHostExternalRoots,
  resolveSubjectRepoLane,
} from '../src/infra/subjects.mjs';

describe('repo links facade', () => {
  let tempRoot;
  const projectRoot = join(import.meta.dirname, '..');
  const repolinkImport = pathToFileURL(join(projectRoot, 'node_modules', 'js-repolink', 'src', 'index.mjs')).href;

  function writeTempLinkConfig(root, linkId, envVar) {
    writeFileSync(join(root, 'repolink.config.mjs'), `import { defineLinks } from '${repolinkImport}';
export const links = defineLinks({
  ${linkId}: {
    envVar: '${envVar}',
    runtime: 'node',
    entry: 'cli.mjs',
  },
});
`, 'utf-8');
  }

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    invalidateJeaLinksCache();
  });

  it('detects link refs', () => {
    expect(isLinkRef('link:agentank-evolver')).toBe(true);
    expect(parseLinkRef('link:agentank-evolver')).toBe('agentank-evolver');
    expect(isLinkRef('D:/github/foo')).toBe(false);
  });

  it('loads repolink config from project root', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-repolink-'));
    const demoRepo = join(tempRoot, 'demo');
    mkdirSync(demoRepo, { recursive: true });
    writeTempLinkConfig(tempRoot, 'demo', 'DEMO_REPO_PATH');
    writeFileSync(join(tempRoot, '.env'), `DEMO_REPO_PATH=${demoRepo.replace(/\\/g, '/')}\n`, 'utf-8');
    writeFileSync(join(demoRepo, 'cli.mjs'), 'console.log("ok");\n', 'utf-8');

    expect(repolinkConfigExists(tempRoot)).toBe(true);
    const links = await warmJeaLinksCache(tempRoot);
    expect(Object.keys(links)).toEqual(['demo']);
    expect(resolveMachinePath('link:demo', tempRoot)).toBe(demoRepo);
  });

  it('summarizes doctor output with unconfigured as warn-only', () => {
    const summary = summarizeDoctorLinkChecks([
      {
        id: 'demo',
        ok: false,
        directory: { ok: false, code: 'path-unconfigured', message: 'DEMO_REPO_PATH is not configured' },
        probe: null,
        version: null,
      },
    ]);
    expect(summary.ok).toBe(true);
    expect(summary.lines[0].warn).toBe(true);
  });

  it('resolveHostExternalRoots warms link cache and resolves target_repo', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-repolink-host-roots-'));
    const repoPath = join(tempRoot, 'target-repo');
    mkdirSync(repoPath, { recursive: true });
    writeTempLinkConfig(tempRoot, 'target', 'TARGET_REPO_PATH');
    writeFileSync(join(tempRoot, '.env'), `TARGET_REPO_PATH=${repoPath.replace(/\\/g, '/')}\n`, 'utf-8');
    writeFileSync(join(repoPath, 'cli.mjs'), 'console.log("ok");\n', 'utf-8');

    const { externalRoots, subjectRepoLane } = await resolveHostExternalRoots({
      root: tempRoot,
      config: {
        name: 'demo-subject',
        lane: { repo: 'link:target', base_branch: 'main', lane_branch: 'jea/demo/local' },
      },
    });
    expect(subjectRepoLane.repoRoot).toBe(repoPath);
    expect(externalRoots.target_repo).toBe(repoPath);
  });

  it('resolves link refs in subject repo lane config', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-repolink-lane-'));
    const repoPath = join(tempRoot, 'target-repo');
    mkdirSync(repoPath, { recursive: true });
    writeTempLinkConfig(tempRoot, 'target', 'TARGET_REPO_PATH');
    writeFileSync(join(tempRoot, '.env'), `TARGET_REPO_PATH=${repoPath.replace(/\\/g, '/')}\n`, 'utf-8');
    writeFileSync(join(repoPath, 'cli.mjs'), 'console.log("ok");\n', 'utf-8');
    await warmJeaLinksCache(tempRoot);

    const lane = resolveSubjectRepoLane('', {
      root: tempRoot,
      subject: 'demo-subject',
      config: {
        lane: { repo: 'link:target', base_branch: 'main', lane_branch: 'jea/demo/local' },
      },
    });
    expect(lane.repo).toBe('link:target');
    expect(lane.repoRoot).toBe(repoPath);
    expect(lane.repoRef?.link_id).toBe('target');
  });

  it('runs preflight against real agentank-evolver when configured', async () => {
    const root = join(import.meta.dirname, '..');
    if (!process.env.AGENTANK_EVOLVER_PATH) return;
    await warmJeaLinksCache(root, { force: true });
    const reports = await preflightAll(root, { probe: true });
    const agentank = reports.find((report) => report.id === 'agentank-evolver');
    expect(agentank).toBeTruthy();
    expect(agentank.directory.ok).toBe(true);
  });

  it('invalidates cached link health summary after env reload', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-repolink-health-'));
    const demoRepo = join(tempRoot, 'demo');
    mkdirSync(demoRepo, { recursive: true });
    writeTempLinkConfig(tempRoot, 'demo', 'DEMO_REPO_PATH');
    writeFileSync(join(tempRoot, '.env'), `DEMO_REPO_PATH=${demoRepo.replace(/\\/g, '/')}\n`, 'utf-8');
    writeFileSync(join(demoRepo, 'cli.mjs'), 'console.log("ok");\n', 'utf-8');
    await warmJeaLinksCache(tempRoot);
    const first = getCachedLinkHealthSummary(tempRoot);
    expect(first.stale).toBe(true);
    expect(first.links[0]?.status).toBe('ok');
    invalidateLinkHealthCache(tempRoot);
    writeFileSync(join(tempRoot, '.env'), '', 'utf-8');
    const second = getCachedLinkHealthSummary(tempRoot);
    expect(second.links[0]?.status).toBe('unconfigured');
  });

  it('diagnoses unresolved link refs in lane and resource items', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-repolink-unresolved-'));
    writeTempLinkConfig(tempRoot, 'demo', 'DEMO_REPO_PATH');
    await warmJeaLinksCache(tempRoot);

    const result = diagnoseSubjectRuntimeConfig('', {
      root: tempRoot,
      subject: 'demo-subject',
      config: {
        lane: { repo: 'link:demo', base_branch: 'main', lane_branch: 'jea/demo/local' },
        resources: {
          items: {
            target_repo: {
              kind: 'repo',
              handle: 'link:demo',
              note: 'Linked target repo.',
              fallback: 'Inspect manually.',
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'lane.repo_link_unresolved',
      'resources.link_unresolved',
    ]));
  });
});
