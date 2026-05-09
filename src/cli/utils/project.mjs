import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

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

