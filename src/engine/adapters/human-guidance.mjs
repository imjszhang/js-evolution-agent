/**
 * Human Guidance — operator writes advice to data/evolution/human_guidance.md,
 * OADA reads it at cycle start and injects into AI prompt context.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// (no external time dep needed)

const DEFAULT_GUIDANCE_PATH = 'data/evolution/human_guidance.md';
const DEFAULT_CURRENT_SECTION = '## Current';
const DEFAULT_PROCESSED_SECTION = '## Processed';

export class HumanGuidanceReader {
  /**
   * @param {string} projectRoot
   * @param {object} [logger]
   * @param {object} [opts]
   * @param {string} [opts.guidancePath] override guidance file path
   * @param {string} [opts.currentSection] e.g. "## Current" (markdown header line, exact match)
   * @param {string} [opts.processedSection] e.g. "## Processed"
   */
  constructor(projectRoot, logger = null, opts = {}) {
    this.projectRoot = projectRoot;
    this.guidancePath = opts.guidancePath ? (opts.guidancePath.startsWith('/') ? opts.guidancePath : join(projectRoot, opts.guidancePath)) : join(projectRoot, DEFAULT_GUIDANCE_PATH);
    this.currentSection = opts.currentSection || DEFAULT_CURRENT_SECTION;
    this.processedSection = opts.processedSection || DEFAULT_PROCESSED_SECTION;
    this.logger = logger;
  }

  _escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  _currentRe() { return new RegExp(`^${this._escapeRegex(this.currentSection)}\\s*$`, 'm'); }
  _processedRe() { return new RegExp(`^${this._escapeRegex(this.processedSection)}\\s*$`, 'm'); }

  /** @returns {string|null} */
  readGuidance() {
    if (!existsSync(this.guidancePath)) {
      this._log('human_guidance file not found, skipping');
      return null;
    }
    let content;
    try { content = readFileSync(this.guidancePath, 'utf-8'); }
    catch (e) { this._log(`read human_guidance failed: ${e.message}`, 'warning'); return null; }

    const currentSection = this._extractCurrentSection(content);
    if (!currentSection || !currentSection.trim()) {
      this._log('current guidance section is empty, skipping');
      return null;
    }

    const lines = currentSection.trim().split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('<!--'));
    if (!lines.length) return null;

    this._log(`loaded ${lines.length} guidance line(s)`);
    return lines.join('\n');
  }

  /** @param {string} cycleId */
  markAsProcessed(cycleId) {
    if (!existsSync(this.guidancePath)) return false;
    let content;
    try { content = readFileSync(this.guidancePath, 'utf-8'); }
    catch (e) { this._log(`read human_guidance failed: ${e.message}`, 'warning'); return false; }

    const currentSection = this._extractCurrentSection(content);
    if (!currentSection || !currentSection.trim()) {
      this._log('nothing to mark as processed');
      return false;
    }

    const suggestionLines = currentSection.trim().split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('<!--'));
    if (!suggestionLines.length) return false;

    const now = new Date();
    const timestamp = `${now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })} ${now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })}`;
    let processedEntry = `\n### ${timestamp} (cycle: ${cycleId})\n`;
    for (const line of suggestionLines) processedEntry += `${line}\n`;

    try {
      const newContent = this._rebuildFile(content, processedEntry);
      writeFileSync(this.guidancePath, newContent, 'utf-8');
      this._log(`marked ${suggestionLines.length} guidance line(s) as processed (cycle: ${cycleId})`);
      return true;
    } catch (e) {
      this._log(`mark processed failed: ${e.message}`, 'error');
      return false;
    }
  }

  _extractCurrentSection(content) {
    const currentMatch = content.match(this._currentRe());
    if (!currentMatch) return null;
    const start = currentMatch.index + currentMatch[0].length;
    const restContent = content.slice(start);
    const processedMatch = restContent.match(this._processedRe());
    const end = processedMatch ? start + processedMatch.index : content.length;
    return content.slice(start, end);
  }

  _rebuildFile(content, processedEntry) {
    const currentMatch = content.match(this._currentRe());
    const processedMatch = content.match(this._processedRe());
    if (!currentMatch || !processedMatch) return content;

    const beforeCurrent = content.slice(0, currentMatch.index + currentMatch[0].length);
    const clearedCurrent = '\n\n';
    const processedHeader = this.processedSection + '\n';
    const originalProcessed = content.slice(processedMatch.index + processedMatch[0].length);

    return beforeCurrent + clearedCurrent + processedHeader + processedEntry + originalProcessed;
  }

  _log(message, level = 'info') {
    if (this.logger) (this.logger[level] || this.logger.info).call(this.logger, message);
  }
}
