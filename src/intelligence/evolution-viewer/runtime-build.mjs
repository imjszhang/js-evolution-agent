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
