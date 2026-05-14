import { randomUUID } from 'node:crypto';
import {
  DataSourceRegistry,
  StorageEngine,
} from 'js-intel-store';
import { INTELLIGENCE_SPECS } from './specs.mjs';
import { redactSecrets } from './redaction.mjs';

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
    return this.engine.ingest('evolution_events', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'evt')));
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
    return this.engine.ingest('action_receipts', redactSecrets(withId({
      recorded_at: new Date().toISOString(),
      cycle_id: ctx.cycleId ?? null,
      exec_cycle_id: ctx.execCycleId ?? ctx.cycleId ?? null,
      intel_cycle_id: ctx.intelCycleId ?? action?.intel_cycle_id ?? action?.cycle_id ?? action?.cycleId ?? null,
      decision_id: ctx.decisionId ?? action?.decision_id ?? action?.id ?? null,
      action_id: action?.id ?? ctx.actionId ?? null,
      action_type: action?.type ?? 'unknown',
      action,
      result,
    }, 'receipt')));
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

  buildContextSummary() {
    const observations = this.readRecentIntel({ days: 7, limit: 8 });
    const events = this.readEvolutionEvents({ limit: 8 });
    const probeResults = this.readProbeResults({ limit: 8 });
    const latestReview = this.readLatestReview();

    return [
      '# js-evolution-agent intelligence summary',
      formatList('Recent observations', observations, (r) => `- [${r.kind ?? 'observation'}] ${r.subject ?? r.source ?? 'unknown'}: ${r.content ?? r.summary ?? ''}`),
      formatList('Recent evolution events', events, (r) => `- [${r.type ?? 'event'}] ${r.action_type ?? r.target ?? 'unknown'}: ${r.result?.status ?? r.status ?? r.summary ?? ''}`),
      formatList('Recent probe results', probeResults, (r) => `- [${r.status ?? 'unknown'}] ${r.probe_type ?? 'probe'} ${r.target ?? ''}: ${r.summary ?? ''}`),
      `Latest review: ${latestReview?.summary ?? latestReview?.outcome ?? 'none'}`,
    ].join('\n\n');
  }
}

export function createIntelligenceStore(opts = {}) {
  return new IntelligenceStore(opts);
}

