/**
 * EvolutionEngine — orchestrates a single OADA cycle (Observe → Analyze+Decide).
 *
 * The engine itself only handles the "thinking" half: observing, analyzing,
 * and producing decisions. Decisions are queued into a DecisionQueue (the
 * decoupling interface). The execution pipeline consumes the queue separately
 * (see `pipelines/exec.mjs`) so concurrent / out-of-process execution is
 * possible.
 *
 * The engine is host-agnostic: pass in any `host` (HostContext) and any
 * `aiClient` (BaseAIClient subclass or duck-typed object).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoBeijing, nowBeijingStr } from './core/time.mjs';
import { normalizeHost } from './core/host.mjs';
import { SelfAnalyzer } from './analyze/analyzer.mjs';
import { SelfModifier } from './act/modifier.mjs';
import { PromptBuilder } from './ai/prompt-builder.mjs';
import { AIDrivenObserver } from './observe/ai-driven-observer.mjs';
import { ACTION_REGISTRY } from './decide/action-registry.mjs';
import { ActionExecutor, verifyActions } from './act/actions.mjs';
import { FeatureRequestQueue } from './decide/feature-request.mjs';
import { HumanGuidanceReader } from './adapters/human-guidance.mjs';
import { EvolutionLogger } from './adapters/evolution-logger.mjs';
import { GoalProvider } from './decide/goal-provider.mjs';

export { ActionExecutor, verifyActions };

export class EvolutionEngine {
  /**
   * @param {object} opts
   * @param {object} opts.aiClient            AI client (must implement chat / chatJson)
   * @param {object} [opts.host]              HostContext
   * @param {string} [opts.projectRoot]       default: host.basePath || cwd
   * @param {string} [opts.goalId]
   * @param {string} [opts.rulesPath]         override OADA rules path (default: data/evolution/OADA.md)
   * @param {ActionTypeRegistry} [opts.actionRegistry]
   * @param {PromptBuilder} [opts.promptBuilder]
   * @param {object} [opts.goalProvider]
   * @param {object} [opts.featureQueue]
   * @param {object} [opts.guidanceReader]
   * @param {object} [opts.evolutionLogger]
   * @param {object} [opts.modifier]
   * @param {object} [opts.analyzer]
   * @param {Array<{id: string, source?: string, text: string}>} [opts.agentContextDocs]
   *        Authoritative context documents (e.g. external constitutions/skills) that
   *        will be injected verbatim at the top of analyze/decide prompts.
   */
  constructor({
    aiClient, host = null, projectRoot = null, goalId = null, rulesPath = null,
    actionRegistry = null, promptBuilder = null,
    goalProvider = null, featureQueue = null, guidanceReader = null,
    evolutionLogger = null, modifier = null, analyzer = null,
    agentContextDocs = null,
  }) {
    if (!aiClient) throw new Error('EvolutionEngine: aiClient is required');
    this.host = normalizeHost(host);
    this.projectRoot = projectRoot || this.host.basePath || process.cwd();
    this.aiClient = aiClient;
    this.actionRegistry = actionRegistry || ACTION_REGISTRY;
    this.promptBuilder = promptBuilder || new PromptBuilder({ actionRegistry: this.actionRegistry });
    this.agentContextDocs = Array.isArray(agentContextDocs) ? agentContextDocs : [];

    this._cycleId = `cycle-${nowBeijingStr('%Y%m%d-%H%M%S')}`;
    this._goalId = goalId;
    this._rulesPath = rulesPath;
    this._humanGuidance = null;

    const logger = this.host.logger || null;
    this.analyzer = analyzer || new SelfAnalyzer({
      projectRoot: this.projectRoot,
      logger,
      analyticsReader: this.host.analyticsReader,
    });
    this.modifier = modifier || new SelfModifier(this.projectRoot, logger);
    this.featureQueue = featureQueue
      || new FeatureRequestQueue(join(this.projectRoot, 'data', 'evolution', 'feature_requests'));
    this.guidanceReader = guidanceReader || new HumanGuidanceReader(this.projectRoot, logger);
    this.evolutionLogger = evolutionLogger || new EvolutionLogger(this.projectRoot);
    this.goalProvider = goalProvider || new GoalProvider(this.projectRoot, logger);
    this._goalsText = '';
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
    this._goalsText = this.goalProvider.formatForPrompt(goalId);
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

  /**
   * Run Observe + Analyze+Decide. Returns the AI's combined analysis+decision.
   * @returns {Promise<object>}
   */
  async observeAnalyzeAndDecide() {
    if (!this._goalsText) this._goalsText = this.goalProvider.formatForPrompt(this._goalId);
    this._humanGuidance = this.guidanceReader.readGuidance();
    const rules = this.loadRules();

    this.evolutionLogger.startCycle(this._cycleId);
    this.evolutionLogger.setGoalId(this._goalId);
    this.evolutionLogger.setAiDriven(true);

    let observation = null;
    try {
      this._log(`[${this._cycleId}] phase 1/2: observe`);
      this.evolutionLogger.startPhase('observe');
      const observer = new AIDrivenObserver({
        aiClient: this.aiClient,
        host: this.host,
        evolutionLogger: this.evolutionLogger,
        goalsText: this._goalsText,
        rules,
        projectRoot: this.projectRoot,
        logger: this.host.logger,
      });
      observation = await observer.observe();
      this.evolutionLogger.logPhase('observe', {
        outputs: { ai_driven: observation.ai_driven },
        prompt: observation._prompt,
        aiResponse: observation.observation_report,
        aiDriven: true,
      });
    } catch (e) {
      this._log(`observe failed: ${e?.message || e}`, 'error');
      this.evolutionLogger.logPhase('observe', { error: e?.message || String(e) });
      throw e;
    }

    let analysis = null;
    try {
      this._log(`[${this._cycleId}] phase 2/2: analyze + decide`);
      this.evolutionLogger.startPhase('analyze_decide');

      const intelligenceContext = this._buildIntelligenceContext();
      const pendingIssues = await this._loadPendingIssues();

      const prompt = this.promptBuilder.buildAnalysisDecisionPrompt({}, {
        goalsContext: this._goalsText,
        rules,
        humanGuidance: this._humanGuidance,
        intelligenceContext,
        pendingIssues,
        observationReport: observation.observation_report,
        agentContextDocs: this.agentContextDocs,
      });

      const ai = await this.aiClient.chatJson(prompt, 'medium', 600);
      analysis = ai;

      this.evolutionLogger.logPhase('analyze_decide', {
        outputs: {
          decision: ai.decision,
          actions_count: (ai.actions || []).length,
        },
        prompt,
        aiResponse: JSON.stringify(ai, null, 2),
        aiDriven: true,
      });
    } catch (e) {
      this._log(`analyze+decide failed: ${e?.message || e}`, 'error');
      this.evolutionLogger.logPhase('analyze_decide', { error: e?.message || String(e) });
      this.evolutionLogger.endCycle(false, e?.message || String(e));
      throw e;
    }

    this.evolutionLogger.endCycle(true);

    return {
      cycle_id: this._cycleId,
      timestamp: isoBeijing(),
      observation,
      analysis,
      decision: analysis?.decision || 'execute',
      actions: analysis?.actions || [],
      goal_id: this._goalId,
    };
  }

  /** @returns {string|null} */
  _buildIntelligenceContext() {
    const writer = this.host.knowledgeWriter;
    if (!writer || typeof writer.buildContextSummary !== 'function') return null;
    try {
      const ctx = writer.buildContextSummary();
      return ctx || null;
    } catch { return null; }
  }

  /** @returns {Promise<object[]>} */
  async _loadPendingIssues() {
    // Hosts providing a github issue manager can override via host.githubIssues
    const manager = this.host.githubIssues;
    if (!manager || typeof manager.listOpenIssues !== 'function') return [];
    try {
      const issues = await manager.listOpenIssues(['oada', 'oada/pending']);
      return (issues || []).map(iss => ({
        number: iss.number,
        title: iss.title,
        type: (iss.labels || []).find(l => (l.name || '').startsWith('type/'))?.name?.slice(5),
        priority: (iss.labels || []).find(l => (l.name || '').startsWith('priority/'))?.name?.slice(9),
      }));
    } catch { return []; }
  }

  _log(message, level = 'info') {
    const logger = this.host.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[${this.appName}] ${message}`);
  }
}

/** @deprecated Old name, kept for compatibility. */
export const AutoEvolutionEngine = EvolutionEngine;
