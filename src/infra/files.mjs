import {
  existsSync,
  cpSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function resolveWithinRoot(root, target) {
  const normalizedRoot = resolve(root);
  const full = isAbsolute(target) ? resolve(target) : resolve(normalizedRoot, target);
  const rel = relative(normalizedRoot, full);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to access outside project root: ${full}`);
  }
  return full;
}

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
  const full = resolveWithinRoot(root, relativeDir);
  const existed = existsSync(full);
  mkdirSync(full, { recursive: true });
  return { path: full, created: !existed };
}

export function writeJsonFile(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeJsonIfMissing(root, relativeFile, data, { force = false } = {}) {
  const full = resolveWithinRoot(root, relativeFile);
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
  const full = resolveWithinRoot(root, relativeDir);
  if (!existsSync(full)) return false;
  rmSync(full, { recursive: true, force: true });
  return true;
}

export function copyProjectDir(root, relativeSource, relativeDestination, { force = false } = {}) {
  const source = resolveWithinRoot(root, relativeSource);
  const destination = resolveWithinRoot(root, relativeDestination);
  if (!existsSync(source)) {
    return { source, destination, copied: false, reason: 'source_missing' };
  }
  if (existsSync(destination) && !force) {
    return { source, destination, copied: false, reason: 'destination_exists' };
  }
  cpSync(source, destination, { recursive: true, force });
  return { source, destination, copied: true };
}

export function copyDirBetweenRoots(sourceRoot, sourcePath, destinationRoot, destinationPath, {
  force = false,
} = {}) {
  const source = resolveWithinRoot(sourceRoot, sourcePath);
  const destination = resolveWithinRoot(destinationRoot, destinationPath);
  if (!existsSync(source)) {
    return { source, destination, copied: false, reason: 'source_missing' };
  }
  if (existsSync(destination) && !force) {
    return { source, destination, copied: false, reason: 'destination_exists' };
  }
  cpSync(source, destination, { recursive: true, force, errorOnExist: !force });
  return { source, destination, copied: true };
}

