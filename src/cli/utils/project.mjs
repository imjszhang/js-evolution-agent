import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getProjectRoot() {
  return resolve(__dirname, '..', '..', '..');
}

export function loadProjectEnv(root = getProjectRoot()) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: false });
  return envPath;
}

export function projectPath(...parts) {
  return join(getProjectRoot(), ...parts);
}

/** Default Cyber-Taoist docs shipped inside the npm `js-evolution-engine` package. */
export function getDefaultCyberTaoistDocsDir() {
  const entry = require.resolve('js-evolution-engine');
  let dir = dirname(entry);
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const { name } = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (name === 'js-evolution-engine') {
          return join(dir, 'examples', 'cyber-taoist-demo', 'cyber-taoist-docs');
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve js-evolution-engine package root from ${entry}`);
}

