/**
 * Durable exec intents: write before a side effect, complete after the handler
 * returns. Crash recovery can see intended-but-uncompleted actions.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  EXEC_INTENT_STATUSES,
  execIntentKey,
  extractBeliefContext,
  handleContractValidation,
  validateExecIntent,
} from '../../contracts/index.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import { reactorDir } from './paths.mjs';

const OPEN_STATUSES = Object.freeze(['prepared', 'executing', 'receipt_recorded']);
const LEGACY_OPEN = Object.freeze(['intended']);

export function execIntentsPath(dataRoot) {
  return join(reactorDir(dataRoot), 'exec-intents.json');
}

function emptyStore() {
  return { intents: [], updated_at: null };
}

function normalizeStatus(status) {
  if (status === 'intended') return 'prepared';
  return EXEC_INTENT_STATUSES.includes(status) ? status : 'prepared';
}

function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status) || LEGACY_OPEN.includes(status);
}

export function readExecIntents(dataRoot) {
  const raw = readJson(execIntentsPath(dataRoot), emptyStore());
  return {
    intents: Array.isArray(raw?.intents) ? raw.intents : [],
    updated_at: raw?.updated_at ?? null,
  };
}

function writeStore(dataRoot, updater) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
  const file = execIntentsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  return updateJson(file, (raw) => {
    const store = {
      intents: Array.isArray(raw?.intents) ? raw.intents : [],
      updated_at: raw?.updated_at ?? null,
    };
    const next = updater(store) ?? store;
    next.updated_at = nowIso();
    return next;
  }, { fallback: emptyStore() });
}

export function beginExecIntent(dataRoot, {
  executionId,
  decisionId = null,
  attempt = 1,
  action = {},
  source = 'exec_queue',
  causalIdentity = {},
} = {}) {
  if (!dataRoot) throw new Error('beginExecIntent requires dataRoot');
  const resolvedDecisionId = decisionId || action?.decision_id || action?.id || null;
  const key = execIntentKey(resolvedDecisionId || executionId || 'unknown', attempt);
  let intent = null;
  writeStore(dataRoot, (store) => {
    const uncertain = store.intents.find((item) => item.key === key && item.status === 'uncertain');
    if (uncertain) {
      intent = { ...uncertain, blocked: true };
      return store;
    }
    const existing = store.intents.find((item) => item.key === key && isOpenStatus(item.status));
    if (existing) {
      if (existing.status === 'prepared' || existing.status === 'intended') {
        existing.execution_id = existing.execution_id || executionId;
        existing.source = source;
        existing.producer_batch_id = existing.producer_batch_id
          || causalIdentity.producer_batch_id
          || null;
        existing.reaction_id = existing.reaction_id || causalIdentity.reaction_id || null;
        existing.belief_id = existing.belief_id
          || causalIdentity.belief_id
          || extractBeliefContext(action).belief_id
          || null;
      }
      intent = existing;
      return store;
    }
    intent = {
      id: `intent-${randomUUID().slice(0, 12)}`,
      key,
      execution_id: executionId || null,
      decision_id: resolvedDecisionId,
      action_id: action?.id || resolvedDecisionId,
      action_type: action?.type || 'unknown',
      attempt: Math.max(1, Math.floor(Number(attempt) || 1)),
      status: 'prepared',
      source,
      producer: 'exec',
      producer_batch_id: causalIdentity.producer_batch_id ?? null,
      reaction_id: causalIdentity.reaction_id ?? null,
      belief_id: causalIdentity.belief_id
        ?? extractBeliefContext(action).belief_id
        ?? null,
      created_at: nowIso(),
      completed_at: null,
      last_error: null,
    };
    handleContractValidation('exec_intent', validateExecIntent(intent));
    store.intents.push(intent);
    return store;
  });
  return intent;
}

export function markExecIntent(dataRoot, intentId, {
  status = 'completed',
  error = null,
  receiptId = null,
} = {}) {
  if (!dataRoot || !intentId) return null;
  const nextStatus = normalizeStatus(status);
  let updated = null;
  writeStore(dataRoot, (store) => {
    const intent = store.intents.find((item) => item.id === intentId || item.key === intentId);
    if (!intent) return store;
    intent.status = nextStatus;
    if (error != null) intent.last_error = error;
    if (receiptId) intent.receipt_id = receiptId;
    if (['completed', 'failed', 'uncertain'].includes(nextStatus)) {
      intent.completed_at = nowIso();
    }
    updated = intent;
    return store;
  });
  return updated;
}

export function completeExecIntent(dataRoot, intentId, {
  status = 'completed',
  error = null,
} = {}) {
  return markExecIntent(dataRoot, intentId, { status, error });
}

export function listOpenExecIntents(dataRoot, { executionId = null } = {}) {
  return readExecIntents(dataRoot).intents.filter((intent) => (
    isOpenStatus(intent.status)
    && (!executionId || intent.execution_id === executionId)
  ));
}

export function listUncertainExecIntents(dataRoot) {
  return readExecIntents(dataRoot).intents.filter((intent) => intent.status === 'uncertain');
}

export function recoverOpenExecIntents(dataRoot, {
  store = null,
  decisionQueue = null,
  executionId = null,
  recoveryPolicies = null,
} = {}) {
  if (!dataRoot) return { recovered: [], uncertain: [], retryable: [] };
  const recovered = [];
  const uncertain = [];
  const retryable = [];
  const receipts = store?.readActionReceipts?.({ limit: 500 }) || [];
  for (const intent of listOpenExecIntents(dataRoot, { executionId })) {
    const match = receipts.find((receipt) => (
      (intent.decision_id && receipt.decision_id === intent.decision_id)
      && (
        !intent.execution_id
        || receipt.exec_cycle_id === intent.execution_id
        || receipt.cycle_id === intent.execution_id
      )
    ));
    if (match) {
      markExecIntent(dataRoot, intent.id, {
        status: 'completed',
        receiptId: match.id,
      });
      if (intent.decision_id && decisionQueue?.completeDecision) {
        try {
          decisionQueue.completeDecision(intent.decision_id, 'recovered from receipt');
        } catch {
          // decision may already be completed
        }
      }
      recovered.push({ ...intent, status: 'completed', receipt_id: match.id });
      continue;
    }
    if (intent.status === 'prepared' || intent.status === 'intended') {
      if (intent.decision_id && decisionQueue?.updateStatus) {
        try {
          decisionQueue.updateStatus(intent.decision_id, 'pending', 'exec_intent_prepared_recovery');
        } catch {
          // decision may already have been recovered by another worker
        }
      }
      retryable.push(intent);
      continue;
    }
    const policy = recoveryPolicies?.[intent.action_type] ?? null;
    let reconciled = null;
    if (typeof policy?.reconcile === 'function') {
      try {
        reconciled = policy.reconcile(intent);
      } catch {
        reconciled = null;
      }
    }
    if (reconciled?.status === 'completed' || reconciled?.completed === true) {
      markExecIntent(dataRoot, intent.id, {
        status: 'completed',
        receiptId: reconciled.receipt_id ?? null,
      });
      if (intent.decision_id && decisionQueue?.completeDecision) {
        try {
          decisionQueue.completeDecision(intent.decision_id, 'recovered by action reconciler');
        } catch {
          // decision may already be completed
        }
      }
      recovered.push({ ...intent, status: 'completed', reconciled: true });
      continue;
    }
    if (
      policy?.idempotent === true
      || reconciled?.status === 'not_started'
      || reconciled?.safe_to_retry === true
    ) {
      markExecIntent(dataRoot, intent.id, {
        status: 'prepared',
        error: 'safe_recovery_retry',
      });
      if (intent.decision_id && decisionQueue?.updateStatus) {
        try {
          decisionQueue.updateStatus(intent.decision_id, 'pending', 'exec_intent_safe_recovery');
        } catch {
          // decision may already have been recovered by another worker
        }
      }
      retryable.push({ ...intent, status: 'prepared' });
      continue;
    }
    markExecIntent(dataRoot, intent.id, {
      status: 'uncertain',
      error: 'side_effect_uncertain',
    });
    if (intent.decision_id && decisionQueue?.updateStatus) {
      try {
        decisionQueue.updateStatus(intent.decision_id, 'blocked', 'exec_intent_uncertain');
      } catch {
        // keep going
      }
    }
    uncertain.push({ ...intent, status: 'uncertain' });
  }
  return { recovered, uncertain, retryable };
}
