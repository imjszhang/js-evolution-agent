/**
 * GitHub Issue Manager — publishes OADA decisions as Issues, manages lifecycle.
 *
 * Auth: GITHUB_TOKEN env var (repo scope).
 * Uses native fetch (no external deps).
 */
import { ACTION_REGISTRY } from '../decide/action-registry.mjs';

const GITHUB_API = 'https://api.github.com';

const OADA_LIFECYCLE_LABELS = [
  { name: 'oada', color: '0075ca', description: 'OADA autonomous evolution system' },
  { name: 'oada/pending', color: 'fbca04', description: 'OADA decision pending execution' },
  { name: 'oada/in-progress', color: 'e4873b', description: 'OADA decision in progress' },
  { name: 'oada/completed', color: '0e8a16', description: 'OADA decision completed' },
  { name: 'oada/failed', color: 'd93f0b', description: 'OADA decision failed' },
  { name: 'priority/high', color: 'b60205', description: 'High priority' },
  { name: 'priority/medium', color: 'e4e669', description: 'Medium priority' },
  { name: 'priority/low', color: 'bfdadc', description: 'Low priority' },
];

/** Build the full label set, including action-type labels from the registry. */
export function buildOadaLabelDefs(registry = ACTION_REGISTRY) {
  return [
    ...OADA_LIFECYCLE_LABELS,
    ...registry.toLabelDefs(),
    { name: 'type/custom', color: '7057ff', description: 'AI-proposed custom action type' },
  ];
}

export const OADA_LABEL_DEFS = buildOadaLabelDefs();
export const ACTION_TYPE_TO_LABEL = ACTION_REGISTRY.toLabelMapping();

export class IssueResult {
  /**
   * @param {object} opts
   * @param {boolean} opts.success
   * @param {number} [opts.number]
   * @param {string} [opts.url]
   * @param {string} [opts.action]
   * @param {string} [opts.error]
   */
  constructor({ success, number = 0, url = '', action = '', error = '' }) {
    this.success = success;
    this.number = number;
    this.url = url;
    this.action = action;
    this.error = error;
  }
}

export class GitHubIssueManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]    GitHub token (default: GITHUB_TOKEN env var)
   * @param {string} [opts.owner]    GitHub repo owner (default: GITHUB_REPO_OWNER env var)
   * @param {string} [opts.repo]     GitHub repo name (default: GITHUB_REPO_NAME env var)
   * @param {string} [opts.userAgent]
   * @param {object[]} [opts.labelDefs] override label definitions to ensure
   * @param {ActionTypeRegistry} [opts.actionRegistry] override action registry
   * @param {Function} [opts.logFn]
   */
  constructor({
    token = null, owner = null, repo = null, userAgent = 'js-evolution-engine',
    labelDefs = null, actionRegistry = null, logFn = null,
  } = {}) {
    this._token = token || process.env.GITHUB_TOKEN || '';
    this._owner = owner || process.env.GITHUB_REPO_OWNER || '';
    this._repo = repo || process.env.GITHUB_REPO_NAME || '';
    this._userAgent = userAgent;
    this._registry = actionRegistry || ACTION_REGISTRY;
    this._labelDefs = labelDefs || buildOadaLabelDefs(this._registry);
    this._actionTypeToLabel = this._registry.toLabelMapping();
    this._logFn = logFn || (() => {});
    this._labelsEnsured = false;
  }

  get owner() { return this._owner; }
  get repo() { return this._repo; }

  get available() { return !!this._token && !!this._owner && !!this._repo; }

  _log(message, level = 'info') { this._logFn(message, { level }); }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [opts]
   * @returns {Promise<any|null>}
   */
  async _request(method, path, { data = null, params = null } = {}) {
    if (!this._owner || !this._repo) {
      this._log('GitHub owner/repo not configured; request skipped', 'warning');
      return null;
    }
    let url = `${GITHUB_API}/repos/${this._owner}/${this._repo}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      url = `${url}?${qs}`;
    }

    /** @type {Record<string, string>} */
    const headers = {
      Authorization: `token ${this._token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': this._userAgent,
    };

    const fetchOpts = { method, headers, signal: AbortSignal.timeout(30000) };
    if (data !== null) {
      headers['Content-Type'] = 'application/json';
      fetchOpts.body = JSON.stringify(data);
    }

    try {
      const resp = await fetch(url, fetchOpts);
      const raw = await resp.text();
      if (!resp.ok) {
        this._log(`GitHub API ${method} ${path} -> ${resp.status}: ${raw.slice(0, 300)}`, 'warning');
        return null;
      }
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      this._log(`GitHub API ${method} ${path} -> ${e.message || e}`, 'warning');
      return null;
    }
  }

  async ensureLabels() {
    if (this._labelsEnsured) return;

    const existing = await this._request('GET', '/labels', { params: { per_page: '100' } });
    if (existing === null) {
      this._log('cannot fetch labels; skipping ensureLabels', 'warning');
      return;
    }

    const existingNames = new Set(
      (Array.isArray(existing) ? existing : []).filter(l => l && l.name).map(l => l.name),
    );

    let created = 0;
    for (const lblDef of this._labelDefs) {
      if (existingNames.has(lblDef.name)) continue;
      const result = await this._request('POST', '/labels', { data: lblDef });
      if (result !== null) created++;
    }

    if (created > 0) this._log(`created ${created} GitHub labels`);
    this._labelsEnsured = true;
  }

  /**
   * @param {string} title
   * @param {string} body
   * @param {string[]} labels
   * @returns {Promise<IssueResult>}
   */
  async createIssue(title, body, labels) {
    const result = await this._request('POST', '/issues', { data: { title, body, labels } });
    if (result === null) {
      return new IssueResult({ success: false, action: 'skipped', error: 'API call failed' });
    }
    return new IssueResult({
      success: true, number: result.number || 0, url: result.html_url || '', action: 'created',
    });
  }

  /**
   * @param {string[]} labels
   * @returns {Promise<object[]>}
   */
  async listOpenIssues(labels) {
    const result = await this._request('GET', '/issues', {
      params: { state: 'open', labels: labels.join(','), per_page: '30' },
    });
    if (result === null || !Array.isArray(result)) return [];
    return result;
  }

  /**
   * @param {number} issueNumber
   * @param {string} body
   * @returns {Promise<boolean>}
   */
  async addComment(issueNumber, body) {
    const result = await this._request('POST', `/issues/${issueNumber}/comments`, { data: { body } });
    return result !== null;
  }

  /**
   * @param {number} issueNumber
   * @param {object} [opts]
   * @returns {Promise<boolean>}
   */
  async updateLabels(issueNumber, { addLabels = null, removeLabels = null } = {}) {
    const current = await this._request('GET', `/issues/${issueNumber}/labels`);
    if (current === null) return false;

    const currentNames = new Set(
      (Array.isArray(current) ? current : []).filter(l => l && l.name).map(l => l.name),
    );
    const removals = new Set(removeLabels || []);
    const additions = new Set(addLabels || []);
    const newNames = new Set([...currentNames].filter(n => !removals.has(n)));
    for (const a of additions) newNames.add(a);

    const result = await this._request('PUT', `/issues/${issueNumber}/labels`, {
      data: { labels: [...newNames].sort() },
    });
    return result !== null;
  }

  /**
   * @param {number} issueNumber
   * @param {string} [comment]
   * @returns {Promise<boolean>}
   */
  async closeIssue(issueNumber, comment = null) {
    if (comment) await this.addComment(issueNumber, comment);
    const result = await this._request('PATCH', `/issues/${issueNumber}`, {
      data: { state: 'closed' },
    });
    return result !== null;
  }

  /**
   * @param {number} issueNumber
   * @returns {Promise<boolean>}
   */
  async hasLinkedPr(issueNumber) {
    const prs = await this._request('GET', '/pulls', { params: { state: 'open', per_page: '50' } });
    if (!prs || !Array.isArray(prs)) return false;

    const branchName = `oada/issue-${issueNumber}`;
    const pattern = new RegExp(`(?:closes|fixes)\\s+#${issueNumber}\\b`, 'i');

    for (const pr of prs) {
      const head = pr.head || {};
      if (head.ref === branchName) return true;
      if (pattern.test(pr.body || '')) return true;
    }
    return false;
  }

  /**
   * @param {string} title
   * @param {string} body
   * @param {string} head
   * @param {string} [base]
   * @returns {Promise<object|null>}
   */
  async createPullRequest(title, body, head, base = 'main') {
    return this._request('POST', '/pulls', { data: { title, body, head, base } });
  }

  /**
   * @param {string} [headPrefix]
   * @returns {Promise<object[]>}
   */
  async listOpenPulls(headPrefix = 'oada/issue-') {
    const prs = await this._request('GET', '/pulls', { params: { state: 'open', per_page: '100' } });
    if (!prs || !Array.isArray(prs)) return [];
    return prs.filter(pr => (pr.head?.ref || '').startsWith(headPrefix));
  }

  /**
   * @param {string} sha
   * @returns {Promise<object[]>}
   */
  async getCheckRuns(sha) {
    const result = await this._request('GET', `/commits/${sha}/check-runs`);
    if (!result || typeof result !== 'object') return [];
    return result.check_runs || [];
  }

  /**
   * @param {number} prNumber
   * @param {object} [opts]
   * @returns {Promise<boolean>}
   */
  async mergePullRequest(prNumber, { mergeMethod = 'squash', commitTitle = null } = {}) {
    const data = { merge_method: mergeMethod };
    if (commitTitle) data.commit_title = commitTitle;
    const result = await this._request('PUT', `/pulls/${prNumber}/merge`, { data });
    return result !== null && result.merged === true;
  }

  /**
   * @param {object} issue
   * @returns {object|null}
   */
  static parseActionFromIssue(issue) {
    const body = (issue.body || '').trim();
    if (!body) return null;

    const action = {};
    const typeM = body.match(/\*\*Type:\*\*\s*`(\w+)`/);
    if (typeM) action.type = typeM[1];

    const prioM = body.match(/\*\*Priority:\*\*\s*`(\w+)`/);
    if (prioM) action.priority = prioM[1];

    const descM = body.match(/## Description\s*\n\n([\s\S]*?)(?=\n## |\n---|\Z)/);
    if (descM) action.description = descM[1].trim();

    const paramsM = body.match(/## Parameters\s*\n\n```json\n([\s\S]*?)\n```/);
    if (paramsM) {
      try { action.params = JSON.parse(paramsM[1]); } catch { action.params = {}; }
    }

    const goalM = body.match(/\*\*Serves Goal:\*\*\s*(.+)/);
    if (goalM) action.serves_goal = goalM[1].trim();

    const aiM = body.match(/\*\*AI-driven:\*\*\s*(Yes|No)/);
    if (aiM) action.ai_driven = aiM[1] === 'Yes';

    if (!action.type) return null;
    return action;
  }

  /**
   * @param {object} action
   * @param {string} cycleId
   * @param {string} analysisContext
   * @param {string} timestamp
   * @param {boolean} [dryRun]
   * @returns {Promise<IssueResult>}
   */
  async publishAction(action, cycleId, analysisContext, timestamp, dryRun = false) {
    const actionType = action.type || 'unknown';
    const description = action.description || actionType;
    const priority = action.priority || 'medium';
    const isCustom = action.custom || false;

    const typeLabel = isCustom ? 'type/custom' : (this._actionTypeToLabel[actionType] || `type/${actionType}`);
    const priorityLabel = `priority/${priority}`;
    const labels = ['oada', 'oada/pending', typeLabel, priorityLabel];

    const title = `[OADA] ${description}`;
    const body = this._formatIssueBody(action, cycleId, analysisContext, timestamp);

    if (dryRun) {
      const updateNum = action.update_issue;
      if (updateNum) {
        this._log(`  [dry-run] update Issue #${updateNum}: ${description}`);
      } else {
        this._log(`  [dry-run] create Issue: ${title}`);
      }
      this._log(`            Labels: ${labels.join(', ')}`);
      return new IssueResult({ success: true, action: 'skipped' });
    }

    await this.ensureLabels();

    const updateNum = action.update_issue;
    if (typeof updateNum === 'number' && updateNum > 0) {
      const comment = [
        '## New cycle update\n',
        `**Cycle:** \`${cycleId}\``,
        `**Time:** ${timestamp}\n`,
        `### Latest analysis\n${analysisContext}\n`,
        `### Action Spec\n\`\`\`json\n${JSON.stringify(action, null, 2)}\n\`\`\``,
      ].join('\n');
      const ok = await this.addComment(updateNum, comment);
      if (ok) {
        this._log(`  updated #${updateNum}: ${description}`);
        const url = `https://github.com/${this._owner}/${this._repo}/issues/${updateNum}`;
        return new IssueResult({ success: true, number: updateNum, url, action: 'deduplicated' });
      }
      this._log(`  update #${updateNum} failed; creating new instead`, 'warning');
    }

    const result = await this.createIssue(title, body, labels);
    if (result.success) this._log(`  Issue #${result.number}: ${title}`);
    return result;
  }

  _formatIssueBody(action, cycleId, analysisContext, timestamp) {
    const actionType = action.type || 'unknown';
    const priority = action.priority || 'medium';
    const description = action.description || '';
    const expectedImpact = action.expected_impact || '';
    const params = action.params || {};
    const aiDriven = action.ai_driven || false;
    const servesGoal = action.serves_goal || '';

    const parts = [
      '## Action Spec\n',
      `- **Type:** \`${actionType}\``,
      `- **Priority:** \`${priority}\``,
      `- **AI-driven:** ${aiDriven ? 'Yes' : 'No'}`,
    ];
    if (servesGoal) parts.push(`- **Serves Goal:** ${servesGoal}`);
    if (expectedImpact) parts.push(`- **Expected Impact:** ${expectedImpact}`);
    parts.push(`\n## Description\n\n${description}`);

    if (Object.keys(params).length) {
      parts.push(`\n## Parameters\n\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``);
    }

    if (analysisContext) parts.push(`\n## Analysis Context\n\n${analysisContext}`);

    parts.push(
      `\n---\n*Cycle:* \`${cycleId}\` | *Created:* ${timestamp}\n*Generated by oada-intel pipeline*`,
    );

    return parts.join('\n');
  }
}
