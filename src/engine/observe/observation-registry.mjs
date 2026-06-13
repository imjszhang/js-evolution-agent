/**
 * OADA Observation Source Registry — single source of truth for observation data sources.
 *
 * All observation data-source metadata is centralised here;
 * AIDrivenObserver reads from this registry. Intelligence sources can be
 * bridged in via `mergeIntelligenceSources()` if the host provides one.
 *
 * The registry ships with only generic, framework-internal sources
 * (engine's own history, feature requests, human guidance, execution logs).
 * Host applications should register their domain-specific sources.
 */

class ObservationSourceSpec {
  /**
   * @param {object} init
   * @param {string} init.id
   * @param {string} init.description
   * @param {string} init.sourceType - api | local | computed | intelligence
   * @param {string} init.collector
   * @param {string} [init.cost]
   * @param {boolean} [init.supportsDepth]
   * @param {boolean} [init.available]
   * @param {string[]} [init.overlapsWith]
   * @param {string[]} [init.tags]
   */
  constructor({ id, description, sourceType, collector, cost = 'low',
    supportsDepth = true, available = true, overlapsWith = [], tags = [] }) {
    this.id = id;
    this.description = description;
    this.sourceType = sourceType;
    this.collector = collector;
    this.cost = cost;
    this.supportsDepth = supportsDepth;
    this.available = available;
    this.overlapsWith = Object.freeze(overlapsWith);
    this.tags = Object.freeze(tags);
  }
}

/**
 * Generic, framework-internal sources only. Hosts register their own.
 * @type {Record<string, ObservationSourceSpec>}
 */
const BUILTIN_OBSERVATION_SOURCES = {
  execution_logs: new ObservationSourceSpec({
    id: 'execution_logs',
    description: 'Local execution logs (engine cycle logs, depth-controlled)',
    sourceType: 'local', collector: '_collectExecutionLogsByDepth', cost: 'low',
    tags: ['logs', 'execution', 'errors', 'success_rate', 'workflow'],
  }),
  evolution_history: new ObservationSourceSpec({
    id: 'evolution_history',
    description: 'Past OADA cycle history (decisions, observations)',
    sourceType: 'local', collector: '_collectEvolutionHistory', cost: 'low', supportsDepth: false,
    tags: ['evolution', 'history', 'tasks', 'decisions', 'cycles'],
  }),
  feature_requests: new ObservationSourceSpec({
    id: 'feature_requests',
    description: 'Pending feature-request backlog',
    sourceType: 'local', collector: '_collectFeatureRequests', cost: 'low', supportsDepth: false,
    tags: ['feature', 'request', 'backlog', 'todo'],
  }),
  human_guidance: new ObservationSourceSpec({
    id: 'human_guidance',
    description: 'Human-provided guidance / advice file',
    sourceType: 'local', collector: '_collectHumanGuidance', cost: 'low', supportsDepth: false,
    tags: ['guidance', 'human', 'instruction', 'advice'],
  }),
};

export class ObservationSourceRegistry {
  /** @param {{ includeBuiltins?: boolean }} [opts] */
  constructor({ includeBuiltins = true } = {}) {
    /** @type {Map<string, ObservationSourceSpec>} */
    this._specs = new Map();
    if (includeBuiltins) {
      for (const [k, v] of Object.entries(BUILTIN_OBSERVATION_SOURCES)) {
        this._specs.set(k, v);
      }
    }
  }

  /** @param {ObservationSourceSpec} spec */
  register(spec) {
    const validTypes = new Set(['api', 'local', 'computed', 'intelligence']);
    if (!validTypes.has(spec.sourceType)) throw new Error(`Invalid sourceType '${spec.sourceType}'`);
    const validCosts = new Set(['low', 'medium', 'high']);
    if (!validCosts.has(spec.cost)) throw new Error(`Invalid cost '${spec.cost}'`);
    this._specs.set(spec.id, spec);
  }

  get(sourceId) { return this._specs.get(sourceId) ?? null; }
  listAll() { return [...this._specs.values()]; }
  listAvailable() { return [...this._specs.values()].filter(s => s.available); }

  toAiSourceList() {
    const result = [];
    for (const spec of this._specs.values()) {
      if (!spec.available) continue;
      /** @type {Record<string, any>} */
      const entry = { id: spec.id, description: spec.description, type: spec.sourceType, cost: spec.cost };
      if (spec.overlapsWith.length) entry.overlaps_with = [...spec.overlapsWith];
      if (spec.tags.length) entry.tags = [...spec.tags];
      result.push(entry);
    }
    return result;
  }

  /**
   * Merge sources from a host-provided intelligence registry. Each source
   * registry must implement `listAll()` returning items with `getObserverId()`
   * and `description` fields.
   * @param {object} intelRegistry
   */
  mergeIntelligenceSources(intelRegistry) {
    if (!intelRegistry) return;
    for (const intelSpec of intelRegistry.listAll()) {
      const obsId = intelSpec.getObserverId();
      if (this._specs.has(obsId)) continue;
      const autoTags = ObservationSourceRegistry._deriveTagsFromIntel(obsId);
      this._specs.set(obsId, new ObservationSourceSpec({
        id: obsId, description: intelSpec.description,
        sourceType: 'intelligence', collector: '_collectIntelligenceSource',
        cost: 'low', supportsDepth: true, tags: autoTags,
      }));
    }
  }

  static _deriveTagsFromIntel(obsId) {
    const tags = new Set();
    const suffix = obsId.replace('intelligence_', '');
    tags.add(suffix); tags.add('intelligence');
    return [...tags].sort();
  }

  get size() { return this._specs.size; }
  has(sourceId) { return this._specs.has(sourceId); }
}

export const OBSERVATION_REGISTRY = new ObservationSourceRegistry();
export { ObservationSourceSpec };
