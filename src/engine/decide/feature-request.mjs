/**
 * Feature Request Queue — manages feature evolution requests.
 *
 * Storage: data/evolution/feature_requests/ directory, one JSON file per request.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isoBeijing } from '../core/time.mjs';

export class FeatureRequest {
  /**
   * @param {object} init
   */
  constructor({ id, description, source, status, createdAt, priority = 'medium',
    designSpec = null, implementationResult = null, deferReason = null,
    completedAt = null, updatedAt = null }) {
    this.id = id;
    this.description = description;
    this.source = source;
    this.status = status;
    this.createdAt = createdAt;
    this.priority = priority;
    this.designSpec = designSpec;
    this.implementationResult = implementationResult;
    this.deferReason = deferReason;
    this.completedAt = completedAt;
    this.updatedAt = updatedAt;
  }

  toDict() {
    return {
      id: this.id, description: this.description, source: this.source,
      status: this.status, created_at: this.createdAt, priority: this.priority,
      design_spec: this.designSpec, implementation_result: this.implementationResult,
      defer_reason: this.deferReason, completed_at: this.completedAt,
      updated_at: this.updatedAt,
    };
  }

  static fromDict(data) {
    return new FeatureRequest({
      id: data.id, description: data.description, source: data.source,
      status: data.status, createdAt: data.created_at, priority: data.priority || 'medium',
      designSpec: data.design_spec || null, implementationResult: data.implementation_result || null,
      deferReason: data.defer_reason || null, completedAt: data.completed_at || null,
      updatedAt: data.updated_at || null,
    });
  }
}

export class FeatureRequestQueue {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
  }

  /**
   * @param {string} description
   * @param {string} [source]
   * @param {string} [priority]
   * @returns {FeatureRequest}
   */
  add(description, source = 'manual', priority = 'medium') {
    const now = isoBeijing();
    const request = new FeatureRequest({
      id: randomUUID().replace(/-/g, '').slice(0, 8),
      description, source, status: 'pending',
      createdAt: now, priority, updatedAt: now,
    });
    this._save(request);
    return request;
  }

  getPending() {
    const all = this._loadAll();
    const pending = all.filter(r => r.status === 'pending');
    const order = { high: 0, medium: 1, low: 2 };
    pending.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));
    return pending;
  }

  /** @param {string} requestId */
  getById(requestId) {
    const filepath = join(this.dataDir, `${requestId}.json`);
    if (!existsSync(filepath)) return null;
    try {
      return FeatureRequest.fromDict(JSON.parse(readFileSync(filepath, 'utf-8')));
    } catch { return null; }
  }

  /**
   * @param {string} requestId
   * @param {string} status
   * @param {object} [extra]
   */
  updateStatus(requestId, status, extra = {}) {
    const request = this.getById(requestId);
    if (!request) return false;
    request.status = status;
    request.updatedAt = isoBeijing();
    if (extra.designSpec !== undefined) request.designSpec = extra.designSpec;
    if (extra.implementationResult !== undefined) request.implementationResult = extra.implementationResult;
    if (extra.deferReason !== undefined) request.deferReason = extra.deferReason;
    if (status === 'completed' && !request.completedAt) request.completedAt = isoBeijing();
    this._save(request);
    return true;
  }

  /** @param {string} [status] */
  listAll(status = null) {
    let all = this._loadAll();
    if (status) all = all.filter(r => r.status === status);
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return all;
  }

  getActionable() {
    const actionable = new Set(['pending', 'designing', 'approved']);
    const all = this._loadAll().filter(r => actionable.has(r.status));
    const order = { high: 0, medium: 1, low: 2 };
    all.sort((a, b) => (order[a.priority] ?? 1) - (order[b.priority] ?? 1));
    return all;
  }

  /** @param {FeatureRequest} request */
  _save(request) {
    const filepath = join(this.dataDir, `${request.id}.json`);
    writeFileSync(filepath, JSON.stringify(request.toDict(), null, 2), 'utf-8');
  }

  _loadAll() {
    if (!existsSync(this.dataDir)) return [];
    /** @type {FeatureRequest[]} */
    const requests = [];
    for (const file of readdirSync(this.dataDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(this.dataDir, file), 'utf-8'));
        requests.push(FeatureRequest.fromDict(data));
      } catch { /* skip corrupted */ }
    }
    return requests;
  }
}
