/**
 * Cycle Journal — intra-exec shared notes for sibling actions in the same cycle.
 *
 * Host mechanically extracts one-line notes from action results / receipts and
 * injects them into later agent_run prompts ("Earlier actions this cycle").
 * Storage layer is the existing action_receipts store; this module is the
 * extract → inject pipe (plus optional agent handoff_note).
 */
import { redactSecrets } from '../intelligence/redaction.mjs';

export const EXEC_JOURNAL_MAX_ENTRIES = 12;
export const EXEC_JOURNAL_MAX_LINE_CHARS = 240;
export const EXEC_JOURNAL_SUMMARY_CHARS = 200;
export const EXEC_JOURNAL_HANDOFF_CHARS = 300;

const PROMPT_BEHAVIOR = [
  'If a line above contradicts your task premise, verify the premise first and say so in your receipt instead of duplicating or reversing the work.',
  'Do not treat these notes as Seen facts; they are sibling execution summaries from this cycle only.',
].join(' ');

/**
 * Normalize optional agent handoff_note to a single redacted line.
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {string|null}
 */
export function normalizeHandoffNote(value, maxChars = EXEC_JOURNAL_HANDOFF_CHARS) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const clipped = text.slice(0, Math.max(1, maxChars));
  const redacted = redactSecrets(clipped);
  return typeof redacted === 'string' ? redacted : clipped;
}

function clipLine(text, maxChars) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  if (one.length <= maxChars) return one;
  return `${one.slice(0, Math.max(1, maxChars - 1))}…`;
}

function statusFromResult(result = {}) {
  if (result?.dry_run) return 'dry_run';
  if (result?.status) return String(result.status);
  if (result?.success) return 'completed';
  if (result?.deferred) return 'deferred';
  if (result?.error) return 'failed';
  return 'unknown';
}

function summaryFromResult(result = {}) {
  const handoff = normalizeHandoffNote(result?.handoff_note);
  if (handoff) return handoff;
  const candidates = [
    result?.summary,
    result?.message,
    result?.error,
    result?.agent?.summary,
    result?.agentic_execution?.message,
  ];
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim();
  }
  return '';
}

/**
 * Build a journal line from structured fields (already normalized).
 */
export function formatJournalLine(entry, {
  maxLineChars = EXEC_JOURNAL_MAX_LINE_CHARS,
  summaryChars = EXEC_JOURNAL_SUMMARY_CHARS,
} = {}) {
  const seq = entry?.seq ?? '?';
  const source = entry?.source || 'queue';
  const actionType = entry?.actionType || entry?.action_type || 'unknown';
  const status = entry?.status || 'unknown';
  const summary = clipLine(entry?.summary || '', summaryChars) || '(no summary)';
  const receiptId = entry?.receiptId || entry?.receipt_id || null;
  const decisionId = entry?.decisionId || entry?.decision_id || null;
  const tail = receiptId
    ? ` (receipt ${receiptId})`
    : (decisionId ? ` (decision ${decisionId})` : '');
  const raw = `[${seq} ${source} ${actionType} ${status}] ${summary}${tail}`;
  const redacted = redactSecrets(raw);
  return clipLine(typeof redacted === 'string' ? redacted : raw, maxLineChars);
}

function entryFromReceipt(receipt, seq) {
  const result = receipt?.result || {};
  const action = receipt?.action || {};
  const handoff = normalizeHandoffNote(result?.handoff_note ?? action?.handoff_note);
  return {
    seq,
    source: receipt?.metadata?.guard || receipt?.guard_id ? 'guard' : 'queue',
    decisionId: receipt?.decision_id ?? null,
    actionType: receipt?.action_type || action?.type || 'unknown',
    status: statusFromResult(result),
    summary: handoff || summaryFromResult(result) || action?.description || '',
    handoffNote: handoff,
    receiptId: receipt?.id ?? null,
    line: null,
  };
}

/**
 * @param {object} [opts]
 * @param {string|null} [opts.cycleId]
 * @param {object|null} [opts.store] intelligence store with readActionReceipts
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.maxLineChars]
 * @param {number} [opts.summaryChars]
 */
export function createExecJournal({
  cycleId = null,
  executionId = null,
  reactionId = null,
  store = null,
  maxEntries = EXEC_JOURNAL_MAX_ENTRIES,
  maxLineChars = EXEC_JOURNAL_MAX_LINE_CHARS,
  summaryChars = EXEC_JOURNAL_SUMMARY_CHARS,
} = {}) {
  const journalAnchor = executionId || reactionId || cycleId;
  const entries = [];
  const seenKeys = new Set();
  let nextSeq = 1;

  function keyFor({ decisionId, receiptId }) {
    if (decisionId) return `d:${decisionId}`;
    if (receiptId) return `r:${receiptId}`;
    return null;
  }

  function pushEntry(partial) {
    const key = keyFor(partial);
    if (key && seenKeys.has(key)) return null;
    const seq = partial.seq != null ? partial.seq : nextSeq;
    nextSeq = Math.max(nextSeq, seq + 1);
    const entry = {
      seq,
      source: partial.source || 'queue',
      decisionId: partial.decisionId ?? null,
      actionType: partial.actionType || 'unknown',
      status: partial.status || 'unknown',
      summary: String(partial.summary || '').slice(0, summaryChars),
      handoffNote: partial.handoffNote ?? null,
      receiptId: partial.receiptId ?? null,
    };
    entry.line = formatJournalLine(entry, { maxLineChars, summaryChars });
    entries.push(entry);
    if (key) seenKeys.add(key);
    return entry;
  }

  // Replay receipts for idempotent rebuild after daemon exec resume.
  if (journalAnchor && store && typeof store.readActionReceipts === 'function') {
    try {
      const receipts = store.readActionReceipts({ limit: 100 }) ?? [];
      const matched = receipts
        .filter((r) => r?.cycle_id === journalAnchor
          || r?.exec_cycle_id === journalAnchor
          || r?.execution_id === journalAnchor
          || r?.reaction_id === journalAnchor)
        .slice()
        .reverse(); // readRecent typically newest-first; restore chronological
      for (const receipt of matched) {
        pushEntry(entryFromReceipt(receipt, nextSeq));
      }
    } catch {
      // best-effort
    }
  }

  return {
    cycleId: journalAnchor,
    get size() {
      return entries.length;
    },
    entries() {
      return entries.map((e) => ({ ...e }));
    },
    /**
     * Record one completed action (guard or queue).
     * @param {object} input
     */
    record(input = {}) {
      const handoffNote = normalizeHandoffNote(input.handoffNote ?? input.handoff_note);
      const summary = handoffNote
        || String(input.summary || '').trim()
        || '';
      return pushEntry({
        seq: input.seq,
        source: input.source || 'queue',
        decisionId: input.decisionId ?? input.decision_id ?? null,
        actionType: input.actionType ?? input.action_type ?? 'unknown',
        status: input.status || 'unknown',
        summary,
        handoffNote,
        receiptId: input.receiptId ?? input.receipt_id ?? null,
      });
    },
    /**
     * Convenience: record from ExecutionPipeline executed item shape.
     */
    recordExecuted(item = {}, { source = 'queue' } = {}) {
      const result = item?.result || {};
      const action = item?.action || {};
      const handoffNote = normalizeHandoffNote(
        result?.handoff_note ?? result?.agent?.handoff_note,
      );
      return this.record({
        source: item?.guard_id ? 'guard' : source,
        decisionId: item?.id ?? null,
        actionType: action?.type || 'unknown',
        status: statusFromResult(result),
        summary: handoffNote || summaryFromResult(result) || action?.description || '',
        handoffNote,
        receiptId: result?.receipt_id ?? result?.id ?? null,
      });
    },
    renderPromptSection() {
      const lines = entries.slice(-maxEntries).map((e) => {
        const line = e.line || formatJournalLine(e, { maxLineChars, summaryChars });
        return `- ${clipLine(line, maxLineChars)}`;
      });
      const body = lines.length
        ? lines.join('\n')
        : 'None (you are the first action this cycle).';
      return [
        '## Earlier actions this cycle',
        '',
        body,
        '',
        PROMPT_BEHAVIOR,
      ].join('\n');
    },
    toJSON() {
      return {
        cycle_id: journalAnchor,
        execution_id: executionId || journalAnchor,
        reaction_id: reactionId || null,
        entries: entries.map((e) => ({
          seq: e.seq,
          source: e.source,
          decision_id: e.decisionId,
          action_type: e.actionType,
          status: e.status,
          summary: e.summary,
          handoff_note: e.handoffNote,
          receipt_id: e.receiptId,
          line: e.line,
        })),
      };
    },
  };
}
