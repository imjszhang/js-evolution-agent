#!/usr/bin/env node
/**
 * Read-only Reactor backlog / amplification baseline (#209).
 *
 * Creates a deterministic synthetic 0.2.x subject under a temp JEA_HOME,
 * measures authority vs claimable work, and (by default) rebuilds the
 * evidence journal to report whether handled coverage is preserved.
 *
 * Usage:
 *   node scripts/reactor-backlog-baseline.mjs [--size tiny|smoke|large|incident] [--json] [--out PATH] [--keep] [--skip-rebuild]
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from './release-lib.mjs';
import { FIXTURE_PROFILES, runReactorBacklogBaseline } from './reactor-baseline/index.mjs';

function usage() {
  return [
    'Usage: node scripts/reactor-backlog-baseline.mjs [options]',
    '',
    '  --size tiny|smoke|large|incident   Fixture profile (default: smoke)',
    '  --json                             Print machine-readable JSON (default)',
    '  --out PATH                         Write JSON to PATH',
    '  --keep                             Keep the temp JEA_HOME for inspection',
    '  --skip-rebuild                     Skip the new-generation coverage experiment',
    '',
    'Never reads or writes ~/.jea. No network and no real LLM calls.',
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const profile = String(args.size || args.profile || 'smoke');
  if (!FIXTURE_PROFILES[profile]) {
    console.error(`Unknown --size ${profile}. Expected: ${Object.keys(FIXTURE_PROFILES).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const report = await runReactorBacklogBaseline({
    profile,
    rebuild: !args['skip-rebuild'],
    keep: Boolean(args.keep),
  });
  const json = JSON.stringify(report, null, 2);
  if (args.out) writeFileSync(String(args.out), `${json}\n`, 'utf8');
  if (args.json !== false) console.log(json);
  if (!report.isolation?.isolated) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
