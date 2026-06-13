/**
 * Verify Pipeline — audits OADA outcomes.
 *
 * Two modes:
 *   1. `mode: 'github'`: scans open OADA PRs (head ref starts with
 *      `oada/issue-`), runs CI checks, applies risk policies, and
 *      either generates a merge-recommendation report or auto-merges.
 *   2. `mode: 'local'`: runs the generic post-action verifier
 *      (`verifyActions`) against the most recent exec results.
 *
 * Risk policies (mode='github'):
 *   YAML at `data/config/verify_policies.yaml`:
 *     low:    { auto_merge: true }
 *     medium: { auto_merge: false }
 *     high:   { auto_merge: false }
 *   Risk level is read from the action-type registry (`defaultRisk`).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { isoBeijing, nowBeijingStr } from '../core/time.mjs';
import { normalizeHost } from '../core/host.mjs';
import { ACTION_REGISTRY } from '../decide/action-registry.mjs';

const DEFAULT_POLICIES = {
  low: { auto_merge: false },
  medium: { auto_merge: false },
  high: { auto_merge: false },
};

export class VerifyPipeline {
  /**
   * @param {object} opts
   * @param {object} [opts.host]
   * @param {string} [opts.projectRoot]
   * @param {object} [opts.githubIssues] required for mode='github'
   * @param {ActionTypeRegistry} [opts.actionRegistry]
   * @param {'github'|'local'} [opts.mode]
   * @param {string} [opts.policiesPath]
   */
  constructor({
    host = null, projectRoot = null, githubIssues = null,
    actionRegistry = null, mode = 'github', policiesPath = null,
  } = {}) {
    this.host = normalizeHost(host);
    this.projectRoot = projectRoot || this.host.basePath || process.cwd();
    this.githubIssues = githubIssues || this.host.githubIssues || null;
    this.actionRegistry = actionRegistry || ACTION_REGISTRY;
    this.mode = mode;
    this.policiesPath = policiesPath || join(this.projectRoot, 'data', 'config', 'verify_policies.yaml');
    this._cycleId = `verify-${nowBeijingStr('%Y%m%d-%H%M%S')}`;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.auto]      auto-merge when policy permits
   * @param {number}  [opts.merge]     manually merge this PR number
   * @returns {Promise<object>}
   */
  async run({ auto = false, merge = null } = {}) {
    const result = {
      cycle_id: this._cycleId,
      timestamp: isoBeijing(),
      mode: this.mode,
      reviewed: [],
      merged: [],
      report_path: null,
      success: false,
      error: null,
    };

    try {
      if (this.mode === 'local') {
        result.note = 'local mode is a no-op placeholder; pass action results to verifyActions() directly';
        result.success = true;
        return result;
      }

      if (!this.githubIssues) {
        throw new Error('VerifyPipeline mode=github requires a GitHubIssueManager (host.githubIssues)');
      }

      const policies = this._loadPolicies();

      if (typeof merge === 'number') {
        const ok = await this.githubIssues.mergePullRequest(merge, { mergeMethod: 'squash' });
        result.merged.push({ pr: merge, success: ok });
        result.success = true;
        return result;
      }

      const prs = await this.githubIssues.listOpenPulls('oada/issue-');
      for (const pr of (prs || [])) {
        const review = await this._reviewPr(pr, policies);
        result.reviewed.push(review);

        if (auto && review.recommendation === 'auto-merge') {
          const ok = await this.githubIssues.mergePullRequest(pr.number, { mergeMethod: 'squash' });
          result.merged.push({ pr: pr.number, success: ok });
        }
      }

      const reportDir = join(this.projectRoot, 'data', 'evolution', 'verify_reports');
      mkdirSync(reportDir, { recursive: true });
      const reportPath = join(reportDir, `${this._cycleId}.md`);
      writeFileSync(reportPath, this._buildReport(result), 'utf-8');
      result.report_path = reportPath;
      result.success = true;
    } catch (e) {
      result.error = e?.message || String(e);
      this._log(`verify pipeline failed: ${result.error}`, 'error');
    }
    return result;
  }

  async _reviewPr(pr, policies) {
    const review = {
      pr: pr.number,
      title: pr.title,
      url: pr.html_url,
      action_type: this._inferActionType(pr),
      risk: 'unknown',
      ci: 'unknown',
      recommendation: 'manual-review',
    };
    const actionType = review.action_type;
    const spec = actionType ? this.actionRegistry.get(actionType) : null;
    review.risk = spec?.defaultRisk || 'high';

    const sha = pr.head?.sha;
    if (sha) {
      const checks = await this.githubIssues.getCheckRuns(sha);
      const conclusions = (checks || []).map(c => c.conclusion);
      if (conclusions.length === 0) review.ci = 'pending';
      else if (conclusions.every(c => c === 'success')) review.ci = 'success';
      else if (conclusions.some(c => c === 'failure')) review.ci = 'failure';
      else review.ci = 'mixed';
    }

    const policy = policies[review.risk] || policies.high || { auto_merge: false };
    if (review.ci === 'success' && policy.auto_merge) review.recommendation = 'auto-merge';
    else if (review.ci === 'failure') review.recommendation = 'reject';

    return review;
  }

  _inferActionType(pr) {
    const m = (pr.head?.ref || '').match(/oada\/issue-(\d+)/);
    if (!m) return null;
    // Look up by label on the PR if available
    for (const lbl of (pr.labels || [])) {
      const name = lbl.name || '';
      if (name.startsWith('type/')) return name.slice(5).replace(/-/g, '_');
    }
    return null;
  }

  _loadPolicies() {
    if (!existsSync(this.policiesPath)) return { ...DEFAULT_POLICIES };
    try {
      const data = yaml.load(readFileSync(this.policiesPath, 'utf-8'));
      return { ...DEFAULT_POLICIES, ...(data || {}) };
    } catch (e) {
      this._log(`load policies failed: ${e.message}`, 'warning');
      return { ...DEFAULT_POLICIES };
    }
  }

  _buildReport(result) {
    const lines = [
      `# OADA Verify Report — ${result.cycle_id}`,
      `*Generated:* ${result.timestamp}`,
      '',
      `## Reviewed PRs (${result.reviewed.length})`,
    ];
    for (const r of result.reviewed) {
      lines.push(`- PR #${r.pr} \`${r.action_type || 'unknown'}\` risk=${r.risk} ci=${r.ci} → **${r.recommendation}**`);
      lines.push(`  ${r.title} — ${r.url}`);
    }
    if (result.merged.length) {
      lines.push('', `## Merged (${result.merged.length})`);
      for (const m of result.merged) lines.push(`- PR #${m.pr} ${m.success ? 'ok' : 'FAILED'}`);
    }
    return lines.join('\n');
  }

  _log(msg, level = 'info') {
    const logger = this.host.logger;
    if (!logger) return;
    const fn = logger[level] || logger.info;
    if (typeof fn === 'function') fn.call(logger, `[verify] ${msg}`);
  }
}
