import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import {
  renderControlPlaneAuditText,
  runControlPlaneAudit,
} from '../src/intelligence/control-plane-audit.mjs';
import { CONTROL_PLANE_TARGET_ID } from '../src/intelligence/control-plane-target.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));

describe('0.3.0 control-plane audit', () => {
  it('runs the isolated mechanical suite without a second tiny baseline', async () => {
    const previousHome = process.env.JEA_HOME;
    const report = await runControlPlaneAudit({
      sourceRoot: repoRoot,
      includeBaseline: false,
      includeClosureRun: true,
      subject: 'control-plane-cert',
    });
    try {
      expect(report.ok, renderControlPlaneAuditText(report)).toBe(true);
      expect(report.status).toBe('passed');
      expect(report.gate.target_id).toBe(CONTROL_PLANE_TARGET_ID);
      expect(report.isolation.temp_jea_home).toBe(true);
      expect(report.isolation.forbid_real_home).toBe(true);
      expect(report.isolation.forbid_repo_runtime).toBe(true);
      expect(report.isolation.llm).toBe('mock');
      expect(report.isolation.wrote_repo_runtime).not.toBe(true);
      expect(report.isolation.jea_home).not.toBe(join(repoRoot, 'runtime'));
      expect(report.isolation.jea_home).not.toBe(join(homedir(), '.jea'));
      expect(report.checks.find((item) => item.id === 'frozen_closure_still_passes')?.ok).toBe(true);
      expect(report.checks.find((item) => item.id === 'rebuild_rollback')).toMatchObject({
        ok: true,
        handled_coverage: 'preserved',
        covered_index_only_lost: 0,
        authority_mutated: false,
      });
      expect(report.checks.find((item) => item.id === 'scheduler_reclaim_lease_expired_not_handled')?.ok).toBe(true);
      expect(report.checks.find((item) => item.id === 'product_mapping_heartbeat_plus_large_replay_ready')?.intents)
        .toEqual(expect.arrayContaining(['listening', 'queued']));
      expect(report.checks.some((item) => item.id === 'tiny_baseline_handled_coverage')).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previousHome;
    }
  }, 240_000);

  it('keeps jea.client protocol at 1.0.0 while product wiring is 0.3.0', () => {
    expect(PRODUCT_VERSION).toBe('0.3.0');
    const client = JSON.parse(
      readFileSync(join(repoRoot, 'apps/desktop/src/client-api/version.json'), 'utf8'),
    );
    expect(client.protocolVersion).toBe('1.0.0');
    expect(client.protocol).toBe('jea.client');
  });

  it('writes JSON evidence via --out so npm banners cannot poison the file', () => {
    const source = readFileSync(join(repoRoot, 'scripts/control-plane-audit.mjs'), 'utf8');
    expect(source).toContain('[--out PATH]');
    expect(source).toContain('if (args.out)');
    expect(source).toContain('writeFileSync(outPath');
  });

  it('exposes jea audit control-plane without inspecting the operator home', () => {
    const help = spawnSync(
      process.execPath,
      ['--preserve-symlinks', 'src/cli/jea.mjs', 'help'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(help.status, help.stderr || help.stdout).toBe(0);
    expect(help.stdout).toContain('audit control-plane');
    expect(help.stdout).toContain('--skip-baseline');
    expect(help.stdout).toContain('temp JEA_HOME');
    const source = readFileSync(join(repoRoot, 'src/cli/jea.mjs'), 'utf8');
    expect(source).toContain("subcommand === 'control-plane'");
  });
});
