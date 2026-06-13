/**
 * Goal Provider — renders goal context for OADA prompts.
 *
 * Reads nested tree-shaped goals from data/goals/active_goals.json,
 * selects a subtree and renders it at different detail levels.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FALLBACK_MISSION = 'Improve the system continuously and align with the operator\'s intent.';

export class GoalProvider {
  /**
   * @param {string} projectRoot
   * @param {object} [logger]
   * @param {object} [opts]
   * @param {string} [opts.goalsPath] override path to active_goals.json (default: <projectRoot>/data/goals/active_goals.json)
   * @param {{id?: string, name?: string, intent?: string, good_signal?: string, bad_signal?: string, children?: any[]}} [opts.fallbackTree]
   */
  constructor(projectRoot, logger = null, { goalsPath, fallbackTree } = {}) {
    this._path = goalsPath || join(projectRoot, 'data', 'goals', 'active_goals.json');
    this._logger = logger;
    this._fallback = fallbackTree || null;
    /** @type {Record<string, any>} */
    this._tree = {};
    this._load();
  }

  _load() {
    try {
      this._tree = JSON.parse(readFileSync(this._path, 'utf-8'));
    } catch (e) {
      if (this._logger) this._logger.warning(`Goal file load failed (${this._path}): ${e.message}, using fallback`);
      this._tree = this._fallback || GoalProvider._defaultFallback();
    }
  }

  static _defaultFallback() {
    return {
      id: 'ultimate', name: 'Mission', intent: FALLBACK_MISSION,
      good_signal: 'Operator confirms steady, useful progress',
      bad_signal: 'Stagnation, regression, or operator dissatisfaction',
      children: [],
    };
  }

  findNode(goalId) { return GoalProvider._find(this._tree, goalId); }

  static _find(node, goalId) {
    if (node.id === goalId) return node;
    for (const child of (node.children || [])) {
      const found = GoalProvider._find(child, goalId);
      if (found) return found;
    }
    return null;
  }

  static _findPath(node, goalId, path = []) {
    const current = [...path, node];
    if (node.id === goalId) return current;
    for (const child of (node.children || [])) {
      const result = GoalProvider._findPath(child, goalId, current);
      if (result) return result;
    }
    return null;
  }

  /**
   * Full goal context for Analyze + Decide (with signals).
   * @param {string} [goalId]
   * @returns {string}
   */
  formatForPrompt(goalId = null) {
    if (!goalId) {
      const lines = ['## 本轮目标\n'];
      GoalProvider._renderNode(this._tree, 0, lines);
      return lines.join('\n');
    }

    const path = GoalProvider._findPath(this._tree, goalId);
    if (!path) {
      if (this._logger) this._logger.warning(`目标 ${goalId} 未找到，fallback 到根节点`);
      const lines = ['## 本轮目标\n'];
      GoalProvider._renderNode(this._tree, 0, lines);
      return lines.join('\n');
    }

    if (path.length === 1) {
      const lines = ['## 本轮目标\n'];
      GoalProvider._renderNode(path[0], 0, lines);
      return lines.join('\n');
    }

    const lines = ['## 本轮目标\n'];
    for (const ancestor of path.slice(0, -1)) GoalProvider._renderAncestor(ancestor, 0, lines);
    lines.push('---\n');
    GoalProvider._renderNode(path[path.length - 1], 0, lines);
    return lines.join('\n');
  }

  /**
   * Lightweight goal context for Observe phase.
   * @param {string} [goalId]
   * @returns {string}
   */
  formatForObserve(goalId = null) {
    if (!goalId) {
      const root = this._tree;
      const lines = ['## 当前目标\n'];
      lines.push(`### ⚡ 本轮聚焦：${root.name || '?'}`);
      lines.push('');
      lines.push(root.intent || '');
      if (root.good_signal) lines.push(`- 好的信号：${root.good_signal}`);
      if (root.bad_signal) lines.push(`- 坏的信号：${root.bad_signal}`);
      const children = root.children || [];
      if (children.length) {
        const names = children.map(c => c.name || '?').join(' / ');
        lines.push(`\n为此需关注以下子维度：${names}`);
      }
      lines.push('');
      lines.push(
        `**重要：本轮是全局视角，聚焦于「${root.name || '?'}」。` +
        '报告应均衡覆盖上述所有子维度，评估各维度对终极使命的贡献。' +
        '不要偏重某一个子目标——即使上轮观察聚焦了某个特定子目标。**'
      );
      return lines.join('\n');
    }

    const path = GoalProvider._findPath(this._tree, goalId);
    if (!path) {
      if (this._logger) this._logger.warning(`目标 ${goalId} 未找到，fallback 到根节点`);
      return this.formatForObserve(null);
    }

    const root = this._tree;
    const target = path[path.length - 1];
    const lines = ['## 当前目标\n'];

    if (target.id !== root.id) {
      lines.push(`> 战略背景：${root.intent || ''}`);
      lines.push('');
      lines.push(`### ⚡ 本轮聚焦目标：${target.name || '?'}`);
      lines.push('');
      lines.push(target.intent || '');
      if (target.good_signal) lines.push(`- 好的信号：${target.good_signal}`);
      if (target.bad_signal) lines.push(`- 坏的信号：${target.bad_signal}`);
      lines.push('');
      lines.push(
        `**重要：本轮观察必须以「${target.name || '?'}」为核心。` +
        '报告 ≥70% 的篇幅应围绕此目标展开——相关数据、趋势、机会、风险。' +
        '其他维度（平台排名、内容生产等）仅作简要背景提及，不要喧宾夺主。**'
      );
    } else {
      lines.push(`**${root.name || '?'}**：${root.intent || ''}`);
      const children = root.children || [];
      if (children.length) {
        const names = children.map(c => c.name || '?').join(' / ');
        lines.push(`\n子目标：${names}`);
      }
    }
    return lines.join('\n');
  }

  static _renderAncestor(node, depth, lines) {
    const prefix = '#'.repeat(depth + 3);
    lines.push(`${prefix} ${node.name || '?'}（战略背景）`);
    lines.push(node.intent || '');
    lines.push('');
  }

  static _renderNode(node, depth, lines) {
    const prefix = '#'.repeat(depth + 3);
    lines.push(`${prefix} ${node.name || '?'}`);
    lines.push(node.intent || '');
    if (node.good_signal) lines.push(`- 好的信号：${node.good_signal}`);
    if (node.bad_signal) lines.push(`- 坏的信号：${node.bad_signal}`);
    lines.push('');
    for (const child of (node.children || [])) GoalProvider._renderNode(child, depth + 1, lines);
  }
}
