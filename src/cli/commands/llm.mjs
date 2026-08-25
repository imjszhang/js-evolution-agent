import { MockAIClient } from '../../engine/index.mjs';
import { getProjectRoot, loadProjectEnv } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { DeepSeekOpenAIClient } from '../../ai/deepseek-client.mjs';
import {
  inspectLlmBudget,
  llmBudgetLedgerPath,
  openLlmBudgetPeriod,
  raiseLlmBudgetCeiling,
  setLlmBudgetCycleAdmission,
  shouldClearOperatorBudgetCircuit,
} from '../../ai/token-budget.mjs';
import { clearOperatorBudgetBlocks } from '../../evolution/reactor/rule-resilience.mjs';

export function llmHelpText() {
  return [
    'Usage: jea llm ping [--mock] [--timeout N] [--json] [--subject NAME]',
    '       jea llm budget status [--subject NAME] [--json]',
    '       jea llm budget raise --tokens N [--spend-usd X] [--cycle-admission open|parked] [--reason TEXT] [--json]',
    '       jea llm budget period-open [--tokens N] [--spend-usd X] [--cycle-admission parked|open] [--reason TEXT] [--json]',
    '       jea llm budget set-admission --cycle-admission parked|open [--reason TEXT] [--json]',
    '',
    'Subject LLM budgets are a persistent cumulative fail-closed gate, not a billing period.',
    'Channel and Cycle share one ledger. Exhaustion is a normal operator state:',
    'backlog is preserved and no provider calls are made until you raise the ceiling',
    'or open a new period. Mock paths do not consume this ledger.',
  ].join('\n');
}

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
  });
}

function emitBudgetAudit(runtime, event) {
  if (!event) return;
  makeStore(runtime).recordEvolutionEvent({
    type: event.type,
    subject: runtime.subject,
    subject_key: event.subject_key ?? runtime.subject,
    status: 'ok',
    actor: event.actor ?? 'operator',
    reason: event.reason ?? null,
    period_id: event.period_id ?? null,
    cycle_admission: event.cycle_admission ?? null,
    used_tokens: event.used_tokens ?? null,
    remaining_tokens: event.remaining_tokens ?? null,
    token_budget: event.token_budget ?? null,
    spent_usd: event.spent_usd ?? null,
    remaining_spend_usd: event.remaining_spend_usd ?? null,
    spend_budget_usd: event.spend_budget_usd ?? null,
  });
}

function parseOptionalInt(flags, name) {
  if (flags[name] == null || flags[name] === true) return null;
  const raw = String(flags[name]).trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    const error = new Error(`Invalid --${name}: expected a positive integer`);
    error.code = 'llm_budget_flag_invalid';
    throw error;
  }
  return parsed;
}

function parseOptionalDecimal(flags, name) {
  if (flags[name] == null || flags[name] === true) return null;
  const raw = String(flags[name]).trim();
  const parsed = Number(raw);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw) || !Number.isFinite(parsed)) {
    const error = new Error(`Invalid --${name}: expected a decimal with up to 6 places`);
    error.code = 'llm_budget_flag_invalid';
    throw error;
  }
  return parsed;
}

function parseAdmissionFlag(flags, { required = false, defaultValue = null } = {}) {
  const raw = flags['cycle-admission'] ?? flags.cycle;
  if (raw == null || raw === true) {
    if (required) {
      const error = new Error('Usage requires --cycle-admission parked|open');
      error.code = 'llm_budget_cycle_admission_invalid';
      throw error;
    }
    return defaultValue;
  }
  return String(raw).trim();
}

export function inspectSubjectLlmBudget(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  return {
    runtime,
    status: inspectLlmBudget({
      subjectKey: runtime.subject,
      ledgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
    }),
  };
}

function applyCircuitPolicy(runtime, result) {
  const cleared = shouldClearOperatorBudgetCircuit(result)
    ? clearOperatorBudgetBlocks(runtime.dataRoot)
    : { cleared: 0, fingerprints: [] };
  return {
    ...result,
    circuit_cleared: cleared.cleared,
    circuit_fingerprints: cleared.fingerprints,
    cycle_unblocked: shouldClearOperatorBudgetCircuit(result),
  };
}

export function raiseSubjectLlmBudget(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = raiseLlmBudgetCeiling({
    subjectKey: runtime.subject,
    ledgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
    tokenCeiling: parseOptionalInt(flags, 'tokens'),
    spendCeilingUsd: parseOptionalDecimal(flags, 'spend-usd'),
    cycleAdmission: parseAdmissionFlag(flags),
    reason: flags.reason && flags.reason !== true ? String(flags.reason) : 'operator_raise',
    actor: 'cli',
    emit: (event) => emitBudgetAudit(runtime, event),
  });
  return applyCircuitPolicy(runtime, result);
}

export function openSubjectLlmBudgetPeriod(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = openLlmBudgetPeriod({
    subjectKey: runtime.subject,
    ledgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
    tokenCeiling: parseOptionalInt(flags, 'tokens'),
    spendCeilingUsd: parseOptionalDecimal(flags, 'spend-usd'),
    cycleAdmission: parseAdmissionFlag(flags, { defaultValue: 'parked' }),
    reason: flags.reason && flags.reason !== true ? String(flags.reason) : 'operator_period_open',
    actor: 'cli',
    emit: (event) => emitBudgetAudit(runtime, event),
  });
  return applyCircuitPolicy(runtime, result);
}

export function setSubjectLlmBudgetAdmission(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = setLlmBudgetCycleAdmission({
    subjectKey: runtime.subject,
    ledgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
    cycleAdmission: parseAdmissionFlag(flags, { required: true }),
    reason: flags.reason && flags.reason !== true ? String(flags.reason) : 'operator_set_admission',
    actor: 'cli',
    emit: (event) => emitBudgetAudit(runtime, event),
  });
  return applyCircuitPolicy(runtime, result);
}

export async function pingLlm({
  mock = false,
  timeout = 30,
  root = getProjectRoot(),
  subject = null,
} = {}) {
  const runtime = subject
    ? runtimeInfoForSubject(root, subject)
    : runtimeForFlags(root, {});
  const store = makeStore(runtime);
  const client = mock
    ? new MockAIClient({ defaultResponse: 'pong' })
    : new DeepSeekOpenAIClient({
      timeout,
      subjectKey: runtime.subject,
      budgetLedgerPath: llmBudgetLedgerPath(runtime.runtimeRoot),
      onBudgetEvent: (event) => store.recordEvolutionEvent(event),
    });
  const started = Date.now();
  const text = typeof client.chatMessages === 'function'
    ? await client.chatMessages(
      [{ role: 'user', content: 'Reply with exactly: pong' }],
      { thinking: 'low', timeout, phase: 'llm_ping' },
    )
    : await client.chat('Reply with exactly: pong', 'low', timeout);
  return {
    ok: text.trim().toLowerCase().includes('pong'),
    mode: mock ? 'mock' : 'deepseek',
    elapsedMs: Date.now() - started,
    responsePreview: text.trim().slice(0, 80),
  };
}

function printBudgetStatus(status) {
  console.log(`subject: ${status.subject}`);
  console.log(`state: ${status.state}`);
  console.log(`period: ${status.period_id}`);
  console.log(`cycle_admission: ${status.cycle_admission}`);
  console.log(
    `tokens: ${status.token.used} used / ${status.token.budget} budget / ${status.token.remaining} remaining`,
  );
  console.log(
    `spend: $${status.spend.used_usd} used / $${status.spend.budget_usd} budget / $${status.spend.remaining_usd} remaining`,
  );
  console.log(`calls: ${status.calls}`);
  console.log('shared_ledger: Channel and Cycle share this ledger');
  if (status.blocked_reason) console.log(`blocked_reason: ${status.blocked_reason}`);
  console.log(`reserve_note: ${status.reserve_estimate.note}`);
  console.log('next:');
  for (const action of status.next_actions) console.log(`  ${action.command}`);
}

function printBudgetAction(result) {
  console.log(`action: ${result.action}`);
  console.log(`ok: ${result.ok}`);
  console.log(`period: ${result.period_id}`);
  console.log(`cycle_admission: ${result.cycle_admission}`);
  console.log(`cycle_unblocked: ${result.cycle_unblocked}`);
  console.log(`circuit_cleared: ${result.circuit_cleared}`);
  printBudgetStatus(result.status);
}

function printPayload(flags, payload, printHuman) {
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else printHuman(payload);
}

async function pingCommand(flags = {}) {
  const mock = !!flags.mock;
  if (!mock && !process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is required. Use --mock for a local ping.');
    return 1;
  }
  try {
    const result = await pingLlm({
      mock,
      timeout: Number(flags.timeout) || 30,
      root: getProjectRoot(),
      subject: flags.subject && flags.subject !== true ? flags.subject : null,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`mode: ${result.mode}`);
      console.log(`ok: ${result.ok}`);
      console.log(`elapsedMs: ${result.elapsedMs}`);
      console.log(`response: ${result.responsePreview}`);
    }
    return result.ok ? 0 : 1;
  } catch (e) {
    const result = {
      ok: false,
      mode: mock ? 'mock' : 'deepseek',
      error: e?.message || String(e),
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.error(`LLM ping failed: ${result.error}`);
    return 1;
  }
}

function budgetActionError(error, flags) {
  const payload = {
    ok: false,
    code: error?.code ?? 'llm_budget_command_failed',
    error: error?.message || String(error),
  };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else console.error(`${payload.code}: ${payload.error}`);
  return 1;
}

export async function llmCommand({ subcommand, flags = {}, args = [] } = {}) {
  loadProjectEnv(getProjectRoot());
  if (subcommand === 'ping') return pingCommand(flags);
  if (subcommand !== 'budget') {
    console.error(llmHelpText());
    return 2;
  }
  const action = args[0] ?? 'status';
  try {
    if (action === 'status') {
      const { status } = inspectSubjectLlmBudget(getProjectRoot(), flags);
      printPayload(flags, status, printBudgetStatus);
      return status.state === 'exhausted' ? 1 : 0;
    }
    if (action === 'raise') {
      const result = raiseSubjectLlmBudget(getProjectRoot(), flags);
      printPayload(flags, result, printBudgetAction);
      return 0;
    }
    if (action === 'period-open') {
      const result = openSubjectLlmBudgetPeriod(getProjectRoot(), flags);
      printPayload(flags, result, printBudgetAction);
      return 0;
    }
    if (action === 'set-admission') {
      const result = setSubjectLlmBudgetAdmission(getProjectRoot(), flags);
      printPayload(flags, result, printBudgetAction);
      return 0;
    }
    console.error(llmHelpText());
    return 2;
  } catch (error) {
    return budgetActionError(error, flags);
  }
}
