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

function emptyLedger(subjectKey, config) {
  return {
    version: LLM_BUDGET_LEDGER_VERSION,
    subject_key: subjectKey,
    token_budget: config.subjectTokenBudget,
    spend_budget_usd_micros: usdToMicros(config.subjectSpendBudgetUsd),
    used_tokens: 0,
    reserved_tokens: 0,
    spent_usd_micros: 0,
    reserved_usd_micros: 0,
    calls: 0,
    reservations: {},
    events: [],
    updated_at: new Date().toISOString(),
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
  // Configuration changes adjust the ceiling without resetting accumulated use.
  doc.token_budget = config.subjectTokenBudget;
  doc.spend_budget_usd_micros = usdToMicros(config.subjectSpendBudgetUsd);
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

function snapshot(doc) {
  return {
    version: doc.version,
    subject_key: doc.subject_key,
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
    const state = snapshot(doc);
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
      ...snapshot(doc),
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
      ...snapshot(doc),
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
    return existsSync(filePath) ? snapshot(doc) : null;
  });
}

// Kept for older tests/importers. Persistence means there is no process-global
// budget state to clear.
export function resetTokenBudgetsForTests() {}
