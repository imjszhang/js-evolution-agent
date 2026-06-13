/**
 * OADA Query Resolver — maps AI-generated questions to observation data sources.
 *
 * Matching: CN/EN keyword intersection against ObservationSourceSpec.tags,
 * description tokenization, overlap dedup (prefer lower cost).
 */
import { ObservationSourceRegistry, ObservationSourceSpec } from './observation-registry.mjs';

const COST_ORDER = { low: 0, medium: 1, high: 2 };

export class ResolvedPlan {
  /**
   * @param {object} opts
   * @param {string[]} opts.sources
   * @param {Record<string, string[]>} opts.questionSourceMap
   * @param {string[]} opts.unresolved
   * @param {string} [opts.depth]
   * @param {Record<string, Record<string, number>>} [opts.scores]
   */
  constructor({ sources, questionSourceMap, unresolved, depth = 'standard', scores = {} }) {
    this.sources = sources;
    this.questionSourceMap = questionSourceMap;
    this.unresolved = unresolved;
    this.depth = depth;
    this.scores = scores;
  }
}

export class QueryResolver {
  static TAG_MATCH_THRESHOLD = 1;

  /** @param {ObservationSourceRegistry} registry */
  constructor(registry) {
    this._registry = registry;
    /** @type {Map<string, Set<string>>} */
    this._tagTokens = new Map();
    /** @type {Map<string, Set<string>>} */
    this._descTokens = new Map();
    this._buildIndex();
  }

  _buildIndex() {
    for (const spec of this._registry.listAvailable()) {
      const tagSet = new Set();
      for (const tag of spec.tags) {
        tagSet.add(tag.toLowerCase());
        for (const t of QueryResolver._tokenize(tag)) tagSet.add(t);
      }
      this._tagTokens.set(spec.id, tagSet);

      const descSet = new Set();
      for (const t of QueryResolver._tokenize(spec.description)) descSet.add(t);
      for (const t of QueryResolver._tokenize(spec.id.replace(/_/g, ' '))) descSet.add(t);
      this._descTokens.set(spec.id, descSet);
    }
  }

  /**
   * @param {object[]} questions
   * @returns {ResolvedPlan}
   */
  resolve(questions) {
    /** @type {Record<string, string[]>} */
    const questionSourceMap = {};
    /** @type {Record<string, Record<string, number>>} */
    const allScores = {};
    /** @type {string[]} */
    const unresolved = [];

    for (const q of questions) {
      const qText = q.question || '';
      const qTokens = QueryResolver._tokenize(qText);
      const category = q.category || '';
      if (category) for (const t of QueryResolver._tokenize(category)) qTokens.add(t);

      /** @type {[string, number][]} */
      const matched = [];
      /** @type {Record<string, number>} */
      const scoresForQ = {};

      for (const sourceId of this._tagTokens.keys()) {
        const score = QueryResolver._score(
          qTokens,
          this._tagTokens.get(sourceId),
          this._descTokens.get(sourceId) || new Set(),
        );
        scoresForQ[sourceId] = score;
        if (score >= QueryResolver.TAG_MATCH_THRESHOLD) matched.push([sourceId, score]);
      }

      allScores[qText] = scoresForQ;

      if (matched.length) {
        matched.sort((a, b) => b[1] - a[1]);
        questionSourceMap[qText] = matched.map(([sid]) => sid);
      } else {
        unresolved.push(qText);
      }
    }

    const rawSources = new Set();
    for (const sids of Object.values(questionSourceMap)) {
      for (const sid of sids) rawSources.add(sid);
    }

    const sources = this._deduplicateOverlaps(rawSources);

    sources.sort((a, b) => {
      const specA = this._registry.get(a);
      const specB = this._registry.get(b);
      const costA = COST_ORDER[specA?.cost ?? 'medium'] ?? 1;
      const costB = COST_ORDER[specB?.cost ?? 'medium'] ?? 1;
      return costA - costB;
    });

    const depth = QueryResolver._inferDepth(questions);

    return new ResolvedPlan({ sources, questionSourceMap, unresolved, depth, scores: allScores });
  }

  /** @param {ResolvedPlan} plan @returns {string} */
  explain(plan) {
    const lines = [`QueryResolver resolved ${plan.sources.length} source(s)`];
    lines.push(`  depth: ${plan.depth}`);

    for (const [qText, sids] of Object.entries(plan.questionSourceMap)) {
      const qShort = qText.length > 60 ? qText.slice(0, 60) + '...' : qText;
      const sidStr = sids.slice(0, 5).join(', ');
      lines.push(`  Q: ${qShort}`);
      lines.push(`    -> [${sidStr}]`);
    }

    if (plan.unresolved.length) {
      lines.push(`  unresolved (${plan.unresolved.length}):`);
      for (const u of plan.unresolved) lines.push(`    ? ${u.slice(0, 60)}`);
    }

    return lines.join('\n');
  }

  /**
   * @param {string} text
   * @returns {Set<string>}
   */
  static _tokenize(text) {
    const tokens = new Set();
    const asciiWords = text.toLowerCase().match(/[a-zA-Z0-9_]+/g);
    if (asciiWords) for (const w of asciiWords) tokens.add(w);

    const cjkSegs = text.match(/[\u4e00-\u9fff]{2,}/g);
    if (cjkSegs) {
      for (const seg of cjkSegs) {
        tokens.add(seg);
        for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
      }
    }

    return tokens;
  }

  /**
   * @param {Set<string>} queryTokens
   * @param {Set<string>} tagTokens
   * @param {Set<string>} descTokens
   * @returns {number}
   */
  static _score(queryTokens, tagTokens, descTokens) {
    if (!queryTokens.size) return 0;
    let tagHits = 0;
    let descHits = 0;
    for (const t of queryTokens) {
      if (tagTokens.has(t)) tagHits++;
      if (descTokens.has(t)) descHits++;
    }
    return tagHits * 2.0 + descHits * 0.5;
  }

  /**
   * @param {Set<string>} sourceIds
   * @returns {string[]}
   */
  _deduplicateOverlaps(sourceIds) {
    const toRemove = new Set();
    for (const sid of sourceIds) {
      if (toRemove.has(sid)) continue;
      const spec = this._registry.get(sid);
      if (!spec || !spec.overlapsWith || !spec.overlapsWith.length) continue;
      for (const overlapId of spec.overlapsWith) {
        if (!sourceIds.has(overlapId) || toRemove.has(overlapId)) continue;
        const overlapSpec = this._registry.get(overlapId);
        if (!overlapSpec) continue;
        const myCost = COST_ORDER[spec.cost] ?? 1;
        const theirCost = COST_ORDER[overlapSpec.cost] ?? 1;
        if (myCost <= theirCost) {
          toRemove.add(overlapId);
        } else {
          toRemove.add(sid);
          break;
        }
      }
    }
    return [...sourceIds].filter(sid => !toRemove.has(sid));
  }

  /**
   * @param {object[]} questions
   * @returns {string}
   */
  static _inferDepth(questions) {
    const highCount = questions.filter(q => q.priority === 'high').length;
    const total = questions.length;
    if (highCount >= 3 || total >= 6) return 'deep';
    if (highCount >= 1 || total >= 3) return 'standard';
    return 'surface';
  }
}
