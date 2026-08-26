#!/usr/bin/env node
/**
 * Isolated 0.3.0 Reactor control-plane acceptance runner.
 *
 * Always uses a temporary JEA_HOME and mock LLM. Does not write ~/.jea or
 * repo runtime/. Does not create a tag or GitHub Release.
 *
 * Usage:
 *   node scripts/control-plane-audit.mjs [--repo DIR] [--target PATH] [--json]
 *     [--skip-baseline] [--size tiny|smoke] [--subject NAME]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import {
  renderControlPlaneAuditText,
  runControlPlaneAudit,
} from '../src/intelligence/control-plane-audit.mjs';
import { CONTROL_PLANE_TARGET_PATH } from '../src/intelligence/control-plane-target.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const includeBaseline = !args['skip-baseline'];
  const profile = args.size === 'smoke' ? 'smoke' : 'tiny';
  const report = await runControlPlaneAudit({
    sourceRoot: repoRoot,
    targetPath: args.target || CONTROL_PLANE_TARGET_PATH,
    includeBaseline,
    baselineProfile: profile,
    includeClosureRun: true,
    subject: args.subject || 'control-plane-cert',
  });
  if (includeBaseline) {
    report.baseline_profile = profile;
  }
  report.script = 'control-plane-audit';
  report.messages = [
    `target ${report.gate?.target_id || report.target_id}`,
    `status ${report.status}`,
    `isolation ${report.isolation?.jea_home || 'none'}`,
    ...(report.checks || []).map((item) => `${item.ok ? 'ok' : 'fail'} ${item.id}`),
    ...(report.gate?.failures || []).map((item) => `gate ${item.id}: ${item.reason || item.expected || 'failed'}`),
  ];
  if (args.json) printReport(report, { json: true });
  else process.stdout.write(renderControlPlaneAuditText(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
