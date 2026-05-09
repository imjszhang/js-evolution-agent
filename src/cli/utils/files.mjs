import {
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function readTextSafe(filePath, fallback = '') {
  try {
    if (!existsSync(filePath)) return fallback;
    return readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

export function ensureProjectDir(root, relativeDir) {
  const full = resolve(root, relativeDir);
  const normalizedRoot = resolve(root);
  if (!full.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to create outside project root: ${full}`);
  }
  const existed = existsSync(full);
  mkdirSync(full, { recursive: true });
  return { path: full, created: !existed };
}

export function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(`${filePath}.tmp`, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(`${filePath}.tmp`, filePath);
}

export function writeJsonIfMissing(root, relativeFile, data, { force = false } = {}) {
  const full = resolve(root, relativeFile);
  const normalizedRoot = resolve(root);
  if (!full.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to write outside project root: ${full}`);
  }
  const existed = existsSync(full);
  if (existed && !force) {
    return { path: full, written: false, skipped: true, existed: true };
  }
  writeJsonFile(full, data);
  return { path: full, written: true, skipped: false, existed };
}

export function countFiles(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let count = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) count += countFiles(full);
    else count++;
  }
  return count;
}

export function latestFile(dirPath) {
  if (!existsSync(dirPath)) return null;
  let latest = null;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const child = latestFile(full);
      if (child && (!latest || child.mtimeMs > latest.mtimeMs)) latest = child;
      continue;
    }
    const stat = statSync(full);
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = { path: full, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
    }
  }
  return latest;
}

export function removeProjectDir(root, relativeDir) {
  const full = resolve(root, relativeDir);
  const normalizedRoot = resolve(root);
  if (!full.startsWith(normalizedRoot)) {
    throw new Error(`Refusing to remove outside project root: ${full}`);
  }
  if (!existsSync(full)) return false;
  rmSync(full, { recursive: true, force: true });
  return true;
}

