/**
 * Subject LLM budget adapter for the bounded scheduler.
 * Consumes inspectLlmBudget / cycle_admission when #201 is present;
 * otherwise reads the existing fail-closed ledger. Does not invent a
 * second budget system or CLI.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  llmBudgetLedgerPath,
  resolveTokenBudgetConfig,
  tokenBudgetSnapshot,
} from '../ai/token-budget.mjs';
import * as tokenBudget from '../ai/token-budget.mjs';

export const SCHEDULER_BUDGET_CODES = Object.freeze({
  token: 'llm_token_budget_exhausted',
  spend: 'llm_spend_budget_exhausted',
  admission: 'cycle_admission_parked',
});

function asAdmission(value) {
  return value === 'parked' ? 'parked' : 'open';
}

function readLedgerDoc(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function exhaustedFromInspect(status) {
  if (!status) return { exhausted: false, tokens: false, spend: false };
  if (status.exhausted === true || status.state === 'exhausted') {
    const reason = status.blocked_reason || status.code || null;
    return {
      exhausted: true,
      tokens: reason === SCHEDULER_BUDGET_CODES.token || status.exhausted?.tokens === true,
      spend: reason === SCHEDULER_BUDGET_CODES.spend || status.exhausted?.spend === true,
    };
  }
  if (status.exhausted && typeof status.exhausted === 'object') {
    const tokens = status.exhausted.tokens === true;
    const spend = status.exhausted.spend === true;
    return { exhausted: tokens || spend, tokens, spend };
  }
  return { exhausted: false, tokens: false, spend: false };
}

function fallbackExhaustion(snapshot) {
  if (!snapshot) return { exhausted: false, tokens: false, spend: false };
  const tokens = Number(snapshot.remaining_tokens) <= 0;
  const spend = Number(snapshot.remaining_spend_usd) <= 0;
  return { exhausted: tokens || spend, tokens, spend };
}

function blockedReason({ tokens, spend, admission }) {
  if (admission === 'parked') return SCHEDULER_BUDGET_CODES.admission;
  if (tokens) return SCHEDULER_BUDGET_CODES.token;
  if (spend) return SCHEDULER_BUDGET_CODES.spend;
  return null;
}

export function resolveSchedulerBudgetPaths(runtimeRoot, { ledgerPath = null } = {}) {
  return ledgerPath || llmBudgetLedgerPath(runtimeRoot);
}

/**
 * Objective budget facts for deriveReactorSchedulerState / park-once.
 */
export function inspectSchedulerBudget({
  subjectKey,
  runtimeRoot = null,
  ledgerPath = null,
  env = process.env,
  inspect = null,
} = {}) {
  const filePath = resolveSchedulerBudgetPaths(runtimeRoot, { ledgerPath });
  const inspectFn = inspect === undefined
    ? (typeof tokenBudget.inspectLlmBudget === 'function' ? tokenBudget.inspectLlmBudget : null)
    : inspect;

  if (typeof inspectFn === 'function') {
    try {
      const status = inspectFn({
        subjectKey,
        ledgerPath: filePath,
        env,
      });
      const flags = exhaustedFromInspect(status);
      const cycleAdmission = asAdmission(status?.cycle_admission);
      const parked = cycleAdmission === 'parked';
      return {
        source: 'inspectLlmBudget',
        schema: status?.schema ?? null,
        period_id: status?.period_id ?? null,
        cycle_admission: cycleAdmission,
        remaining_tokens: status?.token?.remaining ?? status?.remaining_tokens ?? null,
        remaining_spend_usd: status?.spend?.remaining_usd ?? status?.remaining_spend_usd ?? null,
        exhausted: flags.exhausted || parked,
        tokens_exhausted: flags.tokens,
        spend_exhausted: flags.spend,
        blocked_reason: blockedReason({
          tokens: flags.tokens,
          spend: flags.spend,
          admission: cycleAdmission,
        }),
        raw: status,
      };
    } catch (error) {
      const code = String(error?.code || '');
      if (/llm_(?:token|spend)_budget_exhausted/.test(code)) {
        return {
          source: 'inspectLlmBudget_error',
          schema: null,
          period_id: error?.budget?.period_id ?? null,
          cycle_admission: asAdmission(error?.budget?.cycle_admission),
          remaining_tokens: error?.budget?.remaining_tokens ?? 0,
          remaining_spend_usd: error?.budget?.remaining_spend_usd ?? 0,
          exhausted: true,
          tokens_exhausted: code === SCHEDULER_BUDGET_CODES.token,
          spend_exhausted: code === SCHEDULER_BUDGET_CODES.spend,
          blocked_reason: code,
          raw: error?.budget ?? null,
        };
      }
      throw error;
    }
  }

  const snapshot = filePath
    ? tokenBudgetSnapshot({ subjectKey, ledgerPath: filePath, env })
    : null;
  const doc = readLedgerDoc(filePath);
  const cycleAdmission = asAdmission(doc?.cycle_admission);
  const flags = fallbackExhaustion(snapshot);
  const parked = cycleAdmission === 'parked';
  const config = resolveTokenBudgetConfig(env);
  return {
    source: snapshot ? 'token_budget_ledger' : 'no_ledger',
    schema: null,
    period_id: doc?.period_id ?? null,
    cycle_admission: cycleAdmission,
    remaining_tokens: snapshot?.remaining_tokens ?? config.subjectTokenBudget,
    remaining_spend_usd: snapshot?.remaining_spend_usd ?? config.subjectSpendBudgetUsd,
    exhausted: flags.exhausted || parked,
    tokens_exhausted: flags.tokens,
    spend_exhausted: flags.spend,
    blocked_reason: blockedReason({
      tokens: flags.tokens,
      spend: flags.spend,
      admission: cycleAdmission,
    }),
    raw: snapshot,
  };
}

export function schedulerBudgetParkKey(budget = {}) {
  const code = budget.blocked_reason || (budget.exhausted ? 'budget_exhausted' : 'open');
  const period = budget.period_id || 'current';
  return `budget:${code}:${period}`;
}

export function isLlmBudgetFailure(failure = {}) {
  const text = `${failure.code || ''} ${failure.reason || ''} ${failure.message || ''}`;
  return /(?:llm_)?(?:token|spend)[_ ]budget[_ ]exhausted|cycle_admission_parked/i.test(text);
}
