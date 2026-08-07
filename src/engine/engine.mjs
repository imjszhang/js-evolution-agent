/**
 * EvolutionEngine — shared container for JEA Phase 1 helpers.
 *
 * Host conversational / agent_loop paths use this for cycle id, rules,
 * goals, human guidance, and evolution logging. Observe/report/decide
 * prompts live in `src/prompts/`; queue consumption is `pipelines/exec.mjs`.
 *
 * The engine is host-agnostic: pass in any `host` (HostContext) and any
 * `aiClient` (BaseAIClient subclass or duck-typed object).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowBeijingStr } from './core/time.mjs';
import { normalizeHost } from './core/host.mjs';
import { ACTION_REGISTRY } from './decide/action-registry.mjs';
import { ActionExecutor, verifyActions } from './act/actions.mjs';
import { HumanGuidanceReader } from './adapters/human-guidance.mjs';
import { EvolutionLogger } from './adapters/evolution-logger.mjs';
import { GoalProvider } from './decide/goal-provider.mjs';

export { ActionExecutor, verifyActions };

export class EvolutionEngine {
  /**
   * @param {object} opts
   * @param {object} [opts.aiClient]          kept for call-site compatibility; host owns LLM calls
   * @param {object} [opts.host]              HostContext
   * @param {string} [opts.projectRoot]       default: host.basePath || cwd
   * @param {string} [opts.goalId]
   * @param {string} [opts.rulesPath]         override OADA rules path (default: data/evolution/OADA.md)
   * @param {ActionTypeRegistry} [opts.actionRegistry]
   * @param {object} [opts.goalProvider]
   * @param {object} [opts.guidanceReader]
   * @param {object} [opts.evolutionLogger]
   * @param {Array<{id: string, source?: string, text: string}>} [opts.agentContextDocs]
   *        Accepted for call-site compatibility; unused (host pipelines keep their own copy).
   */
  constructor({
    aiClient = null, host = null, projectRoot = null, goalId = null, rulesPath = null,
    actionRegistry = null,
    goalProvider = null, guidanceReader = null,
    evolutionLogger = null,
    agentContextDocs = null,
  } = {}) {
    void aiClient;
    void agentContextDocs;
    this.host = normalizeHost(host);
    this.projectRoot = projectRoot || this.host.basePath || process.cwd();
    this.actionRegistry = actionRegistry || ACTION_REGISTRY;

    this._cycleId = `cycle-${nowBeijingStr('%Y%m%d-%H%M%S')}`;
    this._goalId = goalId;
    this._rulesPath = rulesPath;

    const logger = this.host.logger || null;
    this.guidanceReader = guidanceReader || new HumanGuidanceReader(this.projectRoot, logger);
    this.evolutionLogger = evolutionLogger || new EvolutionLogger(this.projectRoot);
    this.goalProvider = goalProvider || new GoalProvider(this.projectRoot, logger);
  }

  get cycleId() { return this._cycleId; }
  get appName() { return this.host.appName || 'OADA'; }

  /** @param {string|null} cycleId */
  setCycleId(cycleId = null) {
    if (cycleId != null && String(cycleId).trim()) {
      this._cycleId = String(cycleId).trim();
    }
  }

  /** @param {string|null} goalId */
  setGoalId(goalId = null) {
    this._goalId = goalId;
  }

  /** @returns {string} */
  loadRules() {
    const rulesPath = this._rulesPath || join(this.projectRoot, 'data', 'evolution', 'OADA.md');
    try {
      if (!existsSync(rulesPath)) return '';
      return readFileSync(rulesPath, 'utf-8').trim();
    } catch (e) {
      this._log(`load rules failed (${rulesPath}): ${e?.message || e}`, 'warning');
      return '';
    }
  }

  _log(message, level = 'info') {
    const logger = this.host.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[${this.appName}] ${message}`);
  }
}
