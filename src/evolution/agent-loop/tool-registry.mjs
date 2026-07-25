import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decisionFingerprint } from '../../engine/index.mjs';
import { validateAgentRunSpec } from '../../actions/agent-run-spec.mjs';
import { resolveHostExternalRoots } from '../../cli/utils/subjects.mjs';
import { actionRegistry } from '../../actions/registry.mjs';

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

function buildActionTool(spec, loopCtx) {
  const { budget, dedup, decisionQueue, executor, cycleId, host, runtime, emitEvent } = loopCtx;
  const maxChars = budget.toolResultMaxChars;
  const description = [spec.description, spec.promptHint].filter(Boolean).join('\n');

  return {
    name: spec.name,
    kind: 'action',
    description,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        serves_goal: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        params: { type: 'object' },
      },
      required: ['description', 'params'],
    },
    async execute(args, meta = {}) {
      const action = {
        type: spec.name,
        description: String(args?.description || ''),
        serves_goal: args?.serves_goal || undefined,
        priority: args?.priority || undefined,
        params: args?.params && typeof args.params === 'object' ? args.params : {},
      };

      if (budget.actionsUsed >= budget.maxActions) {
        return { ok: false, error: 'action_budget_exhausted' };
      }

      const fingerprint = decisionFingerprint(action);
      if (dedup.has(fingerprint)) {
        return { ok: false, error: 'duplicate_action_this_cycle', fingerprint };
      }

      if (action.type === 'agent_run') {
        const jeaRoot = host?.sourceRoot ?? runtime.runtimeRoot;
        try {
          const { externalRoots, subjectRepoLane } = await resolveHostExternalRoots({
            root: jeaRoot,
            subject: runtime.subject,
          });
          host.externalRoots = externalRoots;
          host.resourceRoots = externalRoots;
          host.subjectRepoLane = subjectRepoLane;
        } catch (e) {
          return { ok: false, error: `external_roots_refresh_failed: ${e?.message || e}` };
        }
        const validation = validateAgentRunSpec(action, {
          projectRoot: host?.sourceRoot ?? runtime.runtimeRoot,
          host,
          runtime,
          cycleId,
        });
        if (!validation.valid) {
          return {
            ok: false,
            error: 'invalid_action',
            errors: validation.errors,
            warnings: validation.warnings,
          };
        }
      }

      const queued = decisionQueue.addDecisionsDetailed({
        cycleId,
        actions: [action],
        analysisContext: 'agent_loop',
        metadata: { loop_turn: meta.turn ?? null, pipeline: 'agent_loop' },
      });
      if (!queued.ids?.length) {
        const skip = queued.skipped?.[0];
        return {
          ok: false,
          error: skip?.reason || 'queue_rejected',
          skipped: queued.skipped,
        };
      }
      const decisionId = queued.ids[0];
      decisionQueue.updateStatus?.(decisionId, 'in_progress');

      const result = await executor.execute(action);
      const summary = result?.summary
        || result?.message
        || result?.error
        || (result?.success ? 'ok' : 'failed');

      if (result?.success) {
        decisionQueue.completeDecision?.(decisionId, String(summary).slice(0, 2000));
      } else if (result?.deferred) {
        decisionQueue.updateStatus?.(decisionId, 'pending');
      } else {
        decisionQueue.failDecision?.(decisionId, String(result?.error || summary).slice(0, 2000));
      }

      dedup.add(fingerprint);
      budget.actionsUsed += 1;
      const executedItem = { id: decisionId, action, result };
      loopCtx.executed.push(executedItem);
      emitEvent?.({
        type: 'agent_loop_action_executed',
        status: result?.success ? 'ok' : 'failed',
        cycle_id: cycleId,
        decision_id: decisionId,
        action_type: action.type,
        deferred: Boolean(result?.deferred),
      });

      return {
        ok: Boolean(result?.success),
        decision_id: decisionId,
        result: summarizeResult(result, maxChars),
        error: result?.success ? undefined : (result?.error || 'handler_non_success'),
      };
    },
  };
}

function buildFinishTool(loopCtx) {
  return {
    name: 'finish_cycle',
    kind: 'control',
    description: 'Terminate the agent_loop session. Provide the cycle intelligence report markdown (report_markdown is required).',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['done', 'no_action_needed', 'blocked'],
        },
        report_markdown: { type: 'string' },
        key_findings: {
          type: 'array',
          items: { type: 'string' },
        },
        next_cycle_suggestions: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['status', 'report_markdown'],
    },
    async execute(args) {
      const report = String(args?.report_markdown || '').trim();
      if (!report) {
        return { ok: false, error: 'report_markdown is required' };
      }
      loopCtx.finish = {
        status: args?.status || 'done',
        report_markdown: report,
        key_findings: Array.isArray(args?.key_findings) ? args.key_findings.map(String) : [],
        next_cycle_suggestions: Array.isArray(args?.next_cycle_suggestions)
          ? args.next_cycle_suggestions.map(String)
          : [],
      };
      return { ok: true, result: { finished: true, status: loopCtx.finish.status } };
    },
  };
}

/**
 * @param {object} loopCtx
 * @returns {{ tools: object[], byName: Map<string, object>, toOpenAiTools: () => object[] }}
 */
export function buildLoopTools(loopCtx) {
  if (!loopCtx.executed) loopCtx.executed = [];
  if (!loopCtx.dedup) loopCtx.dedup = new Set();
  if (!loopCtx.budget) {
    loopCtx.budget = {
      maxTurns: 24,
      maxActions: 5,
      maxWallClockMs: 1_200_000,
      toolResultMaxChars: 6000,
      actionsUsed: 0,
    };
  }
  if (loopCtx.budget.actionsUsed == null) loopCtx.budget.actionsUsed = 0;

  const registry = loopCtx.actionRegistry || actionRegistry;
  const actionSpecs = typeof registry.listAll === 'function' ? registry.listAll() : [];
  // Also include dynamic handlers present on host but not in registry (configured externals).
  const handlerNames = Object.keys(loopCtx.host?.actionHandlers || {});
  const known = new Set(actionSpecs.map((s) => s.name));
  for (const name of handlerNames) {
    if (!known.has(name)) {
      actionSpecs.push({
        name,
        description: `Configured / host action: ${name}`,
        promptHint: `Execute host-registered action ${name}. Params are action-specific.`,
      });
    }
  }

  const tools = [
    ...buildReadonlyTools(loopCtx),
    ...actionSpecs.map((spec) => buildActionTool(spec, loopCtx)),
    buildFinishTool(loopCtx),
  ];
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
        return { ok: false, error: `unknown_tool: ${name}` };
      }
      try {
        return await tool.execute(args ?? {}, meta);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
  };
}

export { READONLY_SOURCES, decisionFingerprint };
