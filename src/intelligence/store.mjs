import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
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
  extractBeliefContext,
  validateActionReceipt,
  validateBeliefEvent,
  validateEvolutionEvent,
  validateGoalEvent,
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

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function acquireSyncLock(target) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let lastError;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return lockfile.lockSync(target, { stale: 5 * 60 * 1000 });
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ELOCKED') throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  throw lastError;
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
    const beliefContext = extractBeliefContext(action);
    const record = withId({
      recorded_at: new Date().toISOString(),
      cycle_id: ctx.cycleId ?? ctx.executionId ?? null,
      exec_cycle_id: ctx.execCycleId ?? ctx.executionId ?? ctx.cycleId ?? null,
      intel_cycle_id: ctx.intelCycleId ?? action?.intel_cycle_id ?? action?.cycle_id ?? action?.cycleId ?? null,
      decision_id: ctx.decisionId ?? action?.decision_id ?? action?.id ?? null,
      execution_id: ctx.executionId ?? ctx.execCycleId ?? ctx.cycleId ?? null,
      producer_batch_id: ctx.producer_batch_id ?? ctx.producerBatchId ?? null,
      reaction_id: ctx.reaction_id ?? ctx.reactionId ?? null,
      belief_id: ctx.belief_id
        ?? ctx.beliefId
        ?? beliefContext.belief_id
        ?? null,
      belief_relation: beliefContext.belief_relation ?? null,
      expected_belief_claim: beliefContext.expected_belief_claim ?? null,
      expected_belief_update: beliefContext.expected_belief_update ?? null,
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
    const record = withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'goal-event');
    handleContractValidation('goal_event', validateGoalEvent(record), {
      logger: this.engine?.logger ?? null,
    });
    return this.engine.ingest('goal_events', redactSecrets(record));
  }

  readGoalEvents({ limit = 20 } = {}) {
    return limit == null
      ? this.engine.readSource('goal_events')
      : this.engine.readSource('goal_events', { limit });
  }

  readActionReceipts({ limit = 20 } = {}) {
    return limit == null
      ? this.engine.readSource('action_receipts')
      : this.engine.readSource('action_receipts', { limit });
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
    return limit == null
      ? this.engine.readSource('belief_events')
      : this.engine.readSource('belief_events', { limit });
  }

  recordBeliefEvent(event) {
    const record = withId({
      recorded_at: new Date().toISOString(),
      ...event,
      type: event?.type ?? event?.change ?? 'updated',
    }, 'belief-event');
    handleContractValidation('belief_event', validateBeliefEvent(record), {
      logger: this.engine?.logger ?? null,
    });
    return this.engine.ingest('belief_events', redactSecrets(record));
  }

  /**
   * Subject-scoped belief transaction. Append-only events are authoritative;
   * current_beliefs is rebuilt from the prepared snapshot while the same lock
   * excludes other projection writers.
   */
  commitBeliefEffect({
    settlement,
    prepare = null,
    faultInjector = null,
  } = {}) {
    const settlementId = settlement?.settlement_id;
    if (!settlementId) throw new Error('belief effect requires settlement_id');
    const lockTarget = join(this.engine.baseDir, '.subject-belief.lock');
    if (!existsSync(lockTarget)) writeFileSync(lockTarget, '', 'utf8');
    const release = acquireSyncLock(lockTarget);
    const inject = (boundary, details = {}) => faultInjector?.(boundary, details);
    try {
      let all = this.readBeliefEvents({ limit: null });
      let prepared = all.find((event) => (
        event?.type === 'settlement_prepare'
        && event?.settlement_id === settlementId
        && event?.settlement_effect === 'belief'
      ));
      let newlyPrepared = false;
      if (!prepared) {
        if (typeof prepare !== 'function') return null;
        const plan = prepare(this.readCurrentBeliefs());
        const effectId = `belief-effect-${digest(settlementId).slice(0, 24)}`;
        const plannedEvents = (plan?.events ?? []).map((event, index) => ({
          ...JSON.parse(JSON.stringify(event)),
          id: `belief-effect-${digest([settlementId, index]).slice(0, 24)}`,
          effect_id: effectId,
          settlement_id: settlementId,
          settlement_effect: 'belief',
        }));
        const expectedIds = plannedEvents.map((event) => event.id);
        prepared = {
          id: `belief-prepare-${digest(settlementId).slice(0, 24)}`,
          type: 'settlement_prepare',
          change: 'settlement_prepare',
          settlement_id: settlementId,
          settlement_effect: 'belief',
          effect_id: effectId,
          execution_id: settlement.execution_id ?? null,
          expected_event_ids: expectedIds,
          expected_event_digest: digest(expectedIds),
          planned_events: plannedEvents,
          projected_current_beliefs: JSON.parse(JSON.stringify(plan.currentBeliefs)),
          effect_result: plan.effectResult == null
            ? null
            : JSON.parse(JSON.stringify(plan.effectResult)),
        };
        this.recordBeliefEvent(prepared);
        all = [...all, prepared];
        newlyPrepared = true;
        inject('belief_after_prepare', { settlement_id: settlementId });
      }

      const byId = new Map(all.filter((event) => event?.id).map((event) => [event.id, event]));
      const expectedIds = Array.isArray(prepared.expected_event_ids) ? prepared.expected_event_ids : [];
      if (prepared.expected_event_digest !== digest(expectedIds)) {
        throw new Error('belief_effect_prepare_digest_mismatch');
      }
      for (const event of prepared.planned_events ?? []) {
        if (byId.has(event.id)) continue;
        this.recordBeliefEvent(event);
        byId.set(event.id, event);
        inject('belief_after_event', { event_id: event.id });
      }
      if (expectedIds.some((id) => !byId.has(id))) {
        throw new Error('belief_effect_events_incomplete');
      }

      this.recordCurrentBeliefs(prepared.projected_current_beliefs);
      inject('belief_after_projection', { settlement_id: settlementId });

      const commitId = `belief-commit-${digest(settlementId).slice(0, 24)}`;
      let commit = byId.get(commitId);
      if (!commit) {
        commit = {
          id: commitId,
          type: 'settlement_commit',
          change: 'settlement_commit',
          settlement_id: settlementId,
          settlement_effect: 'belief',
          effect_id: prepared.effect_id,
          execution_id: settlement.execution_id ?? null,
          expected_event_ids: expectedIds,
          expected_event_digest: prepared.expected_event_digest,
          effect_result: prepared.effect_result ?? null,
        };
        this.recordBeliefEvent(commit);
        inject('belief_after_commit', { settlement_id: settlementId });
      }
      return {
        currentBeliefs: prepared.projected_current_beliefs,
        eventsWritten: newlyPrepared ? expectedIds.length : 0,
        result: prepared.effect_result,
        authoritativeEventIds: expectedIds,
        reused: !newlyPrepared,
      };
    } finally {
      release();
    }
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

