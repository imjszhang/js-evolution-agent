import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { getProjectRoot } from '../utils/project.mjs';
import { confirm } from '../utils/prompt.mjs';
import { countFiles, latestFile, removeProjectDir } from '../utils/files.mjs';

function printDirStatus(root, relativeDir) {
  const full = join(root, relativeDir);
  const latest = latestFile(full);
  console.log(`${relativeDir}:`);
  console.log(`  exists: ${existsSync(full)}`);
  console.log(`  files: ${countFiles(full)}`);
  console.log(`  latest: ${latest ? relative(root, latest.path) : 'none'}`);
}

export async function dataCommand({ subcommand, flags = {} } = {}) {
  const root = getProjectRoot();
  if (subcommand === 'status') {
    printDirStatus(root, join('data', 'evolution'));
    printDirStatus(root, join('data', 'intelligence'));
    printDirStatus(root, join('data', 'goals'));
    return 0;
  }

  if (subcommand === 'reset') {
    const targets = [
      join('data', 'evolution'),
      join('data', 'intelligence'),
      join('data', 'goals'),
    ];
    console.log('Will remove local runtime data:');
    for (const target of targets) console.log(`  - ${join(root, target)}`);
    if (!flags.yes) {
      const ok = await confirm('This cannot be undone.');
      if (!ok) {
        console.log('Cancelled.');
        return 1;
      }
    }
    let removed = 0;
    for (const target of targets) {
      if (removeProjectDir(root, target)) {
        removed++;
        console.log(`removed: ${join(root, target)}`);
      }
    }
    console.log(`Reset complete. Removed ${removed} director${removed === 1 ? 'y' : 'ies'}.`);
    return 0;
  }

  console.error('Usage: jea data <status|reset> [--yes]');
  return 2;
}

