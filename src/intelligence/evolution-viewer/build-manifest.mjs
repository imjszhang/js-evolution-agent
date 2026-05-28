import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createIntelligenceStore } from '../store.mjs';
import { buildManifest } from './round-catalog.mjs';
import { buildRoundDetail } from './round-detail.mjs';

/**
 * Build evolution viewer dist for a subject runtime.
 * @param {object} options
 * @param {object} options.runtime - from runtimeInfoForSubject
 * @param {import('../store.mjs').IntelligenceStore} options.store
 * @param {string} options.outDir
 * @param {number} [options.limit=50]
 * @param {string} [options.publicDir] - copy static assets from here
 */
export function buildEvolutionViewerDist({
  runtime,
  store,
  outDir,
  limit = 50,
  publicDir = null,
}) {
  if (!runtime?.runtimeRoot) throw new Error('runtime.runtimeRoot is required');

  const catalog = buildManifest({ runtime, store, limit });
  const { _diariesByIntel, ...manifest } = catalog;

  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  if (publicDir && existsSync(publicDir)) {
    cpSync(publicDir, outDir, { recursive: true });
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  mkdirSync(join(outDir, 'rounds'), { recursive: true });

  for (const round of manifest.rounds) {
    const roundDetail = buildRoundDetail({
      runtime,
      store,
      cycleId: round.cycle_id,
      diariesByIntel: _diariesByIntel,
    });
    if (!roundDetail) continue;
    writeFileSync(
      join(outDir, 'rounds', `${round.cycle_id}.json`),
      JSON.stringify(roundDetail),
      'utf-8',
    );
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  return manifest;
}

/**
 * @param {object} options
 * @param {string} options.baseDir - intelligence store baseDir
 * @param {object} options.runtime
 * @param {string} options.outDir
 * @param {number} [options.limit]
 * @param {string} [options.publicDir]
 */
export function buildEvolutionViewerFromRuntime({
  baseDir,
  runtime,
  outDir,
  limit = 50,
  publicDir = null,
}) {
  const store = createIntelligenceStore({
    baseDir,
    timezone: 'Asia/Shanghai',
  });
  return buildEvolutionViewerDist({ runtime, store, outDir, limit, publicDir });
}
