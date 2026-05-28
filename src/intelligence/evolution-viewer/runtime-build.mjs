import { join } from 'node:path';
import { buildEvolutionViewerFromRuntime } from './build-manifest.mjs';

export const DEFAULT_VIEWER_LIMIT = 50;

export function evolutionViewerOutDir(root) {
  return join(root, 'tools', 'evolution-viewer', 'dist');
}

export function evolutionViewerPublicDir(root) {
  return join(root, 'tools', 'evolution-viewer', 'public');
}

export function parseViewerBuildLimit(env = process.env, fallback = DEFAULT_VIEWER_LIMIT) {
  const raw = env.JEA_VIEWER_BUILD_LIMIT;
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.trunc(n);
}

export function autoViewerBuildEnabled(env = process.env) {
  const value = env.JEA_AUTO_VIEWER_BUILD;
  if (!value) return false;
  return value === '1' || String(value).toLowerCase() === 'true';
}

export function buildEvolutionViewerForRuntime(root, runtime, options = {}) {
  const baseDir = join(runtime.runtimeRoot, 'data', 'intelligence');
  const limit = options.limit ?? parseViewerBuildLimit(process.env, DEFAULT_VIEWER_LIMIT);
  const outDir = options.outDir ?? evolutionViewerOutDir(root);
  const publicDir = options.publicDir ?? evolutionViewerPublicDir(root);
  return buildEvolutionViewerFromRuntime({
    baseDir,
    runtime,
    outDir,
    limit,
    publicDir,
  });
}

export async function autoBuildEvolutionViewerIfEnabled({
  root,
  runtime,
  env = process.env,
  logger = console,
} = {}) {
  if (!autoViewerBuildEnabled(env)) {
    return { enabled: false, skipped: true };
  }

  try {
    const limit = parseViewerBuildLimit(env);
    const outDir = evolutionViewerOutDir(root);
    const manifest = buildEvolutionViewerForRuntime(root, runtime, { limit, outDir });
    logger.log('\n=== Phase 6: evolution viewer build ===');
    logger.log(`  dist: ${outDir}`);
    logger.log(`  rounds: ${manifest.round_count}`);
    logger.log(`  limit: ${manifest.limit}`);
    return { enabled: true, skipped: false, ok: true, manifest, outDir };
  } catch (err) {
    const msg = err?.message || String(err);
    logger.warn(`  evolution viewer build failed (non-fatal): ${msg}`);
    return { enabled: true, skipped: false, ok: false, error: msg };
  }
}
