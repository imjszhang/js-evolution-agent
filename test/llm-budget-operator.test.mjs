import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { helpText } from '../src/cli/jea.mjs';
import {
  inspectSubjectLlmBudget,
  llmCommand,
  llmHelpText,
  openSubjectLlmBudgetPeriod,
  pingLlm,
  raiseSubjectLlmBudget,
  setSubjectLlmBudgetAdmission,
} from '../src/cli/commands/llm.mjs';
import {
  inspectLlmBudget,
  LLM_BUDGET_LEGACY_PERIOD_ID,
  LLM_BUDGET_STATUS_SCHEMA,
  openLlmBudgetPeriod,
  raiseLlmBudgetCeiling,
  reserveTokenBudget,
  setLlmBudgetCycleAdmission,
  shouldClearOperatorBudgetCircuit,
} from '../src/ai/token-budget.mjs';
import { getProjectRoot } from '../src/infra/project.mjs';
import {
  clearOperatorBudgetBlocks,
  noteRuleFailure,
  planRuleBatch,
  readRuleResilienceProjection,
  resolveRuleLimits,
} from '../src/evolution/reactor/rule-resilience.mjs';

const homes = [];
const previousHome = process.env.JEA_HOME;

function tempHome() {
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-llm-budget-home-'));
  homes.push(jeaHome);
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        channels: { desktop: { enabled: true, default_session: 'main' } },
      },
    },
  }));
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data', 'data', 'evolution'), { recursive: true });
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data', 'data', 'intelligence'), { recursive: true });
  process.env.JEA_HOME = jeaHome;
  return {
    jeaHome,
    runtimeRoot: join(jeaHome, 'subjects', 'alpha-data'),
    dataRoot: join(jeaHome, 'subjects', 'alpha-data', 'data'),
    ledgerPath: join(jeaHome, 'subjects', 'alpha-data', 'data', 'evolution', 'llm-budget-ledger.json'),
  };
}

function writeLedger(ledgerPath, overrides = {}) {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify({
    version: 1,
    subject_key: 'alpha',
    token_budget: 1_000_000,
    spend_budget_usd_micros: 10_000_000,
    used_tokens: 989_000,
    reserved_tokens: 0,
    spent_usd_micros: 2_340_000,
    reserved_usd_micros: 0,
    calls: 47,
    reservations: {},
    events: [],
    updated_at: '2026-08-24T00:00:00.000Z',
    ...overrides,
  }, null, 2)}\n`);
}

function openBudgetCircuit(dataRoot) {
  const events = [{
    id: 'evt-budget-1',
    kind: 'goal_event',
    indexed_entry: { locator: { length: 32 } },
  }];
  const limits = resolveRuleLimits({ max_events: 1 }, {});
  const initial = planRuleBatch(dataRoot, events, limits);
  return noteRuleFailure(dataRoot, {
    fingerprint: initial.fingerprint,
    evidenceKeys: initial.evidence_keys,
    error: Object.assign(
      new Error('llm_token_budget_exhausted for alpha'),
      { code: 'llm_token_budget_exhausted', retryable: false },
    ),
    eventCount: initial.events.length,
    limits,
  });
}

async function captureIo(run) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value) => { logs.push(String(value)); };
  console.error = (value) => { errors.push(String(value)); };
  try {
    const code = await run();
    return { code, logs, errors, text: [...logs, ...errors].join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  while (homes.length) {
    rmSync(homes.pop(), { recursive: true, force: true });
  }
  if (previousHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousHome;
});

describe('LLM budget operator control API', () => {
  it('reports unused subjects without writing a ledger', () => {
    const { ledgerPath } = tempHome();
    const status = inspectLlmBudget({ subjectKey: 'alpha', ledgerPath });
    expect(status).toMatchObject({
      schema: LLM_BUDGET_STATUS_SCHEMA,
      subject: 'alpha',
      ledger_present: false,
      shared_ledger: true,
      ledger_scope: 'subject',
      state: 'ok',
      cycle_admission: 'open',
      token: { used: 0, remaining: 1_000_000, budget: 1_000_000 },
    });
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();
  });

  it('treats leftover tokens below a typical reserve as exhausted', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const status = inspectLlmBudget({ subjectKey: 'alpha', ledgerPath });
    expect(status.state).toBe('exhausted');
    expect(status.blocked_reason).toBe('llm_token_budget_exhausted');
    expect(status.token).toMatchObject({
      used: 989_000,
      remaining: 11_000,
      budget: 1_000_000,
    });
    expect(status.spend.used_usd).toBe(2.34);
    expect(status.next_actions.map((item) => item.id)).toEqual(
      expect.arrayContaining(['raise_ceiling', 'open_period', 'set_admission']),
    );
    expect(status.reserve_estimate.note).toMatch(/3-4x/);
  });

  it('reads legacy ledgers as period-legacy without inventing a new period', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const status = inspectLlmBudget({ subjectKey: 'alpha', ledgerPath });
    expect(status.period_id).toBe(LLM_BUDGET_LEGACY_PERIOD_ID);
  });

  it('raises a persisted ceiling without resetting used_*', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const events = [];
    const result = raiseLlmBudgetCeiling({
      subjectKey: 'alpha',
      ledgerPath,
      tokenCeiling: 2_000_000,
      spendCeilingUsd: 20,
      reason: 'operator top-up',
      actor: 'test',
      emit: (event) => events.push(event),
    });
    expect(result.action).toBe('llm_budget_ceiling_raised');
    expect(result.status.token).toMatchObject({
      used: 989_000,
      budget: 2_000_000,
      remaining: 1_011_000,
      operator_ceiling: 2_000_000,
    });
    expect(result.status.state).toBe('ok');
    expect(events.at(-1)?.type).toBe('llm_budget_ceiling_raised');
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(persisted.used_tokens).toBe(989_000);
    expect(persisted.operator_token_ceiling).toBe(2_000_000);
    expect(persisted.events.at(-1)?.type).toBe('llm_budget_ceiling_raised');
  });

  it('opens a new period by resetting used_* under a new period id', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const result = openLlmBudgetPeriod({
      subjectKey: 'alpha',
      ledgerPath,
      cycleAdmission: 'parked',
      reason: 'channel-only recovery',
    });
    expect(result.action).toBe('llm_budget_period_opened');
    expect(result.period_id).toMatch(/^llm-period-/);
    expect(result.period_id).not.toBe(LLM_BUDGET_LEGACY_PERIOD_ID);
    expect(result.cycle_admission).toBe('parked');
    expect(result.status.token).toMatchObject({ used: 0, remaining: 1_000_000 });
    expect(result.status.calls).toBe(0);
    expect(shouldClearOperatorBudgetCircuit(result)).toBe(false);
    const persisted = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(persisted.previous_periods).toHaveLength(1);
    expect(persisted.previous_periods[0]).toMatchObject({
      period_id: LLM_BUDGET_LEGACY_PERIOD_ID,
      used_tokens: 989_000,
      calls: 47,
    });
  });

  it('refuses to open a period while reservations are open', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath, {
      used_tokens: 10,
      reserved_tokens: 20,
      reservations: {
        'llm-reserve-open': {
          reservation_id: 'llm-reserve-open',
          reserved_tokens: 20,
          reserved_cost_usd_micros: 1,
        },
      },
    });
    expect(() => openLlmBudgetPeriod({
      subjectKey: 'alpha',
      ledgerPath,
    })).toThrow(/reservations are open/);
  });

  it('keeps the hard reserve gate after recovery APIs write the ledger', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath, { used_tokens: 1_000_000, spent_usd_micros: 0 });
    expect(() => reserveTokenBudget({
      subjectKey: 'alpha',
      ledgerPath,
      messages: [{ role: 'user', content: 'hello' }],
      requestedMaxTokens: 16,
      env: { JEA_LLM_SUBJECT_TOKEN_BUDGET: '1000000', JEA_LLM_REQUEST_MAX_TOKENS: '16' },
    })).toThrow(/llm_token_budget_exhausted/);
    raiseLlmBudgetCeiling({
      subjectKey: 'alpha',
      ledgerPath,
      tokenCeiling: 2_000_000,
      env: { JEA_LLM_SUBJECT_TOKEN_BUDGET: '1000000', JEA_LLM_REQUEST_MAX_TOKENS: '16' },
    });
    const reserved = reserveTokenBudget({
      subjectKey: 'alpha',
      ledgerPath,
      messages: [{ role: 'user', content: 'hello' }],
      requestedMaxTokens: 16,
      env: { JEA_LLM_SUBJECT_TOKEN_BUDGET: '1000000', JEA_LLM_REQUEST_MAX_TOKENS: '16' },
    });
    expect(reserved.reservedTokens).toBeGreaterThan(0);
  });
});

describe('LLM budget operator CLI', () => {
  it('documents the budget workflow in help', () => {
    expect(helpText()).toContain('llm budget status');
    expect(helpText()).toContain('llm budget raise');
    expect(helpText()).toContain('llm budget period-open');
    expect(llmHelpText()).toContain('share one ledger');
  });

  it('prints machine-readable status for an exhausted subject', async () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const captured = await captureIo(() => llmCommand({
      subcommand: 'budget',
      args: ['status'],
      flags: { json: true, subject: 'alpha' },
    }));
    expect(captured.code).toBe(1);
    const payload = JSON.parse(captured.logs.join('\n'));
    expect(payload).toMatchObject({
      schema: LLM_BUDGET_STATUS_SCHEMA,
      subject: 'alpha',
      state: 'exhausted',
      token: { used: 989_000, remaining: 11_000 },
    });
  });

  it('recovers Channel-only without clearing the Cycle operator-budget circuit', () => {
    const { dataRoot, ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    openBudgetCircuit(dataRoot);
    expect(readRuleResilienceProjection(dataRoot).block_reason).toBe('rule_llm_budget_exhausted');
    const opened = openSubjectLlmBudgetPeriod(getProjectRoot(), {
      subject: 'alpha',
      'cycle-admission': 'parked',
      reason: 'restore conversation only',
    });
    expect(opened.status.token.used).toBe(0);
    expect(opened.cycle_admission).toBe('parked');
    expect(opened.cycle_unblocked).toBe(false);
    expect(opened.circuit_cleared).toBe(0);
    expect(readRuleResilienceProjection(dataRoot).block_reason).toBe('rule_llm_budget_exhausted');
    const admitted = setSubjectLlmBudgetAdmission(getProjectRoot(), {
      subject: 'alpha',
      'cycle-admission': 'open',
    });
    expect(admitted.cycle_unblocked).toBe(true);
    expect(admitted.circuit_cleared).toBeGreaterThan(0);
    expect(readRuleResilienceProjection(dataRoot).blocked).toBe(false);
  });

  it('raises the ceiling through the CLI and records an evolution event', () => {
    const { ledgerPath, runtimeRoot } = tempHome();
    writeLedger(ledgerPath);
    const raised = raiseSubjectLlmBudget(getProjectRoot(), {
      subject: 'alpha',
      tokens: '2000000',
      reason: 'continue evolution',
    });
    expect(raised.status.token.budget).toBe(2_000_000);
    expect(raised.status.token.used).toBe(989_000);
    expect(raised.cycle_unblocked).toBe(true);
    const eventsPath = join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: 'llm_budget_ceiling_raised',
      subject: 'alpha',
      token_budget: 2_000_000,
    });
  });

  it('does not consume the ledger on the mock ping path', async () => {
    const { ledgerPath } = tempHome();
    const result = await pingLlm({ mock: true, subject: 'alpha' });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('mock');
    expect(() => readFileSync(ledgerPath, 'utf8')).toThrow();
  });

  it('exposes inspect helpers that #212/#217 can reuse', () => {
    const { ledgerPath } = tempHome();
    writeLedger(ledgerPath);
    const { status } = inspectSubjectLlmBudget(getProjectRoot(), { subject: 'alpha' });
    expect(status.schema).toBe(LLM_BUDGET_STATUS_SCHEMA);
    expect(status.shared_ledger).toBe(true);
    expect(status.cycle_admission).toBe('open');
    expect(clearOperatorBudgetBlocks(join(tmpdir(), 'missing-rule-resilience')).cleared).toBe(0);
    expect(setLlmBudgetCycleAdmission({
      subjectKey: 'alpha',
      ledgerPath,
      cycleAdmission: 'parked',
    }).cycle_admission).toBe('parked');
  });
});
