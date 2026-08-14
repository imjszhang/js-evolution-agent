/**
 * Execution Pipeline — pulls pending decisions from DecisionQueue and
 * dispatches them to host-registered action handlers.
 *
 * Dual-channel (swarm-lite):
 *   A. Mechanical: all non-agent_run pending decisions, serial, no budget
 *   B. Agent: agent_run waves with JEA_EXEC_AGENT_BUDGET per-cycle cap, plus
 *      optional wall-clock rate ledger (JEA_EXEC_AGENT_RATE) — dual gate, take
 *      the stricter remaining count. Wave width also respects concurrency.
 *
 * Source is always the local DecisionQueue (`source: 'queue'`).
 */
import { join } from 'node:path';
import { isoBeijing, nowBeijingStr } from '../core/time.mjs';
import { normalizeHost } from '../core/host.mjs';
import { DecisionQueue } from '../decide/decision-queue.mjs';
import { ActionExecutor } from '../act/actions.mjs';
import {
  computeAgentWaveWidth,
  isExclusiveAgentDecision,
} from '../act/scope.mjs';
import { AgentRateLedger } from '../act/agent-rate-ledger.mjs';
import { EvolutionLogger } from '../adapters/evolution-logger.mjs';
import { compareDecisionsForClaim } from '../decide/decision-queue.mjs';

function isExecRateOnlyFromEnv(env = process.env) {
  const raw = String(env.JEA_EXEC_RATE_ONLY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function parseExecAgentBudgetFromEnv() {
  const agentBudgetRaw = process.env.JEA_EXEC_AGENT_BUDGET;
  if (agentBudgetRaw != null && agentBudgetRaw !== '') {
    const n = Number(agentBudgetRaw);
    if (Number.isFinite(n)) {
      const i = Math.trunc(n);
      if (i < 1) return 1;
      if (i > 100) return 100;
      return i;
    }
  }
  const legacy = process.env.JEA_EXEC_LIMIT;
  if (legacy != null && legacy !== '') {
    const n = Number(legacy);
    if (Number.isFinite(n)) {
      const i = Math.trunc(n);
      return Math.min(100, Math.max(1, i < 1 ? 1 : i));
    }
  }
  return 8;
}

/** @deprecated Use parseExecAgentBudgetFromEnv. Maps JEA_EXEC_LIMIT → agent budget. */
export function parseExecLimitFromEnv() {
  return parseExecAgentBudgetFromEnv();
}

function isAgentRunDecision(decision) {
  return decision?.action?.type === 'agent_run';
}

export class ExecutionPipeline {
  /**
   * @param {object} opts
   * @param {object} [opts.host]
   * @param {string} [opts.projectRoot]
   * @param {object} [opts.aiClient]   exposed to handlers via ctx.ai
   * @param {DecisionQueue} [opts.decisionQueue]
   * @param {object|null} [opts.executionJournal] Cycle Journal for sibling action notes
   * @param {Function|null} [opts.emitEvent]
   * @param {number|null} [opts.agentBudget]
   * @param {number|null} [opts.agentConcurrency] wave width cap (1 = serial)
   * @param {AgentRateLedger|null} [opts.agentRateLedger] wall-clock rate gate
   */
  constructor({
    host = null, projectRoot = null, aiClient = null,
    decisionQueue = null,
    cycleId = null, executionJournal = null,
    emitEvent = null,
    agentBudget = null,
    agentConcurrency = null,
    agentRateLedger = null,
    createExecutor = null,
    onBeforeExecute = null,
    onAfterExecute = null,
  } = {}) {
    this.host = normalizeHost(host);
    this.projectRoot = projectRoot || this.host.basePath || process.cwd();
    this.aiClient = aiClient;
    this.source = 'queue';
    this.executionJournal = executionJournal;
    this.emitEvent = typeof emitEvent === 'function' ? emitEvent : null;
    this.rateOnly = isExecRateOnlyFromEnv();
    this.agentBudget = this.rateOnly
      ? Number.POSITIVE_INFINITY
      : (agentBudget != null
        ? Math.max(1, Math.floor(Number(agentBudget)) || 1)
        : parseExecAgentBudgetFromEnv());
    this.agentConcurrency = agentConcurrency != null
      ? Math.max(1, Math.floor(Number(agentConcurrency)) || 1)
      : Math.max(1, Math.floor(Number(process.env.JEA_AGENT_MAX_CONCURRENCY) || 2));
    this.agentRateLedger = agentRateLedger instanceof AgentRateLedger
      ? agentRateLedger
      : null;
    this.decisionQueue = decisionQueue || new DecisionQueue({
      dataDir: join(this.projectRoot, 'data', 'evolution'),
      logFn: (m) => this._log(m),
    });

    this.evolutionLogger = new EvolutionLogger(this.projectRoot);
    this._cycleId = cycleId || `cycle-${nowBeijingStr('%Y%m%d-%H%M%S')}`;
    this.createExecutor = typeof createExecutor === 'function' ? createExecutor : null;
    this.onBeforeExecute = typeof onBeforeExecute === 'function' ? onBeforeExecute : null;
    this.onAfterExecute = typeof onAfterExecute === 'function' ? onAfterExecute : null;
  }

  /** @param {string|null} cycleId */
  setCycleId(cycleId = null) {
    if (cycleId != null && String(cycleId).trim()) {
      this._cycleId = String(cycleId).trim();
    }
  }

  _createExecutor() {
    const opts = {
      aiClient: this.aiClient,
      projectRoot: this.projectRoot,
      cycleId: this._cycleId,
      host: this.host,
      logFn: (m, lvl) => this._log(m, lvl),
      executionJournal: this.executionJournal,
    };
    if (this.createExecutor) return this.createExecutor(opts);
    return new ActionExecutor(opts);
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit] legacy alias for agentBudget
   * @param {boolean} [opts.dryRun]
   * @param {string|null} [opts.cycleId]
   * @param {number|null} [opts.agentBudget]
   * @param {number|null} [opts.agentConcurrency]
   * @param {AgentRateLedger|null} [opts.agentRateLedger]
   * @returns {Promise<object>}
   */
  async run({
    limit = null,
    dryRun = false,
    cycleId = null,
    agentBudget = null,
    agentConcurrency = null,
    agentRateLedger = null,
  } = {}) {
    if (cycleId) this.setCycleId(cycleId);
    if (!this.rateOnly) {
      if (agentBudget != null) this.agentBudget = Math.max(1, Math.floor(Number(agentBudget)) || 1);
      else if (limit != null) this.agentBudget = Math.max(1, Math.floor(Number(limit)) || 1);
    }
    if (agentConcurrency != null) {
      this.agentConcurrency = Math.max(1, Math.floor(Number(agentConcurrency)) || 1);
    }
    if (agentRateLedger instanceof AgentRateLedger) {
      this.agentRateLedger = agentRateLedger;
    }

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
      mechanical: { claimed: 0, executed: 0 },
      agent_waves: [],
      agent_budget: Number.isFinite(this.agentBudget) ? this.agentBudget : null,
      agent_budget_shadow: parseExecAgentBudgetFromEnv(),
      rate_only: this.rateOnly,
      agent_concurrency: this.agentConcurrency,
      agent_rate: this.agentRateLedger
        ? this.agentRateLedger.snapshot({ rateLimited: false })
        : null,
      remaining_agent_pending: 0,
    };

    try {
      await this._runDualChannel(result, { dryRun });
      result.success = true;
    } catch (e) {
      result.error = e?.message || String(e);
      this._log(`exec pipeline failed: ${result.error}`, 'error');
    }
    if (result.agent_rate && this.agentRateLedger) {
      result.agent_rate.used_in_window = this.agentRateLedger.usedInWindow();
    }
    result.journal = this.executionJournal?.toJSON?.() ?? null;
    return result;
  }

  async _runDualChannel(result, { dryRun }) {
    const executor = this._createExecutor();

    // Channel A: mechanical (non-agent_run), full claim, serial
    const mechanical = this.decisionQueue.claimWhere({
      limit: 10_000,
      filter: (d) => !isAgentRunDecision(d),
      cycleId: this._cycleId,
    });
    result.mechanical.claimed = mechanical.length;
    this._log(`mechanical channel claimed ${mechanical.length}`);
    for (const decision of mechanical) {
      await this._executeOne(executor, decision, result, { dryRun, channel: 'mechanical' });
      result.mechanical.executed += 1;
    }

    // Channel B: agent_run waves (serial width=1 unless concurrency > 1 and selector allows).
    // Failures that return to pending are retried next cycle — not reclaimed in this run.
    let consumed = 0;
    let waveIndex = 0;
    let lastWaveHadFailure = false;
    let blockedThisCycle = 0;
    const touchedThisCycle = new Set();
    const pendingAgentsAll = this.decisionQueue.getPending().filter((d) => isAgentRunDecision(d));
    result.would_execute_without_cycle_budget = pendingAgentsAll.length;

    while (consumed < this.agentBudget) {
      const cycleRemaining = this.agentBudget - consumed;
      const rateRemaining = this.agentRateLedger
        ? this.agentRateLedger.remaining()
        : Number.POSITIVE_INFINITY;
      if (rateRemaining < 1) {
        if (result.agent_rate) result.agent_rate.rate_limited = true;
        this._log('agent rate budget exhausted; stopping agent waves');
        break;
      }
      const remainingBudget = Math.min(cycleRemaining, rateRemaining);
      const pendingAgents = this.decisionQueue.getPending()
        .filter((d) => isAgentRunDecision(d) && !touchedThisCycle.has(d.id))
        .sort(compareDecisionsForClaim);
      const width = computeAgentWaveWidth({
        pendingAgents,
        cap: Math.min(this.agentConcurrency, remainingBudget),
        lastWaveHadFailure,
        blockedThisCycle,
      }).width;
      if (width < 1) break;

      const exclusiveWave = this._isExclusiveAgentDecision(pendingAgents[0]);
      const claimed = this.decisionQueue.claimWhere({
        limit: width,
        filter: (d) => {
          if (!isAgentRunDecision(d)) return false;
          if (touchedThisCycle.has(d.id)) return false;
          // Exclusive wave: only the leading write-class decision.
          // Parallel wave: only read_only (non-exclusive) decisions.
          return exclusiveWave
            ? this._isExclusiveAgentDecision(d)
            : !this._isExclusiveAgentDecision(d);
        },
        cycleId: this._cycleId,
      });
      if (!claimed.length) break;
      for (const d of claimed) touchedThisCycle.add(d.id);
      if (this.agentRateLedger) {
        this.agentRateLedger.record(claimed, { cycleId: this._cycleId });
      }

      waveIndex += 1;
      const wave = {
        wave: waveIndex,
        width: claimed.length,
        requested_width: width,
        decision_ids: claimed.map((d) => d.id),
        outcomes: [],
      };
      this._log(`agent wave ${waveIndex}: claiming ${claimed.length} (width=${width})`);

      // Wave-front journal snapshot (siblings in same wave do not see each other).
      const journalSnapshot = this.executionJournal?.toJSON?.() ?? null;

      const outcomes = await this._executeAgentWave(executor, claimed, result, {
        dryRun,
        waveIndex,
        width: claimed.length,
        journalSnapshot,
      });

      let waveFailed = false;
      for (const outcome of outcomes) {
        wave.outcomes.push(outcome);
        consumed += 1;
        if (outcome.status === 'blocked') blockedThisCycle += 1;
        if (outcome.status === 'failed' || outcome.status === 'blocked' || outcome.status === 'error') {
          waveFailed = true;
        }
      }
      lastWaveHadFailure = waveFailed;
      result.agent_waves.push(wave);

      if (this.emitEvent) {
        try {
          this.emitEvent({
            type: 'exec_wave',
            status: waveFailed ? 'partial' : 'ok',
            cycle_id: this._cycleId,
            wave: waveIndex,
            width: claimed.length,
            decision_ids: wave.decision_ids,
            blocked_this_cycle: blockedThisCycle,
          });
        } catch { /* ignore */ }
      }
    }

    result.remaining_agent_pending = this.decisionQueue.getPending()
      .filter((d) => isAgentRunDecision(d)).length;
  }

  _isExclusiveAgentDecision(decision) {
    return isExclusiveAgentDecision(decision);
  }

  async _executeAgentWave(executor, claimed, result, {
    dryRun,
    waveIndex,
    width,
    journalSnapshot,
  }) {
    void journalSnapshot;
    if (width <= 1 || claimed.length <= 1) {
      const outcomes = [];
      for (const decision of claimed) {
        const outcome = await this._executeOne(executor, decision, result, {
          dryRun,
          channel: 'agent',
          wave: waveIndex,
          width,
        });
        outcomes.push(outcome);
      }
      return outcomes;
    }

    // Parallel wave: execute concurrently, then settle queue status serially
    // (complete/failOrBlock already lock the queue file).
    const settled = await Promise.allSettled(
      claimed.map(async (decision) => {
        const action = decision.action;
        this._log(`executing decision ${decision.id} type=${action?.type} wave=${waveIndex}`);
        if (dryRun) {
          return { decision, r: { success: true, dry_run: true }, error: null };
        }
        try {
          const lifecycle = await this._beginDecision(decision);
          if (lifecycle?.skip) {
            return {
              decision,
              r: { skipped: true, status: lifecycle.status || 'skipped' },
              error: null,
              lifecycle,
              skipped: true,
            };
          }
          const r = await executor.execute(action, this._execContext(decision, lifecycle));
          await this._finishDecision(decision, r, lifecycle);
          return { decision, r, error: null, lifecycle };
        } catch (e) {
          return { decision, r: null, error: e };
        }
      }),
    );

    const outcomes = [];
    for (const item of settled) {
      const payload = item.status === 'fulfilled'
        ? item.value
        : { decision: null, r: null, error: item.reason };
      const { decision, r, error } = payload;
      if (!decision) {
        outcomes.push({ status: 'error', error: String(error?.message || error || 'unknown') });
        continue;
      }
      if (payload.skipped || r?.skipped) {
        const skipStatus = r?.status || payload.lifecycle?.status || 'skipped';
        if (skipStatus === 'blocked') {
          await this.decisionQueue?.updateStatus?.(decision.id, 'blocked', 'exec_intent_uncertain');
        }
        outcomes.push({ id: decision.id, status: skipStatus });
        continue;
      }
      if (dryRun) {
        const execItem = { id: decision.id, action: decision.action, result: r, wave: waveIndex, width };
        result.executed.push(execItem);
        this.executionJournal?.recordExecuted?.(execItem, { source: 'queue' });
        await this._releaseDecision(decision, 'pending');
        outcomes.push({ id: decision.id, status: 'dry_run' });
        continue;
      }
      if (error) {
        const execItem = {
          id: decision.id,
          action: decision.action,
          result: { success: false, error: error.message },
          wave: waveIndex,
          width,
        };
        result.executed.push(execItem);
        this.executionJournal?.recordExecuted?.(execItem, { source: 'queue' });
        const fb = await this._failOrBlockDecision(decision, error.message);
        outcomes.push({ id: decision.id, status: fb?.status || 'failed', attempts: fb?.attempts });
        continue;
      }
      const execItem = { id: decision.id, action: decision.action, result: r, wave: waveIndex, width };
      result.executed.push(execItem);
      this.executionJournal?.recordExecuted?.(execItem, { source: 'queue' });
      if (r?.success) {
        await this._completeDecision(decision, this._summarize(r));
        outcomes.push({ id: decision.id, status: 'completed' });
      } else if (r?.deferred) {
        await this._releaseDecision(decision, 'pending');
        outcomes.push({ id: decision.id, status: 'deferred' });
      } else {
        const fb = await this._failOrBlockDecision(decision, r?.error || 'handler returned non-success');
        outcomes.push({ id: decision.id, status: fb?.status || 'failed', attempts: fb?.attempts });
      }
    }
    return outcomes;
  }

  async _beginDecision(decision) {
    if (!this.onBeforeExecute) return null;
    return this.onBeforeExecute(decision, { cycleId: this._cycleId });
  }

  async _finishDecision(decision, execResult, lifecycle) {
    if (!this.onAfterExecute) return null;
    return this.onAfterExecute(decision, execResult, lifecycle);
  }

  _execContext(decision, lifecycle) {
    return {
      decisionId: decision.id,
      executionId: this._cycleId,
      intentId: lifecycle?.intent?.id ?? null,
      idempotencyKey: lifecycle?.intent?.key ?? null,
    };
  }

  async _executeOne(executor, decision, result, {
    dryRun,
    channel,
    wave = null,
    width = null,
  }) {
    const action = decision.action;
    this._log(`executing decision ${decision.id} type=${action?.type} channel=${channel}`);

    if (dryRun) {
      const item = {
        id: decision.id,
        action,
        result: { success: true, dry_run: true },
        channel,
        ...(wave != null ? { wave, width } : {}),
      };
      result.executed.push(item);
      this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
      await this._releaseDecision(decision, 'pending');
      return { id: decision.id, status: 'dry_run' };
    }

    let lifecycle = null;
    try {
      lifecycle = await this._beginDecision(decision);
      if (lifecycle?.skip) {
        const skipStatus = lifecycle.status || 'skipped';
        if (skipStatus === 'blocked') {
          await this.decisionQueue?.updateStatus?.(decision.id, 'blocked', 'exec_intent_uncertain');
        }
        return { id: decision.id, status: skipStatus };
      }
      const r = await executor.execute(action, this._execContext(decision, lifecycle));
      await this._finishDecision(decision, r, lifecycle);
      const item = {
        id: decision.id,
        action,
        result: r,
        channel,
        ...(wave != null ? { wave, width } : {}),
      };
      result.executed.push(item);
      this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
      if (r?.success) {
        await this._completeDecision(decision, this._summarize(r));
        return { id: decision.id, status: 'completed' };
      }
      if (r?.deferred) {
        await this._releaseDecision(decision, 'pending');
        return { id: decision.id, status: 'deferred' };
      }
      if (channel === 'agent') {
        const fb = await this._failOrBlockDecision(decision, r?.error || 'handler returned non-success');
        return { id: decision.id, status: fb?.status || 'failed', attempts: fb?.attempts };
      }
      await this._failDecision(decision, r?.error || 'handler returned non-success');
      return { id: decision.id, status: 'failed' };
    } catch (e) {
      await this._finishDecision(decision, { success: false, error: e.message }, lifecycle);
      const item = {
        id: decision.id,
        action,
        result: { success: false, error: e.message },
        channel,
        ...(wave != null ? { wave, width } : {}),
      };
      result.executed.push(item);
      this.executionJournal?.recordExecuted?.(item, { source: 'queue' });
      if (channel === 'agent') {
        const fb = await this._failOrBlockDecision(decision, e.message);
        return { id: decision.id, status: fb?.status || 'failed', attempts: fb?.attempts };
      }
      await this._failDecision(decision, e.message);
      return { id: decision.id, status: 'error', error: e.message };
    }
  }

  /** @deprecated Prefer claimWhere via dual-channel. Kept for callers/tests. */
  async _claimDecisions(limit) {
    return this.decisionQueue.claimNext(limit);
  }

  async _completeDecision(decision, summary) {
    this.decisionQueue.completeDecision(decision.id, summary);
  }

  async _failDecision(decision, error) {
    this.decisionQueue.failDecision(decision.id, error);
  }

  async _failOrBlockDecision(decision, error) {
    if (typeof this.decisionQueue.failOrBlock === 'function') {
      return this.decisionQueue.failOrBlock(decision.id, error);
    }
    this.decisionQueue.failDecision(decision.id, error);
    return { status: 'failed', attempts: 0, max_attempts: 0 };
  }

  async _releaseDecision(decision, _toStatus) {
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
