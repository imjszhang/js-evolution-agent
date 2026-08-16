import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.json'];

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function candidates(base) {
  const out = [base];
  if (!extname(base)) {
    for (const ext of EXTS) out.push(base + ext);
    for (const ext of EXTS) out.push(join(base, `index${ext}`));
  }
  return out;
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith('node:') || specifier.startsWith('data:')) throw error;
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const absolute = specifier.startsWith('/')
      ? specifier
      : specifier.startsWith('.')
        ? join(dirname(parent), specifier)
        : null;
    if (!absolute) throw error;
    for (const candidate of candidates(absolute)) {
      if (isFile(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw error;
  }
}
