import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DataSourceRegistry,
  StorageEngine,
} from 'js-intel-store';
import { INTELLIGENCE_SPECS } from './specs.mjs';

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
    baseDir = join(process.cwd(), 'data', 'intelligence'),
    timezone = DEFAULT_TIMEZONE,
    logger = null,
  } = {}) {
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
    return this.engine.ingest('intel_observations', records);
  }

  recordEvolutionEvent(event) {
    return this.engine.ingest('evolution_events', withId({
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'evt'));
  }

  recordRetrospective(review) {
    const record = withId({
      recorded_at: new Date().toISOString(),
      ...review,
    }, 'retro');
    const written = this.engine.ingest('retrospectives', record);
    this.engine.ingest('latest_review', record);
    return written;
  }

  recordActionReceipt(action, result, ctx = {}) {
    return this.engine.ingest('action_receipts', withId({
      recorded_at: new Date().toISOString(),
      cycle_id: ctx.cycleId ?? null,
      action_type: action?.type ?? 'unknown',
      action,
      result,
    }, 'receipt'));
  }

  recordProbeEvent(probeId, event) {
    return this.engine.ingest('probe_threads', withId({
      _entity_id: probeId,
      recorded_at: new Date().toISOString(),
      ...event,
    }, 'probe-event'));
  }

  readRecentIntel({ days = 7, limit = 20 } = {}) {
    return this.engine.readSource('intel_observations', { days }).slice(0, limit);
  }

  readEvolutionEvents({ limit = 20 } = {}) {
    return this.engine.readSource('evolution_events', { limit });
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
    const latestReview = this.readLatestReview();

    return [
      '# js-evolution-agent intelligence summary',
      formatList('Recent observations', observations, (r) => `- [${r.kind ?? 'observation'}] ${r.subject ?? r.source ?? 'unknown'}: ${r.content ?? r.summary ?? ''}`),
      formatList('Recent evolution events', events, (r) => `- [${r.type ?? 'event'}] ${r.action_type ?? r.target ?? 'unknown'}: ${r.result?.status ?? r.status ?? r.summary ?? ''}`),
      `Latest review: ${latestReview?.summary ?? latestReview?.outcome ?? 'none'}`,
    ].join('\n\n');
  }
}

export function createIntelligenceStore(opts = {}) {
  return new IntelligenceStore(opts);
}

