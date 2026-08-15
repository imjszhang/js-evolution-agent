import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runAgenticAction } from '../src/actions/agent-adapter/index.mjs';

function eventRows(result) {
  const rows = result?.agent?.outputs?.acp?.events
    ?? result?.agent?.outputs?.events
    ?? [];
  return Array.isArray(rows) ? rows : [];
}

export function providerMetrics(provider, result, elapsedMs) {
  const events = eventRows(result);
  const loop = result?.agent?.outputs?.agent_loop ?? {};
  return {
    provider,
    success: Boolean(result?.success),
    deferred: Boolean(result?.deferred),
    schema_status: result?.agent?.schema_status ?? null,
    acceptance_status: result?.agent?.acceptance_status
      ?? result?.agent?.receipt?.acceptance_status
      ?? null,
    verification_attempts: loop.verification_attempts ?? null,
    same_session: loop.same_session ?? null,
    tool_started: events.filter((event) =>
      ['tool_started', 'acp_tool_started'].includes(event?.event ?? event?.type)).length,
    tool_finished: events.filter((event) =>
      ['tool_finished', 'acp_tool_finished'].includes(event?.event ?? event?.type)).length,
    permission_decisions: events.filter((event) =>
      ['permission_decision', 'acp_permission_decision'].includes(event?.event ?? event?.type)).length,
    failure_phase: result?.provider_failure?.phase ?? null,
    error_code: result?.errorCode ?? null,
    elapsed_ms: elapsedMs,
    serialized_bytes: Buffer.byteLength(JSON.stringify(result ?? null)),
  };
}

export async function runProviderComparison({
  action,
  context,
  providers = ['claude_code_sdk', 'acp:claude-code'],
  run = runAgenticAction,
} = {}) {
  if (!action || !context) throw new Error('action and context are required');
  const results = [];
  for (const provider of providers) {
    const started = Date.now();
    const candidate = structuredClone(action);
    candidate.params = { ...(candidate.params ?? {}), provider };
    if (candidate.params.run_spec) {
      candidate.params.run_spec = { ...candidate.params.run_spec, provider };
    }
    const result = await run(candidate, context);
    results.push(providerMetrics(provider, result, Date.now() - started));
  }
  const [legacy, acp] = results;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    action_id: action.id ?? null,
    providers: results,
    recommendation: acp?.success
      && acp.schema_status === 'valid'
      && (!legacy?.success || acp.verification_attempts <= legacy.verification_attempts)
      ? 'acp_candidate'
      : 'keep_legacy_default',
    default_changed: false,
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: node scripts/acp-provider-compare.mjs <scenario.json>');
  }
  const scenario = JSON.parse(readFileSync(input, 'utf8'));
  const report = await runProviderComparison(scenario);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
