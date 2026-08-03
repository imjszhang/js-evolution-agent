/**
 * Execution Pipeline — pulls pending decisions from DecisionQueue (or
 * GitHub Issues) and dispatches them to host-registered action handlers.
 *
 * Two source modes:
 *   1. `source: 'queue'` (default): consumes from DecisionQueue
 *   2. `source: 'github'`: consumes open Issues with label `oada/pending`
 *
 * Each action is executed via ActionExecutor which dispatches to
 * `host.actionHandlers[action.type]`. Successful actions are marked
 * completed in the queue (or their Issue is moved to oada/in-progress).
 */
import { join } from 'node:path';
import { isoBeijing, nowBeijingStr } from '../core/time.mjs';
import { normalizeHost } from '../core/host.mjs';
import { DecisionQueue } from '../decide/decision-queue.mjs';
import { ActionExecutor } from '../act/actions.mjs';
import { SelfModifier } from '../act/modifier.mjs';
import { FeatureRequestQueue } from '../decide/feature-request.mjs';
import { EvolutionLogger } from '../adapters/evolution-logger.mjs';

export class ExecutionPipeline {
  /**
   * @param {object} opts
   * @param {object} [opts.host]
   * @param {string} [opts.projectRoot]
   * @param {object} [opts.aiClient]   exposed to handlers via ctx.ai
   * @param {DecisionQueue} [opts.decisionQueue]
   * @param {object} [opts.githubIssues] required when source='github'
   * @param {'queue'|'github'} [opts.source]
   * @param {object|null} [opts.executionJournal] Cycle Journal for sibling action notes
   */
  constructor({
    host = null, projectRoot = null, aiClient = null,
    decisionQueue = null, githubIssues = null, source = 'queue',
    cycleId = null, executionJournal = null,
  } = {}) {
    this.host = normalizeHost(host);
    this.projectRoot = projectRoot || this.host.basePath || process.cwd();
    this.aiClient = aiClient;
    this.source = source;
    this.githubIssues = githubIssues || this.host.githubIssues || null;
    this.executionJournal = executionJournal;
    this.decisionQueue = decisionQueue || new DecisionQueue({
      dataDir: join(this.projectRoot, 'data', 'evolution'),
      logFn: (m) => this._log(m),
    });

    this.modifier = new SelfModifier(this.projectRoot, this.host.logger);
    this.featureQueue = new FeatureRequestQueue(
      join(this.projectRoot, 'data', 'evolution', 'feature_requests'),
    );
    this.evolutionLogger = new EvolutionLogger(this.projectRoot);
    this._cycleId = cycleId || `cycle-${nowBeijingStr('%Y%m%d-%H%M%S')}`;
  }

  /** @param {string|null} cycleId */
  setCycleId(cycleId = null) {
    if (cycleId != null && String(cycleId).trim()) {
      this._cycleId = String(cycleId).trim();
    }
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {boolean} [opts.dryRun]
   * @returns {Promise<object>}
   */
  async run({ limit = 5, dryRun = false, cycleId = null } = {}) {
    if (cycleId) this.setCycleId(cycleId);
    const result = {
      cycle_id: this._cycleId,
      timestamp: isoBeijing(),
      source: this.source,
      dry_run: dryRun,
      executed: [],
      skipped: [],
      success: false,
      error: null,
      journal: null,
    };

    try {
      const decisions = await this._claimDecisions(limit);
      if (!decisions.length) {
        this._log('no pending decisions');
        result.success = true;
        result.journal = this.executionJournal?.toJSON?.() ?? null;
        return result;
      }

      const executor = new ActionExecutor({
        modifier: this.modifier,
        aiClient: this.aiClient,
        featureQueue: this.featureQueue,
        projectRoot: this.projectRoot,
        cycleId: this._cycleId,
        host: this.host,
        logFn: (m, lvl) => this._log(m, lvl),
        executionJournal: this.executionJournal,
      });

      for (const decision of decisions) {
        const action = decision.action;
        this._log(`executing decision ${decision.id} type=${action?.type}`);

        if (dryRun) {
          const item = { id: decision.id, action, result: { success: true, dry_run: true } };
          result.executed.push(item);
          this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
          await this._releaseDecision(decision, 'pending');
          continue;
        }

        try {
          const r = await executor.execute(action);
          const item = { id: decision.id, action, result: r };
          result.executed.push(item);
          this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
          if (r?.success) {
            await this._completeDecision(decision, this._summarize(r));
          } else if (r?.deferred) {
            await this._releaseDecision(decision, 'pending');
          } else {
            await this._failDecision(decision, r?.error || 'handler returned non-success');
          }
        } catch (e) {
          const item = { id: decision.id, action, result: { success: false, error: e.message } };
          result.executed.push(item);
          this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
          await this._failDecision(decision, e.message);
        }
      }

      result.success = true;
    } catch (e) {
      result.error = e?.message || String(e);
      this._log(`exec pipeline failed: ${result.error}`, 'error');
    }
    result.journal = this.executionJournal?.toJSON?.() ?? null;
    return result;
  }

  async _claimDecisions(limit) {
    if (this.source === 'github') {
      if (!this.githubIssues) throw new Error('source=github but no GitHubIssueManager available');
      const issues = await this.githubIssues.listOpenIssues(['oada', 'oada/pending']);
      const decisions = [];
      for (const iss of (issues || []).slice(0, limit)) {
        const action = this.githubIssues.constructor.parseActionFromIssue
          ? this.githubIssues.constructor.parseActionFromIssue(iss)
          : null;
        if (!action) continue;
        decisions.push({
          id: `gh:${iss.number}`,
          source: 'github',
          issue: iss,
          action,
        });
      }
      return decisions;
    }
    return this.decisionQueue.claimNext(limit);
  }

  async _completeDecision(decision, summary) {
    if (decision.source === 'github' && this.githubIssues) {
      await this.githubIssues.updateLabels(decision.issue.number, {
        addLabels: ['oada/completed'], removeLabels: ['oada/pending', 'oada/in-progress'],
      });
      await this.githubIssues.closeIssue(decision.issue.number,
        `OADA exec completed.\n\n${summary}`);
      return;
    }
    this.decisionQueue.completeDecision(decision.id, summary);
  }

  async _failDecision(decision, error) {
    if (decision.source === 'github' && this.githubIssues) {
      await this.githubIssues.updateLabels(decision.issue.number, {
        addLabels: ['oada/failed'], removeLabels: ['oada/pending', 'oada/in-progress'],
      });
      await this.githubIssues.addComment(decision.issue.number, `OADA exec failed: ${error}`);
      return;
    }
    this.decisionQueue.failDecision(decision.id, error);
  }

  async _releaseDecision(decision, _toStatus) {
    if (decision.source === 'github') return;
    this.decisionQueue.updateStatus(decision.id, 'pending');
  }

  _summarize(result) {
    if (!result) return '';
    const parts = [];
    if (result.created_files?.length) parts.push(`created: ${result.created_files.join(', ')}`);
    if (result.modified_files?.length) parts.push(`modified: ${result.modified_files.join(', ')}`);
    if (result.message) parts.push(result.message);
    return parts.join('\n') || JSON.stringify(result).slice(0, 500);
  }

  _log(msg, level = 'info') {
    const logger = this.host.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[exec] ${msg}`);
  }
}
