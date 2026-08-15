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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SUBJECT = 'ci-repo';

const STEPS = [
  ['subject', 'init', SUBJECT],
  ['policy', 'check', '--subject', SUBJECT],
  ['subject', 'check', '--subject', SUBJECT],
  ['actions', 'check', '--subject', SUBJECT],
];

async function run() {
  const previousHome = process.env.JEA_HOME;
  const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-ci-home-'));
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-ci-source-'));
  process.env.JEA_HOME = jeaHome;
  process.env.JEA_PROJECT_ROOT = sourceRoot;
  try {
    for (const argv of STEPS) {
      console.log(`$ jea ${argv.join(' ')}`);
      const code = await main(argv);
      if (code) process.exitCode = code;
      if (code) return;
    }
  } finally {
    if (previousHome == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
    if (previousProjectRoot == null) delete process.env.JEA_PROJECT_ROOT;
    else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
    rmSync(jeaHome, { recursive: true, force: true });
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

await run();
