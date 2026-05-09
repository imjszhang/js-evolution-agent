#!/usr/bin/env node
/**
 * Remove local runtime data so a new subject / fresh loop starts clean.
 * Does not touch policies/, source, or sibling repos.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const dirs = [
  join(root, 'data', 'evolution'),
  join(root, 'data', 'intelligence'),
  join(root, 'data', 'goals'),
];

let removed = 0;
for (const dir of dirs) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed++;
    console.log('removed:', dir);
  }
}

if (!removed) {
  console.log('Nothing to remove under data/ (already clean or missing).');
} else {
  console.log(`Reset complete (${removed} director${removed === 1 ? 'y' : 'ies'}). Next run will recreate files as needed.`);
}
