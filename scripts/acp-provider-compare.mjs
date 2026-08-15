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

function pickProviders(results) {
  const acp = results.find((item) => String(item.provider).startsWith('acp:'));
  const legacy = results.find((item) => item.provider === 'claude_code_sdk')
    ?? results.find((item) => !String(item.provider).startsWith('acp:'));
  return { legacy, acp };
}

function attemptsComparable(left, right) {
  return Number.isFinite(left) && Number.isFinite(right);
}

function recommend(legacy, acp) {
  if (!acp?.success || acp.schema_status !== 'valid') return 'keep_legacy_default';
  if (!legacy?.success) return 'acp_candidate';
  if (!attemptsComparable(acp.verification_attempts, legacy.verification_attempts)) {
    return 'keep_legacy_default';
  }
  return acp.verification_attempts <= legacy.verification_attempts
    ? 'acp_candidate'
    : 'keep_legacy_default';
}

function comparisonReport(actionId, results) {
  const { legacy, acp } = pickProviders(results);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    action_id: actionId ?? null,
    providers: results,
    comparison_basis: {
      legacy_provider: legacy?.provider ?? null,
      acp_provider: acp?.provider ?? null,
      attempts_comparable: attemptsComparable(
        acp?.verification_attempts,
        legacy?.verification_attempts,
      ),
    },
    recommendation: recommend(legacy, acp),
    default_changed: false,
  };
}

function cloneContext(context) {
  const { run: _run, ...rest } = context ?? {};
  try {
    return structuredClone(rest);
  } catch {
    return { projectRoot: rest.projectRoot };
  }
}

function applyExecutionRoot(context, root) {
  if (!root) return context;
  const next = { ...context, projectRoot: root, executionRoot: root };
  return next;
}

function permissionProfile(action) {
  return action?.params?.run_spec?.permission_profile
    ?? action?.params?.permission_profile
    ?? 'read_only';
}

export function compareProviderResults({ action_id = null, results = {} } = {}) {
  const metrics = Object.entries(results).map(([provider, value]) =>
    providerMetrics(provider, value?.result ?? value, value?.elapsed_ms ?? 0));
  if (metrics.length < 2) throw new Error('At least two provider results are required');
  return comparisonReport(action_id, metrics);
}

export async function runProviderComparison({
  action,
  context,
  providers = ['claude_code_sdk', 'acp:claude-code'],
  run = runAgenticAction,
  isolateRoots = 'auto',
  executionRoots = null,
} = {}) {
  if (!action || !context) throw new Error('action and context are required');
  const profile = permissionProfile(action);
  const writeProfile = profile !== 'read_only';
  if (writeProfile && isolateRoots !== 'never' && !executionRoots) {
    throw new Error('Write-profile comparison requires isolated execution roots');
  }
  const results = [];
  for (const provider of providers) {
    const started = Date.now();
    const candidate = structuredClone(action);
    candidate.params = { ...(candidate.params ?? {}), provider };
    if (candidate.params.run_spec) {
      candidate.params.run_spec = { ...candidate.params.run_spec, provider };
    }
    const nextContext = applyExecutionRoot(
      cloneContext(context),
      executionRoots?.[provider] ?? null,
    );
    const result = await run(candidate, nextContext);
    results.push({
      ...providerMetrics(provider, result, Date.now() - started),
      execution_root: nextContext.projectRoot ?? context.projectRoot ?? null,
    });
  }
  return comparisonReport(action.id, results);
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: node scripts/acp-provider-compare.mjs <provider-results.json>');
  }
  const scenario = JSON.parse(readFileSync(input, 'utf8'));
  const report = compareProviderResults(scenario);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
