import { extractMarkdownSection } from '../cli/utils/markdown-sections.mjs';

export const REPORT_SUGGESTION_LIMIT = 8;
export const REPORT_SUGGESTION_MAX_CHARS = 300;

function isTopLevelSuggestionLine(line) {
  // Top-level only: no leading indent. Nested bullets under a numbered item are ignored.
  return /^(?:\d+\.\s+|[-*]\s+)\S/.test(line);
}

function suggestionTextFromLine(line) {
  return line.replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '').trim();
}

/** Pure field-label top-level lines (e.g. **intent**: ...) merge into the previous suggestion. */
const FIELD_LABEL_LINE_RE = /^\*\*([a-z][a-z0-9_]*)\*\*\s*[:：]\s*(.*)$/i;

function clipSuggestionText(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Extract top-level numbered/bullet suggestions from the required report section
 * 「下一轮建议」/ 「Next cycle suggestions」.
 * Nested bullets under a top-level item are NOT numbered separately.
 * Top-level lines that are only `**field**: value` merge into the previous suggestion
 * (empty values dropped); without a previous suggestion they stay independent.
 * Returns { suggestions: [{ id, text }], overflow: [{ text }], truncated: boolean }.
 */
export function extractReportSuggestions(markdown, {
  limit = REPORT_SUGGESTION_LIMIT,
  maxChars = REPORT_SUGGESTION_MAX_CHARS,
} = {}) {
  const body = extractMarkdownSection(markdown, '下一轮建议')
    || extractMarkdownSection(markdown, 'Next cycle suggestions')
    || extractMarkdownSection(markdown, 'Next cycle Suggestions')
    || '';
  if (!body.trim()) {
    return { suggestions: [], overflow: [], truncated: false };
  }

  const topLevel = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!isTopLevelSuggestionLine(line)) continue;
    const text = suggestionTextFromLine(line);
    if (!text) continue;

    const fieldMatch = text.match(FIELD_LABEL_LINE_RE);
    if (fieldMatch) {
      const label = fieldMatch[1];
      const value = String(fieldMatch[2] || '').trim();
      if (!value) continue; // empty field tag — drop
      if (topLevel.length) {
        const prev = topLevel[topLevel.length - 1];
        topLevel[topLevel.length - 1] = `${prev}; ${label}: ${value}`;
        continue;
      }
      // No previous suggestion: keep as independent (defensive).
      topLevel.push(`${label}: ${value}`);
      continue;
    }

    topLevel.push(text);
  }

  const clipped = topLevel.map((text) => clipSuggestionText(text, maxChars));
  const kept = clipped.slice(0, limit);
  const overflow = clipped.slice(limit).map((text) => ({ text }));
  const suggestions = kept.map((text, idx) => ({
    id: `S${idx + 1}`,
    text,
  }));

  return {
    suggestions,
    overflow,
    truncated: overflow.length > 0,
  };
}

/** @deprecated Prefer extractReportSuggestions(...).suggestions for new callers. */
export function extractReportSuggestionList(markdown, opts = {}) {
  return extractReportSuggestions(markdown, opts).suggestions;
}

export function formatReportSuggestionsForPrompt(suggestions = [], language = 'zh') {
  const isEn = language === 'en';
  if (!Array.isArray(suggestions) || !suggestions.length) {
    return isEn ? '(none)' : '（无）';
  }
  const header = isEn
    ? 'Host-numbered suggestions from the report. Address every id in suggestion_coverage:'
    : '宿主从报告「下一轮建议」机械编号的条目。Decide JSON 的 suggestion_coverage 必须覆盖每一个编号：';
  const list = suggestions.map((s) => `${s.id}. ${s.text}`).join('\n');
  return `${header}\n\n${list}`;
}

function normalizeDisposition(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'adopted' || value === 'adopt' || value === 'queued') return 'adopted';
  if (value === 'rejected' || value === 'reject' || value === 'dropped') return 'rejected';
  if (value === 'deferred' || value === 'defer' || value === 'unaddressed') return 'deferred';
  return null;
}

function coverageMapFromAnalysis(analysis) {
  const raw = analysis?.suggestion_coverage;
  const map = new Map();
  if (!raw) return map;

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || entry.suggestion_id || entry.sid || '').trim().toUpperCase();
      if (!id) continue;
      map.set(id, {
        id,
        disposition: normalizeDisposition(entry.disposition || entry.status || entry.action),
        action_index: entry.action_index ?? entry.actionIndex ?? null,
        reason: entry.reason != null ? String(entry.reason) : null,
      });
    }
    return map;
  }

  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const id = String(key).trim().toUpperCase();
      if (!id) continue;
      if (typeof value === 'string') {
        map.set(id, {
          id,
          disposition: normalizeDisposition(value),
          action_index: null,
          reason: null,
        });
      } else if (value && typeof value === 'object') {
        map.set(id, {
          id,
          disposition: normalizeDisposition(value.disposition || value.status || value.action),
          action_index: value.action_index ?? value.actionIndex ?? null,
          reason: value.reason != null ? String(value.reason) : null,
        });
      }
    }
  }
  return map;
}

/**
 * Soft-gate reconcile: every report suggestion must have a disposition.
 * Missing entries become deferred/unaddressed. Invalid adopted action_index
 * is downgraded to deferred with a warning. Does not block the cycle.
 */
export function reconcileSuggestionCoverage({
  suggestions = [],
  analysis = null,
  queuedActions = [],
} = {}) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  const declared = coverageMapFromAnalysis(analysis);
  const actionCount = Array.isArray(queuedActions) ? queuedActions.length : 0;
  const items = [];
  const warnings = [];
  let unaddressed = 0;
  let adopted = 0;
  let deferred = 0;
  let rejected = 0;

  for (const suggestion of list) {
    const id = String(suggestion.id || '').toUpperCase();
    const declaredEntry = declared.get(id);
    let disposition = declaredEntry?.disposition || null;
    let actionIndex = declaredEntry?.action_index;
    let reason = declaredEntry?.reason || null;
    let hostFilled = false;

    if (!disposition) {
      disposition = 'deferred';
      reason = reason || 'unaddressed';
      hostFilled = true;
      unaddressed += 1;
      deferred += 1;
    } else if (disposition === 'adopted') {
      const idx = Number(actionIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= actionCount) {
        warnings.push({
          id,
          warning: 'invalid_action_index',
          action_index: actionIndex,
          action_count: actionCount,
        });
        disposition = 'deferred';
        reason = reason || `invalid_action_index:${actionIndex}`;
        actionIndex = null;
        deferred += 1;
      } else {
        adopted += 1;
      }
    } else if (disposition === 'rejected') {
      rejected += 1;
    } else {
      deferred += 1;
      if (!reason) reason = 'deferred';
    }

    items.push({
      id,
      text: suggestion.text,
      disposition,
      action_index: disposition === 'adopted' ? Number(actionIndex) : null,
      reason,
      host_filled: hostFilled,
    });
  }

  const carryoverItems = items
    .filter((item) => item.disposition === 'deferred')
    .map((item) => ({
      text: `${item.id}: ${item.text}${item.reason ? `（${item.reason}）` : ''}`,
      source: 'mechanical',
      origin: 'suggestion_deferred',
    }));

  return {
    suggestions: list,
    items,
    summary: {
      total: list.length,
      adopted,
      deferred,
      rejected,
      unaddressed,
    },
    warnings,
    carryoverItems,
  };
}
