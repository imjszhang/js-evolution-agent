import { randomUUID } from 'node:crypto';
import {
  DataSourceRegistry,
  StorageEngine,
} from 'js-intel-store';
import { INTELLIGENCE_SPECS } from './specs.mjs';
import { redactSecrets } from './redaction.mjs';
import {
  prioritizeActiveOperatorFacts,
  readPendingOperatorFacts,
} from './operator-facts.mjs';
import {
  handleContractValidation,
  validateActionReceipt,
  validateEvolutionEvent,
} from '../contracts/index.mjs';

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function id(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function withId(record, prefix) {
  return {
    id: record?.id ?? id(prefix),
    ...record,
  };
}

function formatList(title, records, render) {
  if (!records?.length) return `${title}: none`;
  const lines = records.slice(0, 8).map(render);
  return `${title}:\n${lines.join('\n')}`;
}

/**
 * Overlay delivery-outcome status records onto deliverable index records.
 *
 * The index is append-only (one record per deliverable, written with
 * `delivery_status: pending`); actual send results land later in a separate
 * append-only status source. This merges the latest status per delivery item
 * onto each deliverable so readers see the true `sent`/`failed`/`partial` state
 * without mutating the append-only index. Pure / side-effect free.
 *
 * @param {Array<object>} deliverables
 * @param {Array<object>} statuses
 * @returns {Array<object>}
 */
export function mergeDeliverableDeliveryStatus(deliverables = [], statuses = []) {
  if (!Array.isArray(deliverables) || !deliverables.length) return deliverables;
  if (!Array.isArray(statuses) || !statuses.length) return deliverables;

  const byDeliverable = new Map();
  for (const status of statuses) {
    const deliverableId = status?.deliverable_id;
    if (!deliverableId) continue;
    let items = byDeliverable.get(deliverableId);
    if (!items) {
      items = new Map();
      byDeliverable.set(deliverableId, items);
    }
    // Append order is chronological, so a later record for the same item wins.
    items.set(status.item_index ?? 0, status);
  }

  return deliverables.map((deliverable) => {
    const items = byDeliverable.get(deliverable?.deliverable_id);
    if (!items || !items.size) return deliverable;
    const list = [...items.values()];
    const anySent = list.some((s) => s.delivery_status === 'sent');
    const anyFailed = list.some((s) => s.delivery_status === 'failed');
    const overall = anyFailed && anySent
      ? 'partial'
      : anyFailed
        ? 'failed'
        : anySent
          ? 'sent'
          : deliverable.delivery_status;
    const sentItems = list.filter((s) => s.delivery_status === 'sent');
    const primary = sentItems.find((s) => s.delivery_format === 'document')
      ?? sentItems[0]
      ?? list[list.length - 1];
    const lastFailed = [...list].reverse().find((s) => s.delivery_status === 'failed');
    return {
      ...deliverable,
      delivery_status: overall,
      delivery_channel: primary?.delivery_channel ?? deliverable.delivery_channel ?? null,
      delivery_format: primary?.delivery_format ?? deliverable.delivery_format ?? null,
      delivery_message_id: primary?.delivery_message_id ?? deliverable.delivery_message_id ?? null,
      delivery_error: anyFailed ? (lastFailed?.error ?? null) : null,
      delivery_updated_at: list[list.length - 1]?.recorded_at ?? null,
      delivery_items: list.map((s) => ({
        item_index: s.item_index ?? 0,
        medium: s.medium ?? null,
        status: s.delivery_status ?? null,
        format: s.delivery_format ?? null,
        message_id: s.delivery_message_id ?? null,
        error: s.error ?? null,
      })),
    };
  });
}

export class IntelligenceStore {
  constructor({
    baseDir,
    timezone = DEFAULT_TIMEZONE,
    logger = null,
  } = {}) {
    if (!baseDir) {
      throw new Error('IntelligenceStore requires an explicit baseDir. Use the active subject runtime data path.');
    }
    this.registry = new DataSourceRegistry().registerAll(INTELLIGENCE_SPECS);
    this.engine = new StorageEngine({
      baseDir,
      registry: this.registry,
      timezone,
      logger,
    });
  }

  ingestObservation(record) {
    const records = asArray(record).map((r) => withId({
      kind: 'observation',
      confidence: 'medium',
      tags: [],
      created_at: new Date().toISOString(),
      ...r,
    }, 'obs'));
    return this.engine.ingest('intel_observations', redactSecrets(records));
  }

  recordEvolutionEvent(event) {
    const record = withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'evt');
    handleContractValidation('evolution_event', validateEvolutionEvent(record), {
      logger: this.engine?.logger ?? null,
    });
    return this.engine.ingest('evolution_events', redactSecrets(record));
  }

  recordRetrospective(review) {
    const record = withId({
      recorded_at: new Date().toISOString(),
      ...review,
    }, 'retro');
    const safeRecord = redactSecrets(record);
    const written = this.engine.ingest('retrospectives', safeRecord);
    this.engine.ingest('latest_review', safeRecord);
    return written;
  }

  recordActionReceipt(action, result, ctx = {}) {
    const record = withId({
      recorded_at: new Date().toISOString(),
      cycle_id: ctx.cycleId ?? ctx.executionId ?? null,
      exec_cycle_id: ctx.execCycleId ?? ctx.executionId ?? ctx.cycleId ?? null,
      intel_cycle_id: ctx.intelCycleId ?? action?.intel_cycle_id ?? action?.cycle_id ?? action?.cycleId ?? null,
      decision_id: ctx.decisionId ?? action?.decision_id ?? action?.id ?? null,
      action_id: action?.id ?? ctx.actionId ?? null,
      action_type: action?.type ?? 'unknown',
      intent_id: ctx.intentId ?? null,
      idempotency_key: ctx.idempotencyKey ?? null,
      producer: ctx.producer ?? 'exec',
      activation_targets: ctx.activation_targets ?? ['cognitive', 'rule'],
      action,
      result,
    }, 'receipt');
    handleContractValidation('action_receipt', validateActionReceipt(record), {
      logger: this.engine?.logger ?? null,
    });
    return this.engine.ingest('action_receipts', redactSecrets(record));
  }

  recordProbeEvent(probeId, event) {
    return this.engine.ingest('probe_threads', redactSecrets(withId({
      _entity_id: probeId,
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'probe-event')));
  }

  recordProbeResult(result) {
    return this.engine.ingest('probe_results', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      producer: result?.producer ?? 'external',
      activation_targets: result?.activation_targets ?? ['cognitive', 'rule'],
      ...result,
    }, 'probe-result')));
  }

  ingest(source, records) {
    return this.engine.ingest(source, redactSecrets(asArray(records)));
  }

  listSourceNames() {
    return INTELLIGENCE_SPECS.map((spec) => spec.name);
  }

  recordIntelReport(record) {
    return this.engine.ingest('intel_reports', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...record,
    }, 'report')));
  }

  readIntelReports({ limit = 20 } = {}) {
    return this.engine.readSource('intel_reports', { limit });
  }

  readLatestIntelReport() {
    const records = this.readIntelReports({ limit: 1 });
    return records?.[0] ?? null;
  }

  recordChannelDeliverable(record) {
    return this.engine.ingest('channel_deliverables', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...record,
    }, 'deliverable')));
  }

  recordChannelDeliverableStatus(record) {
    return this.engine.ingest('channel_deliverable_status', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...record,
    }, 'deliverable-status')));
  }

  readChannelDeliverableStatuses({ limit = 500 } = {}) {
    return this.engine.readSource('channel_deliverable_status', { limit });
  }

  readChannelDeliverables({ limit = 20, mergeStatus = true, statusLimit = 500 } = {}) {
    const records = this.engine.readSource('channel_deliverables', { limit });
    if (!mergeStatus) return records;
    const statuses = this.engine.readSource('channel_deliverable_status', { limit: statusLimit });
    return mergeDeliverableDeliveryStatus(records, statuses);
  }

  recordGoalEvent(event) {
    return this.engine.ingest('goal_events', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'goal-event')));
  }

  readGoalEvents({ limit = 20 } = {}) {
    return this.engine.readSource('goal_events', { limit });
  }

  readActionReceipts({ limit = 20 } = {}) {
    return this.engine.readSource('action_receipts', { limit });
  }

  readProbeThreads({ entity_id = null } = {}) {
    return entity_id
      ? this.engine.readSource('probe_threads', { entity_id })
      : this.engine.readSource('probe_threads');
  }

  readStandingMemory() {
    return this.engine.readSource('standing_memory');
  }

  recordStandingMemory(memory) {
    return this.engine.ingest('standing_memory', redactSecrets({
      source: 'report_builder',
      ...memory,
    }));
  }

  recordClaimLedgerEntry(entry) {
    return this.engine.ingest('claim_ledger', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      status: 'unverified',
      evidence_refs: [],
      ...entry,
    }, 'claim')));
  }

  readClaimLedger({ limit = 50 } = {}) {
    return this.engine.readSource('claim_ledger', { limit });
  }

  readCurrentBeliefs() {
    return this.engine.readSource('current_beliefs');
  }

  recordCurrentBeliefs(beliefs) {
    return this.engine.ingest('current_beliefs', redactSecrets({
      source: 'belief_updater',
      ...beliefs,
    }));
  }

  readBeliefEvents({ limit = 50 } = {}) {
    return this.engine.readSource('belief_events', { limit });
  }

  recordBeliefEvent(event) {
    return this.engine.ingest('belief_events', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'belief-event')));
  }

  readRecentIntel({ days = 7, limit = 20 } = {}) {
    return this.engine.readSource('intel_observations', { days }).slice(0, limit);
  }

  readEvolutionEvents({ limit = 20 } = {}) {
    return this.engine.readSource('evolution_events', { limit });
  }

  readProbeResults({ limit = 8 } = {}) {
    return this.engine.readSource('probe_results', { limit });
  }

  readRetrospectives({ limit = 10 } = {}) {
    return this.engine.readSource('retrospectives', { limit });
  }

  readLatestReview() {
    return this.engine.readSource('latest_review');
  }

  cleanup() {
    return this.engine.cleanupAllSources();
  }

  buildContextSummary({ runtimeRoot = null } = {}) {
    const pendingFacts = runtimeRoot
      ? readPendingOperatorFacts(runtimeRoot, { limit: 10 }).facts
      : [];
    const recent = this.readRecentIntel({ days: 7, limit: 50 });
    // Prefer pending seeds when runtimeRoot is known; otherwise keep legacy
    // observation-store operator facts visible in the summary.
    const observations = runtimeRoot
      ? prioritizeActiveOperatorFacts(recent, 20)
        .filter((r) => r?.kind !== 'operator_fact' && r?.source !== 'operator_fact')
      : prioritizeActiveOperatorFacts(recent, 20);
    const events = this.readEvolutionEvents({ limit: 8 });
    const probeResults = this.readProbeResults({ limit: 8 });
    const latestReview = this.readLatestReview();

    const sections = ['# js-evolution-agent intelligence summary'];
    if (runtimeRoot) {
      sections.push(formatList(
        'Pending operator fact seeds',
        pendingFacts,
        (r) => `- [operator_fact] ${r.subject ?? 'operator'}: ${r.content ?? r.summary ?? ''}`,
      ));
    }
    sections.push(
      formatList('Recent observations', observations, (r) => `- [${r.kind ?? 'observation'}] ${r.subject ?? r.source ?? 'unknown'}: ${r.content ?? r.summary ?? ''}`),
      formatList('Recent evolution events', events, (r) => `- [${r.type ?? 'event'}] ${r.action_type ?? r.target ?? 'unknown'}: ${r.result?.status ?? r.status ?? r.summary ?? ''}`),
      formatList('Recent probe results', probeResults, (r) => `- [${r.status ?? 'unknown'}] ${r.probe_type ?? 'probe'} ${r.target ?? ''}: ${r.summary ?? ''}`),
      `Latest review: ${latestReview?.summary ?? latestReview?.outcome ?? 'none'}`,
    );
    return sections.join('\n\n');
  }
}

export function createIntelligenceStore(opts = {}) {
  return new IntelligenceStore(opts);
}

