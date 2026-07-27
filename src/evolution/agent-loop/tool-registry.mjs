import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionFingerprint } from '../../engine/index.mjs';

const READONLY_SOURCES = Object.freeze([
  'intel_observations',
  'probe_results',
  'action_receipts',
  'evolution_events',
  'goal_events',
  'belief_events',
  'retrospectives',
]);

function clipJson(value, maxChars) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= maxChars) {
    return { text, truncated: false, chars: text.length };
  }
  return {
    text: `${text.slice(0, maxChars)}\n...(truncated)`,
    truncated: true,
    chars: text.length,
  };
}

function summarizeResult(result, maxChars) {
  const clipped = clipJson(result ?? null, maxChars);
  try {
    return {
      ...(clipped.truncated ? { preview: clipped.text, truncated: true, chars: clipped.chars } : JSON.parse(clipped.text)),
      ...(clipped.truncated ? {} : { truncated: false }),
    };
  } catch {
    return { preview: clipped.text, truncated: clipped.truncated, chars: clipped.chars };
  }
}

function filterContains(rows, contains) {
  if (!contains) return rows;
  const needle = String(contains).toLowerCase();
  return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
}

async function readSourceRows(store, source, limit) {
  switch (source) {
    case 'intel_observations':
      return store.readRecentIntel?.({ days: 90, limit }) ?? [];
    case 'probe_results':
      return store.readProbeResults?.({ limit }) ?? [];
    case 'action_receipts':
      return store.readActionReceipts?.({ limit }) ?? [];
    case 'evolution_events':
      return store.readEvolutionEvents?.({ limit }) ?? [];
    case 'goal_events':
      return store.readGoalEvents?.({ limit }) ?? [];
    case 'belief_events':
      return store.readBeliefEvents?.({ limit }) ?? [];
    case 'retrospectives':
      return store.readRetrospectives?.({ limit }) ?? [];
    default:
      return null;
  }
}

function buildReadonlyTools(loopCtx) {
  const { store, runtime, budget } = loopCtx;
  const maxChars = budget.toolResultMaxChars;

  return [
    {
      name: 'intel_query',
      kind: 'readonly',
      description: 'Read recent intelligence records from a named source (observations, receipts, events, etc.).',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: [...READONLY_SOURCES] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          contains: { type: 'string', description: 'Optional substring filter over JSON serialization' },
        },
        required: ['source'],
      },
      async execute(args) {
        const source = String(args?.source || '');
        if (!READONLY_SOURCES.includes(source)) {
          return { ok: false, error: `unsupported source: ${source}` };
        }
        const limit = Math.min(50, Math.max(1, Number(args?.limit) || 10));
        const rows = await readSourceRows(store, source, limit);
        if (rows == null) return { ok: false, error: `source unavailable: ${source}` };
        const filtered = filterContains(rows, args?.contains).slice(0, limit);
        return {
          ok: true,
          result: summarizeResult({ source, count: filtered.length, items: filtered }, maxChars),
        };
      },
    },
    {
      name: 'get_current_beliefs',
      kind: 'readonly',
      description: 'Read current_beliefs.json (active/validated/refuted partitions).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const doc = store.readCurrentBeliefs?.() ?? null;
        return { ok: true, result: summarizeResult(doc, maxChars) };
      },
    },
    {
      name: 'get_active_goals',
      kind: 'readonly',
      description: 'Read the active goal hypothesis tree from data/goals/active_goals.json.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const path = join(runtime.runtimeRoot, 'data', 'goals', 'active_goals.json');
        if (!existsSync(path)) return { ok: true, result: { goals: null, path } };
        try {
          const goals = JSON.parse(readFileSync(path, 'utf-8'));
          return { ok: true, result: summarizeResult({ path, goals }, maxChars) };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'get_decision_queue_summary',
      kind: 'readonly',
      description: 'Summarize the hot decision queue (pending/in_progress/completed counts).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        try {
          const summary = loopCtx.decisionQueue?.summarize?.() ?? null;
          return { ok: true, result: summarizeResult(summary, maxChars) };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      },
    },
    {
      name: 'read_intel_report',
      kind: 'readonly',
      description: 'Read an intel report markdown by cycle_id (defaults to latest).',
      parameters: {
        type: 'object',
        properties: {
          cycle_id: { type: 'string' },
        },
      },
      async execute(args) {
        const records = store.readIntelReports?.({ limit: 50 }) ?? [];
        const wanted = args?.cycle_id
          ? records.find((r) => r.cycle_id === args.cycle_id)
          : records[0];
        if (!wanted) return { ok: false, error: 'intel report not found' };
        const mdPath = wanted.md_path || wanted.mdPath;
        let markdown = null;
        if (mdPath && existsSync(mdPath)) {
          markdown = readFileSync(mdPath, 'utf-8');
          if (markdown.length > maxChars) {
            markdown = `${markdown.slice(0, maxChars)}\n...(truncated)`;
          }
        }
        return {
          ok: true,
          result: {
            cycle_id: wanted.cycle_id,
            md_path: mdPath ?? null,
            tldr: wanted.tldr ?? null,
            markdown,
          },
        };
      },
    },
  ];
}

function normalizeStringList(value, { maxItems = 20, maxChars = 500 } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((s) => s.slice(0, maxChars)).slice(0, maxItems);
}

function buildFinishInvestigationTool(loopCtx) {
  return {
    name: 'finish_investigation',
    kind: 'control',
    description: [
      'End the readonly investigation phase.',
      'Call when mechanical Seen + brief are enough, or after targeted queries closed the gaps.',
      'Do not write the Intel report here; the host generates it in a separate step.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        gaps_closed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence gaps that were resolved during investigation.',
        },
        open_gaps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remaining gaps to carry into the report / next cycle.',
        },
        findings_summary: {
          type: 'string',
          description: 'Short summary of investigation findings for the host report step (not the full Intel report).',
        },
        enough_for_report: {
          type: 'boolean',
          description: 'True when evidence is sufficient to draft the Phase 1.5 Intel report.',
        },
      },
      required: ['findings_summary', 'enough_for_report'],
    },
    async execute(args) {
      const findings = String(args?.findings_summary || '').trim();
      if (!findings) {
        return { ok: false, error: 'findings_summary is required' };
      }
      loopCtx.investigation = {
        gaps_closed: normalizeStringList(args?.gaps_closed),
        open_gaps: normalizeStringList(args?.open_gaps),
        findings_summary: findings.slice(0, 8000),
        enough_for_report: args?.enough_for_report !== false,
        finished: true,
      };
      return {
        ok: true,
        result: {
          finished: true,
          enough_for_report: loopCtx.investigation.enough_for_report,
        },
      };
    },
  };
}

function buildDeprecatedShim(name, kind, hint) {
  return {
    name,
    kind,
    description: `[DEPRECATED] ${hint}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute() {
      return {
        ok: false,
        error: 'deprecated_tool',
        hint,
      };
    },
  };
}

function wrapToolsProduct(tools, loopCtx) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    tools,
    byName,
    _loopCtx: loopCtx,
    toOpenAiTools() {
      return tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      }));
    },
    async dispatch(name, args, meta = {}) {
      const tool = byName.get(name);
      if (!tool) {
        return {
          ok: false,
          error: `unknown_tool: ${name}`,
          valid_tools: [...byName.keys()],
        };
      }
      try {
        return await tool.execute(args ?? {}, meta);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
  };
}

/**
 * Report-centric investigation tools: readonly queries + finish_investigation.
 * Action queueing and finish_cycle report writing are host-orchestrated outside this loop.
 */
export function buildInvestigationTools(loopCtx) {
  if (!loopCtx.queued) loopCtx.queued = [];
  if (!loopCtx.executed) loopCtx.executed = loopCtx.queued;
  if (!loopCtx.dedup) loopCtx.dedup = new Set();
  if (!loopCtx.budget) {
    loopCtx.budget = {
      maxTurns: 6,
      maxActions: 5,
      maxWallClockMs: 1_200_000,
      toolResultMaxChars: 6000,
      actionsUsed: 0,
    };
  }
  if (loopCtx.budget.actionsUsed == null) loopCtx.budget.actionsUsed = 0;
  if (!loopCtx.investigation) loopCtx.investigation = null;
  if (!Array.isArray(loopCtx.queryLog)) loopCtx.queryLog = [];

  const readonly = buildReadonlyTools(loopCtx).map((tool) => {
    const original = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(args, meta) {
        const outcome = await original(args, meta);
        loopCtx.queryLog.push({
          name: tool.name,
          ok: Boolean(outcome?.ok),
          args: args && typeof args === 'object' ? args : {},
          at: new Date().toISOString(),
          preview: (() => {
            try {
              const text = JSON.stringify(outcome?.result ?? outcome ?? null);
              return text.length > 800 ? `${text.slice(0, 800)}…` : text;
            } catch {
              return null;
            }
          })(),
        });
        return outcome;
      },
    };
  });

  const tools = [
    ...readonly,
    buildFinishInvestigationTool(loopCtx),
    // Thin shims so stale model/toolChoice paths fail clearly instead of hard-crashing.
    buildDeprecatedShim(
      'finish_cycle',
      'control',
      'finish_cycle is deprecated in report-centric agent_loop. Call finish_investigation; the host writes the Intel report.',
    ),
  ];

  return wrapToolsProduct(tools, loopCtx);
}

/** @deprecated Use buildInvestigationTools. Alias kept for import stability. */
export function buildLoopTools(loopCtx) {
  return buildInvestigationTools(loopCtx);
}

export { READONLY_SOURCES, decisionFingerprint };
