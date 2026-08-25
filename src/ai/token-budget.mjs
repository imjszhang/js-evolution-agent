import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { summarizeLlmUsage } from './prompt-cache-metadata.mjs';

const DEFAULT_SUBJECT_TOKEN_BUDGET = 1_000_000;
const DEFAULT_REQUEST_MAX_TOKENS = 8192;
const DEFAULT_SUBJECT_SPEND_BUDGET_USD = 10;
const DEFAULT_INPUT_PRICE_PER_MILLION_USD = 1;
const DEFAULT_CACHE_HIT_PRICE_PER_MILLION_USD = 0.1;
const DEFAULT_OUTPUT_PRICE_PER_MILLION_USD = 4;
const MAX_CONFIGURED_TOKENS = 100_000_000;
const MAX_BUDGET_USD = 100_000;
const MAX_PRICE_PER_MILLION_USD = 1_000;
const USD_MICROS = 1_000_000;

export const LLM_BUDGET_LEDGER_VERSION = 1;
export const LLM_BUDGET_LEDGER_FILENAME = 'llm-budget-ledger.json';
export const LLM_BUDGET_STATUS_SCHEMA = 'llm_budget_status.v1';
export const LLM_BUDGET_LEGACY_PERIOD_ID = 'period-legacy';
export const LLM_BUDGET_CYCLE_ADMISSIONS = Object.freeze(['open', 'parked']);
export const LLM_BUDGET_TYPICAL_PROMPT_RESERVE_TOKENS = 48_000;
export const LLM_BUDGET_PREVIOUS_PERIODS_MAX = 32;

function configError(name, expected, code = 'llm_token_budget_config_invalid') {
  const error = new Error(`Invalid ${name}: expected ${expected}`);
  error.code = code;
  error.variable = name;
  return error;
}

function configuredPositiveInt(env, names, fallback, max) {
  const name = names.find((candidate) => env[candidate] !== undefined);
  if (!name) return fallback;
  const raw = String(env[name]).trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw configError(name, `an integer between 1 and ${max}`);
  }
  return parsed;
}

function configuredDecimal(env, names, fallback, {
  minExclusive = null,
  minInclusive = null,
  max,
} = {}) {
  const name = names.find((candidate) => env[candidate] !== undefined);
  if (!name) return fallback;
  const raw = String(env[name]).trim();
  const parsed = Number(raw);
  const validSyntax = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(raw);
  const aboveMin = minExclusive != null
    ? parsed > minExclusive
    : parsed >= (minInclusive ?? 0);
  if (!validSyntax || !Number.isFinite(parsed) || !aboveMin || parsed > max) {
    const lower = minExclusive != null ? `greater than ${minExclusive}` : `at least ${minInclusive ?? 0}`;
    throw configError(
      name,
      `a decimal ${lower} and at most ${max} (up to 6 decimal places)`,
      'llm_spend_budget_config_invalid',
    );
  }
  return parsed;
}

function requiredSubjectKey(value) {
  const key = String(value ?? '').trim();
  if (!key) {
    const error = new Error('LLM budget requires an explicit subjectKey');
    error.code = 'llm_subject_key_required';
    throw error;
  }
  return key;
}

function requiredLedgerPath(value) {
  const path = String(value ?? '').trim();
  if (!path) {
    const error = new Error('LLM budget requires an explicit subject runtime ledgerPath');
    error.code = 'llm_budget_ledger_path_required';
    throw error;
  }
  return path;
}

function usdToMicros(value) {
  return Math.round(Number(value) * USD_MICROS);
}

function microsToUsd(value) {
  return Number((Number(value || 0) / USD_MICROS).toFixed(6));
}

function costMicros(tokens, pricePerMillionUsd) {
  return Math.ceil(
    (Math.max(0, Math.trunc(Number(tokens) || 0)) * usdToMicros(pricePerMillionUsd)) / 1_000_000,
  );
}

function newPeriodId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `llm-period-${stamp}-${randomUUID().slice(0, 8)}`;
}

function emptyLedger(subjectKey, config) {
  const now = new Date().toISOString();
  return {
    version: LLM_BUDGET_LEDGER_VERSION,
    subject_key: subjectKey,
    period_id: newPeriodId(),
    period_opened_at: now,
    cycle_admission: 'open',
    operator_token_ceiling: null,
    operator_spend_ceiling_usd_micros: null,
    previous_periods: [],
    token_budget: config.subjectTokenBudget,
    spend_budget_usd_micros: usdToMicros(config.subjectSpendBudgetUsd),
    used_tokens: 0,
    reserved_tokens: 0,
    spent_usd_micros: 0,
    reserved_usd_micros: 0,
    calls: 0,
    reservations: {},
    events: [],
    updated_at: now,
  };
}

function validateLedger(doc, { subjectKey, filePath }) {
  const invalid = (
    !doc
    || typeof doc !== 'object'
    || Array.isArray(doc)
    || doc.version !== LLM_BUDGET_LEDGER_VERSION
    || doc.subject_key !== subjectKey
    || !Number.isSafeInteger(doc.token_budget)
    || !Number.isSafeInteger(doc.spend_budget_usd_micros)
    || !Number.isSafeInteger(doc.used_tokens)
    || !Number.isSafeInteger(doc.reserved_tokens)
    || !Number.isSafeInteger(doc.spent_usd_micros)
    || !Number.isSafeInteger(doc.reserved_usd_micros)
    || !Number.isSafeInteger(doc.calls)
    || !doc.reservations
    || typeof doc.reservations !== 'object'
    || Array.isArray(doc.reservations)
    || !Array.isArray(doc.events)
  );
  if (invalid) {
    const error = new Error(`Invalid LLM budget ledger at ${filePath}`);
    error.code = 'llm_budget_ledger_invalid';
    throw error;
  }
  return doc;
}

function readLedger(filePath, subjectKey, config) {
  if (!existsSync(filePath)) return emptyLedger(subjectKey, config);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (cause) {
    const error = new Error(`Failed to read LLM budget ledger at ${filePath}: ${cause?.message || cause}`);
    error.code = 'llm_budget_ledger_read_failed';
    error.cause = cause;
    throw error;
  }
  const doc = validateLedger(parsed, { subjectKey, filePath });
  return normalizeLedger(doc, config);
}

function normalizeLedger(doc, config) {
  if (!doc.period_id) {
    doc.period_id = LLM_BUDGET_LEGACY_PERIOD_ID;
    doc.period_opened_at = doc.updated_at || new Date().toISOString();
  }
  if (doc.cycle_admission !== 'parked') doc.cycle_admission = 'open';
  if (!Array.isArray(doc.previous_periods)) doc.previous_periods = [];
  if (!Number.isSafeInteger(doc.operator_token_ceiling)) doc.operator_token_ceiling = null;
  if (!Number.isSafeInteger(doc.operator_spend_ceiling_usd_micros)) {
    doc.operator_spend_ceiling_usd_micros = null;
  }
  const operatorToken = Number.isSafeInteger(doc.operator_token_ceiling) ? doc.operator_token_ceiling : 0;
  const operatorSpend = Number.isSafeInteger(doc.operator_spend_ceiling_usd_micros)
    ? doc.operator_spend_ceiling_usd_micros
    : 0;
  // Env remains the configured floor; operator raise persists above it.
  // Accumulated use is never reset by a ceiling change.
  doc.token_budget = Math.max(config.subjectTokenBudget, operatorToken);
  doc.spend_budget_usd_micros = Math.max(usdToMicros(config.subjectSpendBudgetUsd), operatorSpend);
  return doc;
}

function writeLedger(filePath, doc) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (cause) {
    try { unlinkSync(tempPath); } catch {}
    const error = new Error(`Failed to write LLM budget ledger at ${filePath}: ${cause?.message || cause}`);
    error.code = 'llm_budget_ledger_write_failed';
    error.cause = cause;
    throw error;
  }
}

function withLedgerLock(filePath, fn) {
  mkdirSync(dirname(filePath), { recursive: true });
  const lockTarget = `${filePath}.lock`;
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, '', { flag: 'a' });
  let release;
  let cause;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (const delayMs of [0, 10, 20, 40, 80, 100, 100, 100]) {
    if (delayMs) Atomics.wait(wait, 0, 0, delayMs);
    try {
      release = lockfile.lockSync(lockTarget);
      cause = null;
      break;
    } catch (error) {
      cause = error;
    }
  }
  if (cause) {
    const error = new Error(`LLM budget ledger lock acquisition failed: ${cause?.message || cause}`);
    error.code = 'llm_budget_ledger_lock_failed';
    error.cause = cause;
    throw error;
  }
  try {
    return fn();
  } finally {
    try { release(); } catch {}
  }
}

function snapshot(doc, config = null) {
  const configuredToken = config?.subjectTokenBudget ?? doc.token_budget;
  const configuredSpendMicros = config
    ? usdToMicros(config.subjectSpendBudgetUsd)
    : doc.spend_budget_usd_micros;
  return {
    version: doc.version,
    subject_key: doc.subject_key,
    period_id: doc.period_id || LLM_BUDGET_LEGACY_PERIOD_ID,
    period_opened_at: doc.period_opened_at ?? null,
    cycle_admission: doc.cycle_admission === 'parked' ? 'parked' : 'open',
    token_budget: doc.token_budget,
    used_tokens: doc.used_tokens,
    reserved_tokens: doc.reserved_tokens,
    remaining_tokens: Math.max(0, doc.token_budget - doc.used_tokens - doc.reserved_tokens),
    spend_budget_usd: microsToUsd(doc.spend_budget_usd_micros),
    spent_usd: microsToUsd(doc.spent_usd_micros),
    reserved_usd: microsToUsd(doc.reserved_usd_micros),
    remaining_spend_usd: microsToUsd(Math.max(
      0,
      doc.spend_budget_usd_micros - doc.spent_usd_micros - doc.reserved_usd_micros,
    )),
    configured_token_budget: configuredToken,
    configured_spend_budget_usd: microsToUsd(configuredSpendMicros),
    operator_token_ceiling: Number.isSafeInteger(doc.operator_token_ceiling)
      ? doc.operator_token_ceiling
      : null,
    operator_spend_ceiling_usd: Number.isSafeInteger(doc.operator_spend_ceiling_usd_micros)
      ? microsToUsd(doc.operator_spend_ceiling_usd_micros)
      : null,
    calls: doc.calls,
    open_reservations: Object.keys(doc.reservations).length,
    updated_at: doc.updated_at,
  };
}

function appendEvent(doc, event) {
  doc.events.push({
    audit_id: `llm-budget-${randomUUID()}`,
    recorded_at: new Date().toISOString(),
    ...event,
  });
  doc.updated_at = new Date().toISOString();
}

export function llmBudgetLedgerPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', LLM_BUDGET_LEDGER_FILENAME);
}

export function resolveTokenBudgetConfig(env = process.env) {
  const inputPricePerMillionUsd = configuredDecimal(
    env,
    ['JEA_LLM_INPUT_PRICE_PER_MILLION_USD'],
    DEFAULT_INPUT_PRICE_PER_MILLION_USD,
    { minExclusive: 0, max: MAX_PRICE_PER_MILLION_USD },
  );
  const cacheHitPricePerMillionUsd = configuredDecimal(
    env,
    ['JEA_LLM_CACHE_HIT_PRICE_PER_MILLION_USD'],
    DEFAULT_CACHE_HIT_PRICE_PER_MILLION_USD,
    { minInclusive: 0, max: MAX_PRICE_PER_MILLION_USD },
  );
  if (cacheHitPricePerMillionUsd > inputPricePerMillionUsd) {
    throw configError(
      'JEA_LLM_CACHE_HIT_PRICE_PER_MILLION_USD',
      'a value no greater than JEA_LLM_INPUT_PRICE_PER_MILLION_USD',
      'llm_spend_budget_config_invalid',
    );
  }
  return {
    subjectTokenBudget: configuredPositiveInt(
      env,
      ['JEA_LLM_SUBJECT_TOKEN_BUDGET', 'JEA_LLM_PROCESS_TOKEN_BUDGET', 'JEA_LLM_TOKEN_BUDGET'],
      DEFAULT_SUBJECT_TOKEN_BUDGET,
      MAX_CONFIGURED_TOKENS,
    ),
    requestMaxTokens: configuredPositiveInt(
      env,
      ['JEA_LLM_REQUEST_MAX_TOKENS', 'JEA_LLM_MAX_TOKENS'],
      DEFAULT_REQUEST_MAX_TOKENS,
      DEFAULT_REQUEST_MAX_TOKENS,
    ),
    subjectSpendBudgetUsd: configuredDecimal(
      env,
      ['JEA_LLM_SUBJECT_SPEND_BUDGET_USD', 'JEA_LLM_SPEND_BUDGET_USD'],
      DEFAULT_SUBJECT_SPEND_BUDGET_USD,
      { minExclusive: 0, max: MAX_BUDGET_USD },
    ),
    pricing: {
      currency: 'USD',
      unit_tokens: 1_000_000,
      input_per_million_usd: inputPricePerMillionUsd,
      cache_hit_per_million_usd: cacheHitPricePerMillionUsd,
      output_per_million_usd: configuredDecimal(
        env,
        ['JEA_LLM_OUTPUT_PRICE_PER_MILLION_USD'],
        DEFAULT_OUTPUT_PRICE_PER_MILLION_USD,
        { minExclusive: 0, max: MAX_PRICE_PER_MILLION_USD },
      ),
      source: 'configured_estimate',
    },
  };
}

export function estimatePromptTokens(messages, tools = null) {
  // Deliberately conservative without coupling the gateway to a model tokenizer:
  // one Unicode code point is reserved as one token, plus serialized tool schema.
  const serialized = JSON.stringify({ messages: messages ?? [], tools: tools ?? [] });
  return Math.max(1, Array.from(serialized).length);
}

function requestedMaxTokens(value, configuredMax) {
  if (value == null) return configuredMax;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    const error = new Error('Invalid requested max tokens: expected a positive integer');
    error.code = 'llm_request_max_tokens_invalid';
    throw error;
  }
  return Math.min(parsed, configuredMax);
}

function estimatedReservationCostMicros(promptTokens, completionTokens, pricing) {
  return costMicros(promptTokens, pricing.input_per_million_usd)
    + costMicros(completionTokens, pricing.output_per_million_usd);
}

function actualCostMicros(usage, pricing, fallbackMicros) {
  const summary = summarizeLlmUsage(usage);
  if (!summary) return { micros: fallbackMicros, summary: null, estimated: true };
  const promptRaw = Number(summary.prompt_tokens);
  const completionRaw = Number(summary.completion_tokens);
  const totalRaw = Number(summary.total_tokens);
  if (!Number.isFinite(promptRaw) || (!Number.isFinite(completionRaw) && !Number.isFinite(totalRaw))) {
    return { micros: fallbackMicros, summary, estimated: true };
  }
  const prompt = Math.max(0, Math.trunc(promptRaw));
  const completion = Number.isFinite(completionRaw)
    ? Math.max(0, Math.trunc(completionRaw))
    : Math.max(0, Math.trunc(totalRaw) - prompt);
  const cacheHit = Math.min(prompt, Math.max(0, Math.trunc(Number(summary.cache_hit_tokens) || 0)));
  const cacheMiss = Math.max(0, prompt - cacheHit);
  return {
    micros: costMicros(cacheMiss, pricing.input_per_million_usd)
      + costMicros(cacheHit, pricing.cache_hit_per_million_usd)
      + costMicros(completion, pricing.output_per_million_usd),
    summary,
    estimated: false,
  };
}

export function reserveTokenBudget({
  subjectKey,
  ledgerPath,
  messages,
  tools = null,
  requestedMaxTokens: requested = null,
  model = null,
  provider = 'deepseek',
  env = process.env,
  emit = null,
} = {}) {
  const key = requiredSubjectKey(subjectKey);
  const filePath = requiredLedgerPath(ledgerPath);
  const config = resolveTokenBudgetConfig(env);
  const maxTokens = requestedMaxTokens(requested, config.requestMaxTokens);
  const promptEstimate = estimatePromptTokens(messages, tools);
  const reservedTokens = promptEstimate + maxTokens;
  const reservedCostMicros = estimatedReservationCostMicros(
    promptEstimate,
    maxTokens,
    config.pricing,
  );
  let emitted;
  const result = withLedgerLock(filePath, () => {
    const doc = readLedger(filePath, key, config);
    const state = snapshot(doc, config);
    if (reservedTokens > state.remaining_tokens) {
      emitted = {
        type: 'llm_token_budget_exhausted',
        subject: key,
        subject_key: key,
        provider,
        model,
        ...state,
        requested_tokens: reservedTokens,
        request_max_tokens: maxTokens,
        prompt_tokens_estimated: promptEstimate,
      };
      appendEvent(doc, emitted);
      writeLedger(filePath, doc);
      return { exhausted: true, code: emitted.type, event: emitted };
    }
    if (reservedCostMicros > Math.round(state.remaining_spend_usd * USD_MICROS)) {
      emitted = {
        type: 'llm_spend_budget_exhausted',
        subject: key,
        subject_key: key,
        provider,
        model,
        ...state,
        requested_cost_usd: microsToUsd(reservedCostMicros),
        requested_tokens: reservedTokens,
        request_max_tokens: maxTokens,
        prompt_tokens_estimated: promptEstimate,
        pricing: config.pricing,
      };
      appendEvent(doc, emitted);
      writeLedger(filePath, doc);
      return { exhausted: true, code: emitted.type, event: emitted };
    }
    const reservationId = `llm-reserve-${randomUUID()}`;
    doc.reserved_tokens += reservedTokens;
    doc.reserved_usd_micros += reservedCostMicros;
    doc.reservations[reservationId] = {
      reservation_id: reservationId,
      created_at: new Date().toISOString(),
      provider,
      model,
      reserved_tokens: reservedTokens,
      reserved_cost_usd_micros: reservedCostMicros,
      prompt_tokens_estimated: promptEstimate,
      request_max_tokens: maxTokens,
      pricing: config.pricing,
    };
    emitted = {
      type: 'llm_budget_reserved',
      subject: key,
      subject_key: key,
      provider,
      model,
      reservation_id: reservationId,
      ...snapshot(doc, config),
      requested_tokens: reservedTokens,
      requested_cost_usd: microsToUsd(reservedCostMicros),
      request_max_tokens: maxTokens,
      prompt_tokens_estimated: promptEstimate,
      pricing: config.pricing,
    };
    appendEvent(doc, emitted);
    writeLedger(filePath, doc);
    return {
      reservationId,
      subjectKey: key,
      ledgerPath: filePath,
      reservedTokens,
      reservedCostMicros,
      maxTokens,
      promptEstimate,
      pricing: config.pricing,
      config,
    };
  });
  emit?.(emitted);
  if (result.exhausted) {
    const error = new Error(
      `${result.code} for ${key}: requested ${reservedTokens} tokens / `
      + `$${microsToUsd(reservedCostMicros)}`,
    );
    error.code = result.code;
    error.budget = result.event;
    throw error;
  }
  return result;
}

export function settleTokenBudget(reservation, usage, { emit = null, failed = false } = {}) {
  if (!reservation?.reservationId) return null;
  const { subjectKey, ledgerPath: filePath, config } = reservation;
  let event;
  withLedgerLock(filePath, () => {
    const doc = readLedger(filePath, subjectKey, config);
    const persisted = doc.reservations[reservation.reservationId];
    if (!persisted) {
      const error = new Error(`Unknown or already settled LLM reservation: ${reservation.reservationId}`);
      error.code = 'llm_budget_reservation_missing';
      throw error;
    }
    const usageSummary = summarizeLlmUsage(usage);
    const reportedTotal = Number(usageSummary?.total_tokens);
    const prompt = Number(usageSummary?.prompt_tokens);
    const completion = Number(usageSummary?.completion_tokens);
    const chargedTokens = Number.isFinite(reportedTotal) && reportedTotal >= 0
      ? Math.trunc(reportedTotal)
      : (Number.isFinite(prompt) && Number.isFinite(completion)
        ? Math.max(0, Math.trunc(prompt + completion))
        : persisted.reserved_tokens);
    const cost = actualCostMicros(usage, persisted.pricing, persisted.reserved_cost_usd_micros);
    doc.reserved_tokens = Math.max(0, doc.reserved_tokens - persisted.reserved_tokens);
    doc.reserved_usd_micros = Math.max(
      0,
      doc.reserved_usd_micros - persisted.reserved_cost_usd_micros,
    );
    doc.used_tokens += chargedTokens;
    doc.spent_usd_micros += cost.micros;
    doc.calls += 1;
    delete doc.reservations[reservation.reservationId];
    event = {
      type: 'llm_budget_settled',
      subject: subjectKey,
      subject_key: subjectKey,
      provider: persisted.provider,
      model: persisted.model,
      reservation_id: reservation.reservationId,
      ...snapshot(doc, config),
      charged_tokens: chargedTokens,
      charged_cost_usd: microsToUsd(cost.micros),
      usage_reported: usage != null,
      provider_usage: cost.summary,
      cost_estimated: cost.estimated,
      pricing: persisted.pricing,
      failed: Boolean(failed),
    };
    appendEvent(doc, event);
    writeLedger(filePath, doc);
  });
  emit?.(event);
  return event;
}

export function tokenBudgetSnapshot({
  subjectKey,
  ledgerPath,
  budgetLedgerPath = null,
  env = process.env,
} = {}) {
  const key = requiredSubjectKey(subjectKey);
  const filePath = requiredLedgerPath(ledgerPath ?? budgetLedgerPath);
  const config = resolveTokenBudgetConfig(env);
  return withLedgerLock(filePath, () => {
    const doc = readLedger(filePath, key, config);
    return existsSync(filePath) ? snapshot(doc, config) : null;
  });
}

function typicalReserveTokens(config) {
  return LLM_BUDGET_TYPICAL_PROMPT_RESERVE_TOKENS + config.requestMaxTokens;
}

function typicalReserveCostMicros(config) {
  return estimatedReservationCostMicros(
    LLM_BUDGET_TYPICAL_PROMPT_RESERVE_TOKENS,
    config.requestMaxTokens,
    config.pricing,
  );
}

function classifyBudgetState(snap, config) {
  const typicalTokens = typicalReserveTokens(config);
  const typicalCost = typicalReserveCostMicros(config);
  const remainingSpendMicros = Math.round(snap.remaining_spend_usd * USD_MICROS);
  const tokensExhausted = snap.remaining_tokens < typicalTokens;
  const spendExhausted = remainingSpendMicros < typicalCost;
  const warn = !tokensExhausted && !spendExhausted && (
    snap.remaining_tokens < typicalTokens * 2
    || snap.remaining_tokens < Math.ceil(snap.token_budget * 0.05)
  );
  let state = 'ok';
  if (tokensExhausted || spendExhausted) state = 'exhausted';
  else if (warn) state = 'warn';
  return {
    state,
    exhausted: { tokens: tokensExhausted, spend: spendExhausted },
    blocked_reason: tokensExhausted
      ? 'llm_token_budget_exhausted'
      : (spendExhausted ? 'llm_spend_budget_exhausted' : null),
    typical_reserve_tokens: typicalTokens,
    typical_reserve_cost_usd: microsToUsd(typicalCost),
  };
}

function statusNextActions(status) {
  const actions = [
    {
      id: 'status',
      command: 'jea llm budget status --json',
    },
  ];
  if (status.state === 'exhausted' || status.state === 'warn') {
    actions.push({
      id: 'raise_ceiling',
      command: 'jea llm budget raise --tokens N [--spend-usd X]',
    });
    actions.push({
      id: 'open_period',
      command: 'jea llm budget period-open [--cycle-admission parked|open]',
    });
  }
  actions.push({
    id: 'set_admission',
    command: 'jea llm budget set-admission --cycle-admission parked|open',
  });
  return actions;
}

export function llmBudgetReadinessView(status) {
  if (!status) return null;
  const token = status.token ?? {};
  const spend = status.spend ?? {};
  return {
    schema: LLM_BUDGET_STATUS_SCHEMA,
    period_id: status.period_id,
    state: status.state,
    used_tokens: token.used ?? status.used_tokens ?? 0,
    remaining_tokens: token.remaining ?? status.remaining_tokens ?? 0,
    token_budget: token.budget ?? status.token_budget ?? 0,
    used_spend_usd: spend.used_usd ?? status.used_spend_usd ?? 0,
    remaining_spend_usd: spend.remaining_usd ?? status.remaining_spend_usd ?? 0,
    spend_budget_usd: spend.budget_usd ?? status.spend_budget_usd ?? 0,
    cycle_admission: status.cycle_admission === 'parked' ? 'parked' : 'open',
    shared_ledger: true,
    blocked_reason: status.blocked_reason ?? null,
  };
}

export function inspectLlmBudget({
  subjectKey,
  ledgerPath,
  budgetLedgerPath = null,
  env = process.env,
} = {}) {
  const key = requiredSubjectKey(subjectKey);
  const filePath = requiredLedgerPath(ledgerPath ?? budgetLedgerPath);
  const config = resolveTokenBudgetConfig(env);
  return withLedgerLock(filePath, () => {
    const present = existsSync(filePath);
    const doc = present ? readLedger(filePath, key, config) : emptyLedger(key, config);
    const snap = snapshot(doc, config);
    const classified = classifyBudgetState(snap, config);
    const status = {
      schema: LLM_BUDGET_STATUS_SCHEMA,
      subject: key,
      ledger_present: present,
      shared_ledger: true,
      ledger_scope: 'subject',
      period_id: snap.period_id,
      period_opened_at: snap.period_opened_at,
      cycle_admission: snap.cycle_admission,
      state: classified.state,
      exhausted: classified.exhausted,
      token: {
        used: snap.used_tokens,
        reserved: snap.reserved_tokens,
        budget: snap.token_budget,
        remaining: snap.remaining_tokens,
        configured_budget: snap.configured_token_budget,
        operator_ceiling: snap.operator_token_ceiling,
      },
      spend: {
        used_usd: snap.spent_usd,
        reserved_usd: snap.reserved_usd,
        budget_usd: snap.spend_budget_usd,
        remaining_usd: snap.remaining_spend_usd,
        configured_budget_usd: snap.configured_spend_budget_usd,
        operator_ceiling_usd: snap.operator_spend_ceiling_usd,
      },
      calls: snap.calls,
      open_reservations: snap.open_reservations,
      reserve_estimate: {
        typical_prompt_tokens: LLM_BUDGET_TYPICAL_PROMPT_RESERVE_TOKENS,
        typical_completion_tokens: config.requestMaxTokens,
        typical_reserve_tokens: classified.typical_reserve_tokens,
        typical_reserve_cost_usd: classified.typical_reserve_cost_usd,
        note: 'pre-call reserve uses a conservative character-based estimate (~3-4x real prompt tokens)',
      },
      blocked_reason: classified.blocked_reason,
      updated_at: snap.updated_at,
    };
    status.next_actions = statusNextActions(status);
    return status;
  });
}

function operatorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireAdmission(value) {
  const admission = String(value ?? '').trim();
  if (!LLM_BUDGET_CYCLE_ADMISSIONS.includes(admission)) {
    throw operatorError(
      'llm_budget_cycle_admission_invalid',
      'cycle_admission must be open or parked',
    );
  }
  return admission;
}

function requireRaiseCeiling({ tokenCeiling, spendCeilingUsd, current }) {
  if (tokenCeiling == null && spendCeilingUsd == null) {
    throw operatorError(
      'llm_budget_raise_target_required',
      'raise requires --tokens and/or --spend-usd',
    );
  }
  if (tokenCeiling != null) {
    if (!Number.isSafeInteger(tokenCeiling) || tokenCeiling < 1 || tokenCeiling > MAX_CONFIGURED_TOKENS) {
      throw operatorError(
        'llm_budget_token_ceiling_invalid',
        `token ceiling must be an integer between 1 and ${MAX_CONFIGURED_TOKENS}`,
      );
    }
    if (tokenCeiling <= current.token_budget) {
      throw operatorError(
        'llm_budget_token_ceiling_not_raised',
        `token ceiling must be greater than the current effective ceiling (${current.token_budget})`,
      );
    }
    if (tokenCeiling <= current.used_tokens + current.reserved_tokens) {
      throw operatorError(
        'llm_budget_token_ceiling_below_used',
        'token ceiling must exceed used + reserved tokens',
      );
    }
  }
  if (spendCeilingUsd != null) {
    const micros = usdToMicros(spendCeilingUsd);
    const currentMicros = usdToMicros(current.spend_budget_usd);
    if (!Number.isFinite(spendCeilingUsd) || spendCeilingUsd <= 0 || spendCeilingUsd > MAX_BUDGET_USD) {
      throw operatorError(
        'llm_budget_spend_ceiling_invalid',
        `spend ceiling must be greater than 0 and at most ${MAX_BUDGET_USD}`,
      );
    }
    if (micros <= currentMicros) {
      throw operatorError(
        'llm_budget_spend_ceiling_not_raised',
        `spend ceiling must be greater than the current effective ceiling ($${current.spend_budget_usd})`,
      );
    }
    if (micros <= current.spent_usd_micros + current.reserved_usd_micros) {
      throw operatorError(
        'llm_budget_spend_ceiling_below_used',
        'spend ceiling must exceed used + reserved spend',
      );
    }
  }
}

function applyOperatorCeilings(doc, { tokenCeiling = null, spendCeilingUsd = null } = {}) {
  if (tokenCeiling != null) doc.operator_token_ceiling = tokenCeiling;
  if (spendCeilingUsd != null) doc.operator_spend_ceiling_usd_micros = usdToMicros(spendCeilingUsd);
}

function closedPeriodSummary(doc, { closedAt, reason }) {
  return {
    period_id: doc.period_id || LLM_BUDGET_LEGACY_PERIOD_ID,
    opened_at: doc.period_opened_at ?? null,
    closed_at: closedAt,
    used_tokens: doc.used_tokens,
    spent_usd: microsToUsd(doc.spent_usd_micros),
    calls: doc.calls,
    token_budget: doc.token_budget,
    spend_budget_usd: microsToUsd(doc.spend_budget_usd_micros),
    close_reason: reason,
  };
}

function mutateLedger({
  subjectKey,
  ledgerPath,
  env,
  emit,
  type,
  actor,
  reason,
  mutate,
}) {
  const key = requiredSubjectKey(subjectKey);
  const filePath = requiredLedgerPath(ledgerPath);
  const config = resolveTokenBudgetConfig(env);
  let emitted;
  const result = withLedgerLock(filePath, () => {
    const present = existsSync(filePath);
    const doc = present ? readLedger(filePath, key, config) : emptyLedger(key, config);
    const before = snapshot(doc, config);
    const mutation = mutate(doc, { config, before, present });
    applyOperatorCeilings(doc, mutation?.ceilings ?? {});
    if (mutation?.cycle_admission) doc.cycle_admission = mutation.cycle_admission;
    normalizeLedger(doc, config);
    const after = snapshot(doc, config);
    emitted = {
      type,
      subject: key,
      subject_key: key,
      actor: actor || 'operator',
      reason: reason || null,
      ...after,
      before,
      after,
      ...(mutation?.eventExtra ?? {}),
    };
    appendEvent(doc, emitted);
    writeLedger(filePath, doc);
    return {
      ok: true,
      action: type,
      subject: key,
      period_id: after.period_id,
      cycle_admission: after.cycle_admission,
      status: inspectUnlocked(doc, { key, config, present: true }),
      event: emitted,
    };
  });
  emit?.(emitted);
  return result;
}

function inspectUnlocked(doc, { key, config, present }) {
  const snap = snapshot(doc, config);
  const classified = classifyBudgetState(snap, config);
  const status = {
    schema: LLM_BUDGET_STATUS_SCHEMA,
    subject: key,
    ledger_present: present,
    shared_ledger: true,
    ledger_scope: 'subject',
    period_id: snap.period_id,
    period_opened_at: snap.period_opened_at,
    cycle_admission: snap.cycle_admission,
    state: classified.state,
    exhausted: classified.exhausted,
    token: {
      used: snap.used_tokens,
      reserved: snap.reserved_tokens,
      budget: snap.token_budget,
      remaining: snap.remaining_tokens,
      configured_budget: snap.configured_token_budget,
      operator_ceiling: snap.operator_token_ceiling,
    },
    spend: {
      used_usd: snap.spent_usd,
      reserved_usd: snap.reserved_usd,
      budget_usd: snap.spend_budget_usd,
      remaining_usd: snap.remaining_spend_usd,
      configured_budget_usd: snap.configured_spend_budget_usd,
      operator_ceiling_usd: snap.operator_spend_ceiling_usd,
    },
    calls: snap.calls,
    open_reservations: snap.open_reservations,
    reserve_estimate: {
      typical_prompt_tokens: LLM_BUDGET_TYPICAL_PROMPT_RESERVE_TOKENS,
      typical_completion_tokens: config.requestMaxTokens,
      typical_reserve_tokens: classified.typical_reserve_tokens,
      typical_reserve_cost_usd: classified.typical_reserve_cost_usd,
      note: 'pre-call reserve uses a conservative character-based estimate (~3-4x real prompt tokens)',
    },
    blocked_reason: classified.blocked_reason,
    updated_at: snap.updated_at,
  };
  status.next_actions = statusNextActions(status);
  return status;
}

export function raiseLlmBudgetCeiling({
  subjectKey,
  ledgerPath,
  tokenCeiling = null,
  spendCeilingUsd = null,
  cycleAdmission = null,
  reason = null,
  actor = 'operator',
  env = process.env,
  emit = null,
} = {}) {
  return mutateLedger({
    subjectKey,
    ledgerPath,
    env,
    emit,
    type: 'llm_budget_ceiling_raised',
    actor,
    reason,
    mutate(doc, { before }) {
      requireRaiseCeiling({
        tokenCeiling,
        spendCeilingUsd,
        current: {
          token_budget: before.token_budget,
          used_tokens: doc.used_tokens,
          reserved_tokens: doc.reserved_tokens,
          spend_budget_usd: before.spend_budget_usd,
          spent_usd_micros: doc.spent_usd_micros,
          reserved_usd_micros: doc.reserved_usd_micros,
        },
      });
      return {
        ceilings: { tokenCeiling, spendCeilingUsd },
        cycle_admission: cycleAdmission ? requireAdmission(cycleAdmission) : null,
      };
    },
  });
}

export function openLlmBudgetPeriod({
  subjectKey,
  ledgerPath,
  tokenCeiling = null,
  spendCeilingUsd = null,
  cycleAdmission = 'parked',
  reason = null,
  actor = 'operator',
  env = process.env,
  emit = null,
} = {}) {
  const admission = requireAdmission(cycleAdmission ?? 'parked');
  return mutateLedger({
    subjectKey,
    ledgerPath,
    env,
    emit,
    type: 'llm_budget_period_opened',
    actor,
    reason,
    mutate(doc, { before }) {
      if (Object.keys(doc.reservations || {}).length > 0) {
        throw operatorError(
          'llm_budget_open_reservations',
          'cannot open a new period while reservations are open',
        );
      }
      if (tokenCeiling != null || spendCeilingUsd != null) {
        const nextToken = tokenCeiling ?? before.token_budget;
        const nextSpend = spendCeilingUsd ?? before.spend_budget_usd;
        if (tokenCeiling != null) {
          if (!Number.isSafeInteger(tokenCeiling) || tokenCeiling < 1 || tokenCeiling > MAX_CONFIGURED_TOKENS) {
            throw operatorError(
              'llm_budget_token_ceiling_invalid',
              `token ceiling must be an integer between 1 and ${MAX_CONFIGURED_TOKENS}`,
            );
          }
        }
        if (spendCeilingUsd != null) {
          if (!Number.isFinite(spendCeilingUsd) || spendCeilingUsd <= 0 || spendCeilingUsd > MAX_BUDGET_USD) {
            throw operatorError(
              'llm_budget_spend_ceiling_invalid',
              `spend ceiling must be greater than 0 and at most ${MAX_BUDGET_USD}`,
            );
          }
        }
        if (nextToken < 1 || nextSpend <= 0) {
          throw operatorError('llm_budget_period_ceiling_invalid', 'new period ceilings must be positive');
        }
      }
      const closedAt = new Date().toISOString();
      const closed = closedPeriodSummary(doc, {
        closedAt,
        reason: reason || 'period_open',
      });
      doc.previous_periods = [...doc.previous_periods, closed]
        .slice(-LLM_BUDGET_PREVIOUS_PERIODS_MAX);
      const openedAt = new Date().toISOString();
      doc.period_id = newPeriodId();
      doc.period_opened_at = openedAt;
      doc.used_tokens = 0;
      doc.spent_usd_micros = 0;
      doc.calls = 0;
      return {
        ceilings: { tokenCeiling, spendCeilingUsd },
        cycle_admission: admission,
        eventExtra: {
          previous_period: closed,
          opened_period_id: doc.period_id,
        },
      };
    },
  });
}

export function shouldClearOperatorBudgetCircuit(result) {
  const admission = result?.cycle_admission
    ?? result?.status?.cycle_admission
    ?? result?.event?.cycle_admission;
  return admission === 'open';
}

export function setLlmBudgetCycleAdmission({
  subjectKey,
  ledgerPath,
  cycleAdmission,
  reason = null,
  actor = 'operator',
  env = process.env,
  emit = null,
} = {}) {
  const admission = requireAdmission(cycleAdmission);
  return mutateLedger({
    subjectKey,
    ledgerPath,
    env,
    emit,
    type: 'llm_budget_cycle_admission_set',
    actor,
    reason,
    mutate() {
      return { cycle_admission: admission };
    },
  });
}

// Kept for older tests/importers. Persistence means there is no process-global
// budget state to clear.
export function resetTokenBudgetsForTests() {}
