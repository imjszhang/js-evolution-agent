/**
 * AI-Driven Observer — goal-aware autonomous exploration.
 *
 * Provides minimal bootstrap context (goals + project intro + directory tree
 * + current time + previous-cycle recap) and lets the AI agent autonomously
 * decide what data to explore. Outputs a Markdown observation report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanProjectStructure } from './project-scanner.mjs';

const DEFAULT_PROJECT_INTRO =
  'This is an autonomous agent project. The OADA loop continuously observes runtime data, analyzes patterns, and proposes actions to evolve the system.';

function bjHumanStr() {
  const d = new Date();
  const bj = new Date(d.getTime() + 8 * 3600000);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day = days[bj.getUTCDay()];
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(bj.getUTCDate()).padStart(2, '0');
  const hh = String(bj.getUTCHours()).padStart(2, '0');
  const mm = String(bj.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${dd} ${hh}:${mm} (${day})`;
}

export class AIDrivenObserver {
  /**
   * @param {object} opts
   * @param {object} opts.aiClient AI client (must implement `chat(msg, thinking, timeout)`)
   * @param {object} [opts.host]   HostContext (used for logger / domain hooks)
   * @param {object} [opts.evolutionLogger]
   * @param {string} [opts.goalsText]
   * @param {string} [opts.rules]  Operating rules / constraints injected into prompt
   * @param {string} [opts.projectIntro] override project introduction paragraph
   * @param {string} [opts.projectRoot]  default: process.cwd()
   * @param {object} [opts.logger]
   */
  constructor({
    aiClient, host = null, logger = null, evolutionLogger = null,
    goalsText = '', rules = '', projectIntro = '', projectRoot = null,
  }) {
    this.host = host;
    this.aiClient = aiClient;
    this.logger = logger || host?.logger || null;
    this.evolutionLogger = evolutionLogger;
    this.goalsText = goalsText;
    this.rules = rules;
    this.projectIntro = projectIntro;
    this.projectRoot = projectRoot || host?.basePath || process.cwd();
  }

  /** @returns {Promise<object>} */
  async observe() {
    const results = {
      timestamp: new Date().toISOString(),
      ai_driven: true,
      observation_report: '',
      _prompt: '',
    };

    this._log('starting AI-driven observation...');

    const prompt = this._buildObservePrompt();
    results._prompt = prompt;
    const timeout = this.aiClient.model ? 600 : 300;
    this._log(`calling AI for autonomous exploration (thinking=medium, timeout=${timeout}s)...`);
    const reportText = await this.aiClient.chat(prompt, 'medium', timeout);

    const reportStripped = (reportText || '').trim();
    const errSigs = ['request timed out', 'request was aborted', 'error'];
    const lowerHead = reportStripped.slice(0, 50).toLowerCase();
    if (reportStripped.length < 200 || errSigs.some(s => lowerHead.startsWith(s))) {
      throw new Error(
        `AI observation report invalid (${reportStripped.length} chars): ${reportStripped.slice(0, 120)}`,
      );
    }

    results.observation_report = reportText;
    this._log(`observation complete: report ${reportText.length} chars`);
    return results;
  }

  _buildObservePrompt() {
    const intro = this.projectIntro || this._loadProjectIntro();
    const lastCycle = this._loadLastCycleContext();
    const projectTree = this._scanProjectStructure();
    const nowHuman = bjHumanStr();

    const sections = [
      'You are an intelligence analyst. Conduct a current-state observation of the project below.',
      intro,
    ];

    if (this.goalsText) sections.push(this.goalsText);
    if (lastCycle) sections.push(lastCycle);

    sections.push(`## Project Directory Structure\n\n\`\`\`\n${projectTree}\n\`\`\``);
    sections.push(`## Current Time\n\nBeijing time: ${nowHuman}`);

    if (this.rules) sections.push(this.rules);

    const changeNote = lastCycle ? ' (especially changes since the last cycle)' : '';
    sections.push(
      'Based on the goals above, autonomously explore the files and data in this project ' +
      'and produce a complete Markdown observation report.\n\n' +
      'You must locate goal-relevant data files in the directory tree and read them yourself.\n\n' +
      'Output requirements:\n' +
      '- Strictly center on the focus goal stated above; respect the document\'s requested depth distribution\n' +
      '- Cite specific numbers; tag data sources and timestamps\n' +
      `- Highlight changes and anomalies${changeNote}\n` +
      '- Be objective and balanced — record both good and bad signals\n' +
      '- Flag information gaps explicitly\n\n' +
      'Hard constraints (violations are report defects):\n' +
      '- Before declaring "stagnation/anomaly/blocked", verify the criteria in the OADA Rules section.\n' +
      '- Two data points from the same snapshot (identical mtime) cannot be used to argue "no change == stagnation".\n\n' +
      'Important: output the complete observation report directly. Do not output an exploration plan or intermediate steps.',
    );

    return sections.join('\n\n');
  }

  _loadProjectIntro() {
    try {
      const readmePath = join(this.projectRoot, 'README.md');
      if (existsSync(readmePath)) {
        const readme = readFileSync(readmePath, 'utf-8');
        // Match either "## Overview" / "## Introduction" / "## 项目概述" / first level-2 section
        const candidates = [
          /## (?:Overview|Introduction|Project Overview)\s*\n([\s\S]*?)(?=\n## )/,
          /## 项目概述\s*\n([\s\S]*?)(?=\n## )/,
          /^# .+?\n([\s\S]*?)(?=\n## )/m,
        ];
        for (const re of candidates) {
          const match = readme.match(re);
          if (match) {
            let text = match[1].trim();
            if (text.length > 600) text = text.slice(0, 600) + '...';
            if (text) return text;
          }
        }
      }
    } catch {}

    return DEFAULT_PROJECT_INTRO;
  }

  /** @returns {string|null} */
  _loadLastCycleContext() {
    if (!this.evolutionLogger) return null;

    let last = null;
    try {
      const cycles = this.evolutionLogger.listCycles(5);
      for (const c of cycles) {
        if (c.success) { last = c; break; }
      }
      if (!last) return null;
    } catch { return null; }

    const cycleId = last.cycle_id || '';
    const cycleDir = join(this.evolutionLogger.recordsDir, cycleId);
    if (!existsSync(cycleDir)) return null;

    const endTimeStr = last.end_time || '';
    let ago = '';
    if (endTimeStr) {
      try {
        const endDt = new Date(endTimeStr);
        const totalMin = Math.floor((Date.now() - endDt.getTime()) / 60000);
        if (totalMin < 60) ago = `${totalMin}m ago`;
        else if (totalMin < 1440) ago = `${Math.floor(totalMin / 60)}h${totalMin % 60}m ago`;
        else ago = `${Math.floor(totalMin / 1440)}d ago`;
      } catch {}
    }

    const lines = ['## Previous Cycle Recap\n'];
    let timeLabel = endTimeStr ? endTimeStr.slice(0, 16) : 'unknown';
    if (ago) timeLabel += ` (${ago})`;
    lines.push(`Last observation: ${timeLabel}`);
    lines.push(`Cycle: \`${cycleId}\``);

    const lastGoalId = last.goal_id;
    if (lastGoalId) {
      lines.push(`Previous focus goal: \`${lastGoalId}\` (note: this round's goal may differ; do not anchor on the previous focus)`);
    } else {
      lines.push('Previous viewpoint: global');
    }

    const obsFile = join(cycleDir, 'observation_report.md');
    if (existsSync(obsFile)) {
      try {
        let obsText = readFileSync(obsFile, 'utf-8').trim();
        if (obsText.length > 800) obsText = obsText.slice(0, 800) + '\n...(truncated)';
        lines.push(`\nPrevious observation summary:\n\n> ${obsText}`);
      } catch {}
    }

    const decFile = join(cycleDir, 'decision_summary.md');
    if (existsSync(decFile)) {
      try {
        let decText = readFileSync(decFile, 'utf-8').trim();
        if (decText.length > 500) decText = decText.slice(0, 500) + '\n...(truncated)';
        lines.push(`\nPrevious decisions:\n\n> ${decText}`);
      } catch {}
    }

    if (lines.length <= 3) return null;

    lines.push('\nFocus on changes and new developments since the last observation.');
    return lines.join('\n');
  }

  _scanProjectStructure(maxChars = 3000) {
    return scanProjectStructure(this.projectRoot, { maxChars });
  }

  _log(message, level = 'info') {
    if (this.logger) {
      const fn = this.logger[level] || this.logger.info;
      if (typeof fn === 'function') fn.call(this.logger, message);
    }
  }
}
