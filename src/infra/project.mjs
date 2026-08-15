import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { invalidateLinkHealthCache } from './links/index.mjs';

const projectModuleDir = dirname(fileURLToPath(import.meta.url));

export function getProjectRoot() {
  const fromEnv = process.env.JEA_PROJECT_ROOT;
  if (fromEnv) return resolve(fromEnv);
  return resolve(projectModuleDir, '..', '..');
}

export function loadProjectEnv(root = getProjectRoot()) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    // Project .env is the local source of truth; shell placeholders must not win over it.
    loadDotenv({ path: envPath, override: true, quiet: true });
  }
  invalidateLinkHealthCache(root);
  return envPath;
}

export function projectPath(...parts) {
  return join(getProjectRoot(), ...parts);
}

/** Project-local Cyber-Taoist authority docs (CONSTITUTION.md, GUIDE.md). */
export function getProjectAuthorityDocsDir(root = getProjectRoot()) {
  return join(root, 'policies', 'authority');
}

/**
 * Resolve authority docs directory: CYBER_TAOIST_DOCS_DIR override, else policies/authority/.
 * @deprecated Use resolveAuthorityDocsDir — kept for callers that only need the default path name.
 */
export function getDefaultCyberTaoistDocsDir(root = getProjectRoot()) {
  return getProjectAuthorityDocsDir(root);
}

/** CYBER_TAOIST_DOCS_DIR override, else project policies/authority/. */
export function resolveAuthorityDocsDir(root = getProjectRoot()) {
  if (process.env.CYBER_TAOIST_DOCS_DIR) {
    return resolve(process.env.CYBER_TAOIST_DOCS_DIR);
  }
  return getProjectAuthorityDocsDir(root);
}

