import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyRunSpecToAction } from '../src/actions/agent-run-spec.mjs';
import { resolveActionExecutionRoots } from '../src/actions/execution-root.mjs';
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

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlainContainer(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => clonePlainContainer(item));
  if (!isPlainObject(value)) return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = typeof item === 'function' ? item : clonePlainContainer(item);
  }
  return next;
}

function cloneContext(context) {
  const { run: _run, ...rest } = context ?? {};
  const next = {};
  for (const [key, value] of Object.entries(rest)) {
    next[key] = clonePlainContainer(value);
  }
  return next;
}

function applyExecutionRoot(context, root) {
  if (!root) return context;
  return { ...context, projectRoot: root, executionRoot: root };
}

function applyIsolatedExecutionRoot(action, root) {
  if (!root) return action;
  const params = { ...(action.params ?? {}) };
  const runSpec = params.run_spec && typeof params.run_spec === 'object'
    ? { ...params.run_spec }
    : {};
  params.cwd = root;
  params.executionRoot = root;
  params.execution_root = root;
  params.primary_cwd = root;
  params.primaryCwd = root;
  runSpec.primary_cwd = root;
  runSpec.primaryCwd = root;
  runSpec.cwd = root;
  runSpec.executionRoot = root;
  runSpec.execution_root = root;
  params.run_spec = runSpec;
  return { ...action, params };
}

function prepareIsolatedAction(action, context, provider, isolatedRoot) {
  const candidate = applyIsolatedExecutionRoot(structuredClone(action), isolatedRoot);
  candidate.params = { ...(candidate.params ?? {}), provider };
  if (candidate.params.run_spec) {
    candidate.params.run_spec = { ...candidate.params.run_spec, provider };
  }
  if (!isolatedRoot) {
    return {
      action: candidate,
      executionRoot: context.projectRoot ?? null,
    };
  }
  const prepared = applyRunSpecToAction(candidate, context);
  prepared.params = { ...(prepared.params ?? {}), provider };
  if (prepared.params.run_spec) {
    prepared.params.run_spec = { ...prepared.params.run_spec, provider };
  }
  const roots = resolveActionExecutionRoots(prepared, context);
  if (resolve(roots.executionRoot) !== resolve(isolatedRoot)) {
    throw new Error(
      `Provider ${provider} execution root could not be isolated to ${isolatedRoot}`,
    );
  }
  return {
    action: prepared,
    executionRoot: roots.executionRoot,
  };
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
  if (writeProfile) {
    if (isolateRoots === 'never') {
      throw new Error('Write-profile comparison cannot disable execution-root isolation');
    }
    const roots = providers.map((provider) => executionRoots?.[provider]).filter(Boolean);
    if (roots.length !== providers.length) {
      throw new Error('Write-profile comparison requires isolated execution roots for every provider');
    }
    if (new Set(roots.map((root) => resolve(root))).size !== providers.length) {
      throw new Error('Write-profile comparison requires distinct execution roots per provider');
    }
  }
  const results = [];
  for (const provider of providers) {
    const started = Date.now();
    const isolatedRoot = executionRoots?.[provider] ?? null;
    const nextContext = applyExecutionRoot(cloneContext(context), isolatedRoot);
    const prepared = prepareIsolatedAction(action, nextContext, provider, isolatedRoot);
    const result = await run(prepared.action, nextContext);
    results.push({
      ...providerMetrics(provider, result, Date.now() - started),
      execution_root: prepared.executionRoot ?? nextContext.projectRoot ?? context.projectRoot ?? null,
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
