#!/usr/bin/env node
/**
 * Secret-free repo checks for CI and local clean trees.
 *
 * Uses an isolated subject `ci-repo` so operator default subjects and
 * unresolved lane links are never part of the gate.
 *
 * Usage: node scripts/ci-repo-checks.mjs
 *        npm run check
 */
import { main } from '../src/cli/jea.mjs';

const SUBJECT = 'ci-repo';

const STEPS = [
  ['subject', 'init', SUBJECT],
  ['policy', 'check', '--subject', SUBJECT],
  ['subject', 'check', '--subject', SUBJECT],
  ['actions', 'check', '--subject', SUBJECT],
];

async function run() {
  for (const argv of STEPS) {
    console.log(`$ jea ${argv.join(' ')}`);
    const code = await main(argv);
    if (code) process.exit(code);
  }
}

await run();
