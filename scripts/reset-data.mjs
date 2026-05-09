#!/usr/bin/env node
/**
 * Remove local runtime data so a new subject / fresh loop starts clean.
 * Does not touch policies/, source, or sibling repos.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveSubjectRuntimeInfo } from '../src/cli/utils/subjects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const runtime = getActiveSubjectRuntimeInfo(root);

const dirs = [
  runtime.evolutionDir,
  runtime.intelligenceDir,
  runtime.goalsDir,
];

console.log(`active subject: ${runtime.subject}`);
console.log(`data namespace: ${runtime.dataNamespace}`);
console.log(`runtime root: ${runtime.runtimeRoot}`);

let removed = 0;
for (const dir of dirs) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed++;
    console.log('removed:', dir);
  }
}

if (!removed) {
  console.log('Nothing to remove under active subject runtime data (already clean or missing).');
} else {
  console.log(`Reset complete (${removed} director${removed === 1 ? 'y' : 'ies'}). Next run will recreate files as needed.`);
}
