import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import { CLOSURE_TARGET_PATH, readFrozenClosureTarget } from '../src/intelligence/closure-target.mjs';
import {
  CONTROL_PLANE_TARGET_ID,
  CONTROL_PLANE_TARGET_PATH,
  FROZEN_CLOSURE_TARGET_SHA256,
  evaluateControlPlaneTarget,
  hashFrozenClosureTargetFile,
  readControlPlaneTarget,
  validateControlPlaneTarget,
} from '../src/intelligence/control-plane-target.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));

describe('0.3.0 control-plane target', () => {
  it('keeps the frozen 0.2.0 closure target byte-for-byte unchanged', () => {
    const path = join(repoRoot, CLOSURE_TARGET_PATH);
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    expect(digest).toBe(FROZEN_CLOSURE_TARGET_SHA256);
    expect(hashFrozenClosureTargetFile(repoRoot)).toMatchObject({
      ok: true,
      sha256: FROZEN_CLOSURE_TARGET_SHA256,
      reason: 'closure_target_unchanged',
    });
    expect(readFrozenClosureTarget(repoRoot).ok).toBe(true);
  });

  it('loads and validates the committed 0.3.0 control-plane target', () => {
    const loaded = readControlPlaneTarget(repoRoot);
    expect(loaded.ok).toBe(true);
    expect(loaded.target_id).toBe(CONTROL_PLANE_TARGET_ID);
    expect(loaded.path).toBe(join(repoRoot, CONTROL_PLANE_TARGET_PATH));
    expect(validateControlPlaneTarget(loaded.target).ok).toBe(true);
    expect(loaded.target.frozen_closure_target).toEqual({
      path: CLOSURE_TARGET_PATH,
      target_id: '0.2.0-belief-loop',
      sha256: FROZEN_CLOSURE_TARGET_SHA256,
    });
    expect(loaded.target.isolation).toEqual({
      temp_jea_home: true,
      forbid_real_home: true,
      forbid_repo_runtime: true,
      llm: 'mock',
    });
    expect(loaded.target.contract_version).toBe('0.3.0');
  });

  it('rejects a rewritten frozen hash or missing required checks', () => {
    const loaded = readControlPlaneTarget(repoRoot);
    const invalid = validateControlPlaneTarget({
      ...loaded.target,
      frozen_closure_target: {
        ...loaded.target.frozen_closure_target,
        sha256: '0'.repeat(64),
      },
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.failures.map((item) => item.id)).toContain('frozen_closure_sha256');

    const evaluated = evaluateControlPlaneTarget({
      isolation: loaded.target.isolation,
      checks: [],
    }, loaded.target);
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.some((item) => item.reason === 'required_check_missing')).toBe(true);
  });
});
