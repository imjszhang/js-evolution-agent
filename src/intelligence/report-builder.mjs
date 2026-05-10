import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTION_HEADINGS = [
  'TL;DR',
  'Findings',
  'Goal Assessment',
  'Proposed Goal Revisions',
  'Open Questions',
  'Appendix',
];

function safeReadGoals(runtime) {
  const goalsPath = join(runtime.runtimeRoot, 'data', 'goals', 'active_goals.json');
  if (!existsSync(goalsPath)) return null;
  try {
    return JSON.parse(readFileSync(goalsPath, 'utf-8'));
  } catch {
    return null;
  }
}

function flattenGoals(goals) {
  if (!goals) return [];
  const out = [];
  const visit = (node) => {
    if (!node) return;
    out.push({ id: node.id, name: node.name, intent: node.intent });
    for (const child of node.children || []) visit(child);
  };
  visit(goals);
  return out;
}

function fmtAction(a) {
  const desc = a.description || a.summary || '';
  const parts = [`- **[${a.type}]** ${desc}`.trim()];
  if (a.serves_goal) parts.push(`  - serves: ${a.serves_goal}`);
  if (a.expected_impact) parts.push(`  - impact: ${a.expected_impact}`);
  if (a.priority) parts.push(`  - priority: ${a.priority}`);
  return parts.join('\n');
}

export function renderTemplateReport({ intelResult, runtime, generatedAt }) {
  const cycleId = intelResult.cycle_id;
  const actions = intelResult.actions || [];
  const queued = intelResult.decisions_queued || [];
  const goals = flattenGoals(safeReadGoals(runtime));

  const findingsLines = actions.length
    ? actions.map(fmtAction)
    : ['- (no actions surfaced this cycle)'];

  const goalAssessmentLines = goals.length
    ? goals.map((g) => [
        `### Goal: \`${g.id}\` — ${g.name || ''}`,
        `- Intent: ${g.intent || '(none)'}`,
        '- Status: active (assessment pending — template fallback)',
        '- Evidence: see Findings above',
        '- Verdict: needs-assessment',
      ].join('\n'))
    : ['(no active goals defined)'];

  const tldr = [
    `Cycle ${cycleId} produced ${actions.length} action(s); ${queued.length} queued for review.`,
    `Mode: ${intelResult.mode || 'local'}; success: ${intelResult.success ? 'yes' : 'no'}.`,
    `Subject: ${runtime.subject}; namespace: ${runtime.dataNamespace}.`,
  ].join(' ');

  return [
    `# Intel Report — ${cycleId}`,
    `> Generated: ${generatedAt}  Subject: ${runtime.subject}  Namespace: ${runtime.dataNamespace}`,
    '',
    '## TL;DR',
    tldr,
    '',
    '## Findings',
    findingsLines.join('\n'),
    '',
    '## Goal Assessment',
    goalAssessmentLines.join('\n\n'),
    '',
    '## Proposed Goal Revisions',
    '_(none — template fallback; AI not consulted or unavailable.)_',
    '',
    '## Open Questions',
    '- Whether the queued actions actually advance the active goals.',
    '- Whether any active goal has been silently falsified by recent observations.',
    '',
    '## Appendix',
    `- decisions_queued: ${queued.length ? queued.join(', ') : '(none)'}`,
    `- action_count: ${actions.length}`,
    '',
  ].join('\n');
}

const AI_PROMPT_TEMPLATE = `You are the intel report writer for a controlled self-evolution agent.
Produce a Markdown report for the operator. The operator is human; readability is mandatory.

You MUST output ONLY Markdown with EXACTLY these top-level headings, in this order:
# Intel Report — <cycle_id>
> Generated: <iso>  Subject: <subject>  Namespace: <namespace>
## TL;DR
## Findings
## Goal Assessment
## Proposed Goal Revisions
## Open Questions
## Appendix

The "## Proposed Goal Revisions" section MUST follow this exact bullet schema (one block per revision, or the literal text "_(none)_" if you propose nothing):

### Revision: <goal_id>
- change: <one-line description of the proposed change>
- reason: <why, grounded in findings>
- confidence: high|medium|low

Other sections may be free-form prose with bullets. Keep TL;DR to 3-5 lines.

Context (JSON):
<<<CONTEXT>>>

Write the full Markdown now. Do not wrap your output in code fences.`;

function buildAiContext({ intelResult, runtime, goals, generatedAt }) {
  return JSON.stringify({
    cycle_id: intelResult.cycle_id,
    generated_at: generatedAt,
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    mode: intelResult.mode,
    success: intelResult.success,
    actions: (intelResult.actions || []).map((a) => ({
      type: a.type,
      description: a.description,
      serves_goal: a.serves_goal,
      expected_impact: a.expected_impact,
      priority: a.priority,
    })),
    decisions_queued: intelResult.decisions_queued || [],
    active_goals: goals,
  }, null, 2);
}

function looksLikeValidReport(md, cycleId) {
  if (!md || typeof md !== 'string') return false;
  if (!md.includes(`# Intel Report — ${cycleId}`) && !md.includes(`# Intel Report - ${cycleId}`)) {
    return false;
  }
  for (const h of SECTION_HEADINGS) {
    if (!md.includes(`## ${h}`)) return false;
  }
  return true;
}

export function extractTldr(md) {
  const m = md.match(/##\s+TL;DR\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  if (!m) return '';
  return m[1].trim().split('\n').slice(0, 5).join(' ').slice(0, 400);
}

export function countProposedRevisions(md) {
  const m = md.match(/##\s+Proposed Goal Revisions\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/);
  if (!m) return 0;
  const body = m[1];
  const matches = body.match(/^###\s+Revision:/gm);
  return matches ? matches.length : 0;
}

async function tryAiRender({ aiClient, intelResult, runtime, generatedAt, logger }) {
  if (!aiClient || typeof aiClient.chat !== 'function') return null;
  const goals = flattenGoals(safeReadGoals(runtime));
  const context = buildAiContext({ intelResult, runtime, goals, generatedAt });
  const prompt = AI_PROMPT_TEMPLATE.replace('<<<CONTEXT>>>', context);
  try {
    const md = await aiClient.chat(prompt);
    if (!looksLikeValidReport(md, intelResult.cycle_id)) {
      logger?.warn?.('[report] AI output failed schema check; falling back to template');
      return null;
    }
    return md;
  } catch (e) {
    logger?.warn?.(`[report] AI generation failed: ${e?.message || e}; falling back to template`);
    return null;
  }
}

/**
 * Build a human-readable intel report for the given cycle.
 *
 * @param {object} args
 * @param {object} args.intelResult - Result from IntelligencePipeline.run()
 * @param {object} args.runtime     - Active subject runtime info
 * @param {object} args.store       - IntelligenceStore
 * @param {object} [args.aiClient]  - Optional AI client; falls back to template on failure
 * @param {object} [args.logger]
 * @param {boolean} [args.useAi=true]
 * @returns {Promise<{ mdPath: string, indexRecord: object, source: 'ai'|'template' }>}
 */
export async function buildIntelReport({
  intelResult,
  runtime,
  store,
  aiClient = null,
  logger = null,
  useAi = true,
}) {
  if (!intelResult?.cycle_id) {
    throw new Error('buildIntelReport requires intelResult.cycle_id');
  }
  const generatedAt = new Date().toISOString();
  const cycleId = intelResult.cycle_id;

  let md = null;
  let source = 'template';
  if (useAi) {
    md = await tryAiRender({ aiClient, intelResult, runtime, generatedAt, logger });
    if (md) source = 'ai';
  }
  if (!md) {
    md = renderTemplateReport({ intelResult, runtime, generatedAt });
  }

  const reportsDir = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = join(reportsDir, `${cycleId}.md`);
  writeFileSync(mdPath, md, 'utf-8');

  const indexRecord = {
    cycle_id: cycleId,
    generated_at: generatedAt,
    md_path: mdPath,
    tldr: extractTldr(md),
    finding_count: (intelResult.actions || []).length,
    proposed_revision_count: countProposedRevisions(md),
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    source,
  };
  store.recordIntelReport(indexRecord);

  return { mdPath, indexRecord, source };
}
