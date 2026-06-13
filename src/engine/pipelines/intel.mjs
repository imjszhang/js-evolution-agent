/**
 * Intelligence Pipeline — Observe → Analyze + Decide → publish decisions.
 *
 * Two output modes:
 *   1. `mode: 'local'` (default): writes briefing.md + issues.json to
 *      data/evolution/draft_issues/<cycle-id>/ AND queues actions into
 *      DecisionQueue (consumed by the exec pipeline).
 *   2. `mode: 'github'`: publishes each action as a GitHub Issue via
 *      the host-provided GitHubIssueManager.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isoBeijing } from '../core/time.mjs';
import { EvolutionEngine } from '../engine.mjs';
import { DecisionQueue } from '../decide/decision-queue.mjs';

export class IntelligencePipeline {
  /**
   * @param {object} opts
   * @param {object} opts.aiClient
   * @param {object} [opts.host]
   * @param {string} [opts.projectRoot]
   * @param {string} [opts.goalId]
   * @param {'local'|'github'} [opts.mode]   default: 'local'
   * @param {object} [opts.githubIssues]     required when mode='github'; if not passed, falls back to host.githubIssues
   * @param {object} [opts.engine]           preconstructed engine (advanced)
   * @param {DecisionQueue} [opts.decisionQueue]
   * @param {Array<{id: string, source?: string, text: string}>} [opts.agentContextDocs]
   */
  constructor({
    aiClient, host = null, projectRoot = null, goalId = null,
    mode = 'local', githubIssues = null, engine = null, decisionQueue = null,
    agentContextDocs = null,
  }) {
    this.host = host;
    this.mode = mode;
    this.githubIssues = githubIssues || host?.githubIssues || null;
    this.engine = engine || new EvolutionEngine({
      aiClient, host, projectRoot, goalId, agentContextDocs,
    });
    this.projectRoot = this.engine.projectRoot;
    this.decisionQueue = decisionQueue || new DecisionQueue({
      dataDir: join(this.projectRoot, 'data', 'evolution'),
      logFn: (msg) => this._log(msg),
    });
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun]
   * @returns {Promise<object>}
   */
  async run({ dryRun = false } = {}) {
    const result = {
      cycle_id: this.engine.cycleId,
      timestamp: isoBeijing(),
      mode: this.mode,
      dry_run: dryRun,
      success: false,
      actions: [],
      issues_created: [],
      decisions_queued: [],
      error: null,
    };

    try {
      const cycle = await this.engine.observeAnalyzeAndDecide();
      result.actions = cycle.actions;
      const analysisContext = this._summarizeAnalysis(cycle.analysis);

      if (dryRun) {
        this._log(`[dry-run] would publish ${cycle.actions.length} action(s)`);
        result.success = true;
        return result;
      }

      if (this.mode === 'github') {
        if (!this.githubIssues) {
          throw new Error('mode=github but no GitHubIssueManager available (host.githubIssues missing)');
        }
        for (const action of cycle.actions) {
          const issueResult = await this.githubIssues.publishAction(
            action, cycle.cycle_id, analysisContext, isoBeijing(), false,
          );
          result.issues_created.push({
            number: issueResult.number,
            url: issueResult.url,
            success: issueResult.success,
          });
        }
      } else {
        // local mode: write draft + queue
        const draftDir = join(this.projectRoot, 'data', 'evolution', 'draft_issues', cycle.cycle_id);
        mkdirSync(draftDir, { recursive: true });
        writeFileSync(
          join(draftDir, 'briefing.md'),
          this._buildBriefing(cycle, analysisContext),
          'utf-8',
        );
        writeFileSync(
          join(draftDir, 'issues.json'),
          JSON.stringify({ cycle_id: cycle.cycle_id, actions: cycle.actions }, null, 2),
          'utf-8',
        );
        const ids = this.decisionQueue.addDecisions({
          cycleId: cycle.cycle_id,
          actions: cycle.actions,
          analysisContext,
        });
        result.decisions_queued = ids;
        this._log(`wrote draft + queued ${ids.length} decision(s) at ${draftDir}`);
      }

      result.success = true;
    } catch (e) {
      result.error = e?.message || String(e);
      this._log(`intel pipeline failed: ${result.error}`, 'error');
    }
    return result;
  }

  _summarizeAnalysis(analysis) {
    if (!analysis) return '';
    if (typeof analysis === 'string') return analysis;
    const a = analysis.analysis || analysis;
    const parts = [];
    if (a.key_patterns?.length) {
      parts.push('Key patterns: ' + a.key_patterns.slice(0, 5).join('; '));
    }
    if (a.root_causes) {
      parts.push('Root causes: ' + JSON.stringify(a.root_causes));
    }
    if (analysis.rationale) parts.push(`Rationale: ${analysis.rationale}`);
    return parts.join('\n').slice(0, 3000);
  }

  _buildBriefing(cycle, context) {
    const lines = [
      `# OADA Intelligence Briefing — ${cycle.cycle_id}`,
      `*Generated:* ${cycle.timestamp}`,
      cycle.goal_id ? `*Focus goal:* \`${cycle.goal_id}\`` : '',
      '',
      '## Summary',
      context || '(no analysis context)',
      '',
      `## Decisions (${cycle.actions.length})`,
    ];
    for (const a of cycle.actions) {
      lines.push(`- **[${a.type}]** ${a.description || ''} (priority: ${a.priority || 'medium'})`);
      if (a.serves_goal) lines.push(`  - serves: ${a.serves_goal}`);
      if (a.expected_impact) lines.push(`  - impact: ${a.expected_impact}`);
    }
    return lines.join('\n');
  }

  _log(msg, level = 'info') {
    const logger = this.host?.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[intel] ${msg}`);
  }
}
