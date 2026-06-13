/**
 * SelfAnalyzer — minimal rule-based fallback used when AI analysis fails.
 *
 * Performs a generic execution-log analysis (success rate, error patterns,
 * command stats). Domain-specific analysis (platform metrics, content
 * performance, etc.) is the host's responsibility — pass an
 * `analyticsReader` adapter to enrich, or subclass `SelfAnalyzer` for
 * fully custom logic.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isoBeijing } from '../core/time.mjs';

export class SelfAnalyzer {
  /**
   * @param {object} opts
   * @param {string} opts.projectRoot
   * @param {object} [opts.client]            domain API client (passed to analyticsReader)
   * @param {object} [opts.logger]
   * @param {object} [opts.analyticsReader]   optional host adapter exposing `generateAnalysisForOada(days)`
   */
  constructor({ projectRoot, client = null, logger = null, analyticsReader = null }) {
    this.projectRoot = projectRoot;
    this.client = client;
    this.logger = logger;
    this.analyticsReader = analyticsReader;
    this.dataDir = join(projectRoot, 'data');
  }

  /**
   * @param {object} [observation] data from AIDrivenObserver
   * @returns {object}
   */
  analyzeAll(observation = null) {
    const analysis = {
      timestamp: isoBeijing(),
      platform: this._analyzePlatform(observation),
      execution: this._analyzeExecutionLogs(observation),
      content: {},
      insights: [],
      recommendations: [],
    };

    if (this.analyticsReader && typeof this.analyticsReader.generateAnalysisForOada === 'function') {
      try {
        analysis.historical_analytics = this.analyticsReader.generateAnalysisForOada(7);
      } catch (e) {
        this._warn(`historical analytics failed: ${e.message || e}`);
      }
    }

    return analysis;
  }

  _analyzePlatform(observation) {
    if (!observation) return {};
    const meta = observation.meta_scan || {};
    const quickStats = meta.quick_stats || {};
    return { ...quickStats };
  }

  _analyzeExecutionLogs(observation = null) {
    const result = {
      total_executions: 0, success_rate: 0, avg_duration_ms: 0,
      error_patterns: [], command_stats: {},
    };

    try {
      let logs = null;
      if (observation) {
        const deepDive = observation.deep_dive || {};
        const execData = deepDive.execution_logs || {};
        if (execData && !execData.error) {
          logs = execData.logs || execData.entries || [];
        }
      }

      if (!logs) logs = this._loadRecentExecutionLogs(7);
      if (!logs || !logs.length) return result;

      result.total_executions = logs.length;
      const successCount = logs.filter(l => l.success).length;
      result.success_rate = logs.length ? successCount / logs.length : 0;

      const durations = logs.filter(l => l.duration_ms).map(l => l.duration_ms);
      if (durations.length) result.avg_duration_ms = durations.reduce((s, d) => s + d, 0) / durations.length;

      const errorCounts = {};
      for (const l of logs) {
        if (l.error) {
          const key = (l.error || '').slice(0, 100);
          errorCounts[key] = (errorCounts[key] || 0) + 1;
        }
      }
      result.error_patterns = Object.entries(errorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([error, count]) => ({ error, count }));

      const commandStats = {};
      for (const l of logs) {
        const cmd = l.command || 'unknown';
        if (!commandStats[cmd]) commandStats[cmd] = { total: 0, success: 0 };
        commandStats[cmd].total++;
        if (l.success) commandStats[cmd].success++;
      }
      result.command_stats = commandStats;
    } catch (e) {
      this._warn(`execution log analysis failed: ${e.message || e}`);
    }

    return result;
  }

  /** @param {object} analysis @returns {object[]} */
  generateInsights(analysis) {
    const insights = [];
    const execStats = analysis.execution || {};
    const successRate = execStats.success_rate || 0;
    if (execStats.total_executions > 0 && successRate < 0.8) {
      insights.push({
        type: 'warning', category: 'reliability', title: 'Low success rate',
        description: `Past 7 days success rate is only ${(successRate * 100).toFixed(1)}%`,
        priority: 'high',
      });
    }
    return insights;
  }

  /**
   * @param {object} _analysis
   * @param {object[]} insights
   * @returns {object[]}
   */
  generateRecommendations(_analysis, insights) {
    const recommendations = [];
    for (const insight of insights) {
      if (insight.category === 'reliability') {
        recommendations.push({
          action: 'Investigate execution failures',
          steps: ['inspect recent error logs', 'verify external dependencies', 'add retry/backoff'],
          auto_fixable: false, priority: 'high',
        });
      }
    }
    return recommendations;
  }

  /**
   * Load recent execution logs (JSONL files under data/execution_logs/).
   * Generic format: each line is a JSON object with optional fields:
   *   { command, success, duration_ms, error, timestamp }
   * @param {number} [days]
   * @returns {object[]}
   */
  _loadRecentExecutionLogs(days = 7) {
    try {
      const dir = join(this.dataDir, 'execution_logs');
      if (!existsSync(dir)) return [];
      const cutoff = Date.now() - days * 86400000;
      const out = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = join(dir, file);
        try {
          const content = readFileSync(fullPath, 'utf-8');
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);
              const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
              if (ts >= cutoff) out.push(entry);
            } catch {}
          }
        } catch {}
      }
      return out;
    } catch { return []; }
  }

  _warn(msg) { if (this.logger?.warning) this.logger.warning(msg); }
}
