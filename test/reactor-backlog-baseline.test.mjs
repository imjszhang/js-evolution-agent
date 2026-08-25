import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA_VERSION,
  CURRENT_COGNITIVE_BATCH_LIMIT,
  estimatedAuthorityCount,
  FIXTURE_PROFILES,
  recipeForProfile,
  runReactorBacklogBaseline,
} from '../scripts/reactor-baseline/index.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const realHome = resolve(homedir(), '.jea');

function expectIsolation(report) {
  expect(report.isolation.isolated).toBe(true);
  expect(report.isolation.read_real_jea_home).toBe(false);
  expect(report.isolation.wrote_real_jea_home).toBe(false);
  expect(report.isolation.network).toBe(false);
  expect(report.isolation.llm).toBe('none');
  const home = resolve(report.isolation.jea_home);
  expect(home).not.toBe(realHome);
  expect(home.startsWith(`${realHome}/`)).toBe(false);
  expect(home.startsWith(resolve(tmpdir()))).toBe(true);
}

describe('reactor backlog baseline fixture profiles', () => {
  it('keeps Cognitive/Rule/Memory recipe counts large enough for tens of thousands at --size large', () => {
    expect(estimatedAuthorityCount(recipeForProfile('tiny'))).toBeGreaterThan(150);
    expect(estimatedAuthorityCount(recipeForProfile('smoke'))).toBeGreaterThan(2000);
    expect(estimatedAuthorityCount(recipeForProfile('large'))).toBeGreaterThan(20_000);
    expect(Object.keys(FIXTURE_PROFILES)).toEqual(['tiny', 'smoke', 'large', 'incident']);
  });
});

describe('reactor backlog baseline measurement', () => {
  it('reproduces an isolated historical backlog and emits the v1 attribution schema', async () => {
    const report = await runReactorBacklogBaseline({ profile: 'tiny', rebuild: true });
    expect(report.schema_version).toBe(BASELINE_SCHEMA_VERSION);
    expect(report.issue).toBe(209);
    expectIsolation(report);
    expect(report.authority.evidence_count).toBeGreaterThan(150);
    expect(report.authority.evidence_count).toBe(
      Object.values(report.authority.disk_counts).reduce((sum, value) => sum + value, 0),
    );
    expect(report.claimable.non_additive).toBe(true);
    expect(report.claimable.additive_sum).toBe(
      report.claimable.cognitive + report.claimable.rule + report.claimable.memory,
    );
    expect(report.claimable.union).toBeLessThanOrEqual(report.claimable.additive_sum);
    expect(report.claimable.pairwise_overlap).toMatchObject({
      cognitive_rule: expect.any(Number),
      cognitive_memory: expect.any(Number),
      rule_memory: expect.any(Number),
      all_three: expect.any(Number),
    });
    expect(report.authority.evidence_count).not.toBe(report.claimable.cognitive);

    for (const key of ['handled_covered', 'realtime_candidate', 'replay_candidate', 'unknown_legacy']) {
      expect(report.populations.exclusive).toHaveProperty(key);
      expect(report.populations.exclusive[key]).toBeGreaterThanOrEqual(0);
    }
    expect(report.populations.exclusive.unknown_legacy).toBeGreaterThan(0);
    expect(report.populations.exclusive.replay_candidate).toBeGreaterThan(0);
    expect(report.populations.exclusive.realtime_candidate).toBeGreaterThan(0);

    expect(report.projection.cold.scanned_records).toBe(report.authority.evidence_count);
    expect(report.projection.cold).toHaveProperty('hydrated_records');
    expect(report.projection.warm).toHaveProperty('health_snapshot_ms');
    expect(report.projection.warm.cache_hit).toBe(true);

    expect(report.amplification.batch_limit).toBe(CURRENT_COGNITIVE_BATCH_LIMIT);
    expect(report.amplification.raw_records).toBe(report.claimable.cognitive);
    expect(report.amplification.reaction_batches).toBe(
      Math.ceil(report.claimable.cognitive / CURRENT_COGNITIVE_BATCH_LIMIT),
    );
    expect(report.amplification).toMatchObject({
      llm_calls: expect.any(Number),
      estimated_prompt_tokens: expect.any(Number),
      decision_producing_reactions: expect.any(Number),
    });

    expect(report.rebuild.performed).toBe(true);
    expect(['preserved', 'lost', 'partial']).toContain(report.rebuild.handled_coverage);
    expect(report.rebuild.cursor_after.cognitive.offset).toBe(0);
    expect(report.rebuild.generation_after).toBeTruthy();
    expect(report.rebuild.generation_after).not.toBe(report.rebuild.generation_before);
    expect(report.rebuild).toHaveProperty('marker_backed_preserved');
    expect(report.rebuild).toHaveProperty('covered_index_only_lost');
  }, 60_000);

  it('overrides a pre-existing JEA_HOME instead of reading the real home', async () => {
    const previous = process.env.JEA_HOME;
    process.env.JEA_HOME = realHome;
    try {
      const report = await runReactorBacklogBaseline({ profile: 'tiny', rebuild: false });
      expect(report.fixture.subject).toBe('baseline-reactor');
      expectIsolation(report);
      expect(report.isolation.jea_home).not.toBe(realHome);
    } finally {
      if (previous == null) delete process.env.JEA_HOME;
      else process.env.JEA_HOME = previous;
    }
  }, 30_000);
});

describe('reactor backlog baseline CLI', () => {
  it('prints JSON from the script entry without using the real home', () => {
    const output = execFileSync(process.execPath, [
      '--preserve-symlinks',
      join(repoRoot, 'scripts', 'reactor-backlog-baseline.mjs'),
      '--size',
      'tiny',
      '--json',
    ], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: {
        ...process.env,
        JEA_HOME: join(realHome, 'should-be-overridden'),
      },
    });
    const report = JSON.parse(output);
    expect(report.schema_version).toBe(BASELINE_SCHEMA_VERSION);
    expectIsolation(report);
    expect(report.rebuild.performed).toBe(true);
  }, 60_000);
});
