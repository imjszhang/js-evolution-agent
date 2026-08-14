/**
 * Shared Analyze+Decide JSON normalize / parse-with-repair helpers.
 * Used by classic phases pipeline and report-centric agent_loop.
 */
import { chatMessages, parseJsonFromText } from '../ai/messages.mjs';

const QUEUE_OPS = new Set(['requeue', 'retire']);

/**
 * Normalize Decide `queue_ops` entries.
 * @param {unknown} raw
 * @returns {{ op: 'requeue'|'retire', id: string, reason: string|null }[]}
 */
export function normalizeQueueOps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const op = String(item.op ?? item.operation ?? '').trim().toLowerCase();
    const id = String(item.id ?? item.decision_id ?? '').trim();
    if (!QUEUE_OPS.has(op) || !id) continue;
    const reason = item.reason != null ? String(item.reason).slice(0, 500) : null;
    out.push({ op, id, reason });
  }
  return out;
}

export function normalizeAnalyzeDecision(analysis = {}) {
  const next = analysis && typeof analysis === 'object' && !Array.isArray(analysis)
    ? { ...analysis }
    : {};
  next.analysis = next.analysis && typeof next.analysis === 'object' && !Array.isArray(next.analysis)
    ? next.analysis
    : { key_patterns: [], root_causes: {}, opportunities: [] };
  const rawActions = Array.isArray(next.actions) ? next.actions : [];
  next.actions = rawActions.filter((action) => (
    action
    && typeof action === 'object'
    && !Array.isArray(action)
    && typeof action.type === 'string'
    && action.type.trim() !== ''
  ));
  next.decision = next.decision || (next.actions.length ? 'execute' : 'defer');
  const coverage = next.goal_coverage && typeof next.goal_coverage === 'object' && !Array.isArray(next.goal_coverage)
    ? { ...next.goal_coverage }
    : {};
  coverage.covered = Array.isArray(coverage.covered) ? coverage.covered : [];
  if (Array.isArray(coverage.not_covered)) {
    coverage.not_covered = Object.fromEntries(coverage.not_covered.map((item, idx) => [`item_${idx + 1}`, String(item)]));
  } else if (!coverage.not_covered || typeof coverage.not_covered !== 'object') {
    coverage.not_covered = {};
  }
  next.goal_coverage = coverage;
  next.deferred = Array.isArray(next.deferred) ? next.deferred : [];
  next.risk_mitigation = Array.isArray(next.risk_mitigation) ? next.risk_mitigation : [];
  next.goal_suggestions = Array.isArray(next.goal_suggestions) ? next.goal_suggestions : [];
  next.queue_ops = normalizeQueueOps(next.queue_ops);
  return next;
}

function buildAnalyzeDecisionRepairMessages(rawDecision, parseError) {
  return [
    {
      role: 'system',
      content: [
        'You repair malformed JSON for js-evolution-agent Analyze+Decide outputs.',
        'Return only one strict JSON object. No Markdown, no code fence, no explanation.',
        'Preserve all original semantics, actions, ids, paths, and strings as much as possible.',
        'Fix only syntax and shape errors.',
        'Required shape includes goal_coverage.not_covered as an object, e.g. {"goal-id":"reason"}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Parse error: ${parseError}`,
        '',
        'Repair this Analyze+Decide JSON:',
        rawDecision,
      ].join('\n'),
    },
  ];
}

export async function parseAnalyzeDecisionWithRepair(aiClient, rawDecision, { logger = null } = {}) {
  try {
    return {
      analysis: normalizeAnalyzeDecision(parseJsonFromText(aiClient, rawDecision)),
      parseError: null,
      repairUsed: false,
      repairError: null,
      repairedRaw: null,
    };
  } catch (e) {
    const parseError = e?.message || String(e);
    try {
      const repairedRaw = await chatMessages(aiClient, buildAnalyzeDecisionRepairMessages(rawDecision, parseError), {
        thinking: 'low',
        timeout: 180,
        phase: 'repair',
      });
      const repaired = normalizeAnalyzeDecision(parseJsonFromText(aiClient, repairedRaw));
      logger?.warning?.(`[analyze_decide] repaired invalid JSON: ${parseError}`);
      return {
        analysis: repaired,
        parseError,
        repairUsed: true,
        repairError: null,
        repairedRaw,
      };
    } catch (repairException) {
      return {
        analysis: null,
        parseError,
        repairUsed: true,
        repairError: repairException?.message || String(repairException),
        repairedRaw: null,
      };
    }
  }
}
