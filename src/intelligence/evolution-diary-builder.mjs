import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatMessages } from '../ai/messages.mjs';
import {
  buildPromptCacheMetadata,
  markPromptCacheInvariant,
} from '../ai/prompt-cache-metadata.mjs';
import { detectLanguage, extractTldr } from './report-builder.mjs';
import { redactSecrets } from './redaction.mjs';
import { resolveEvolutionDiaryWritePath } from './diary-paths.mjs';
import { selectActiveOperatorFacts } from './operator-facts.mjs';

const DIARY_CONTEXT_CHAR_LIMIT = 500000;
const OPERATOR_FACT_LIMIT = 10;
const OPERATOR_FACT_LOOKBACK_DAYS = 90;

function readActiveGoals(runtime) {
  if (!runtime?.runtimeRoot) return null;
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
    out.push({
      id: node.id,
      name: node.name,
      good_signal: node.good_signal,
      bad_signal: node.bad_signal,
    });
    for (const child of node.children || []) visit(child);
  };
  visit(goals);
  return out;
}

function readOperatorGuidanceCurrent(runtime) {
  if (!runtime?.runtimeRoot) return null;
  const guidancePath = join(runtime.runtimeRoot, 'data', 'evolution', 'human_guidance.md');
  if (!existsSync(guidancePath)) return null;
  try {
    const text = readFileSync(guidancePath, 'utf-8');
    const match = text.match(/^##\s*Current\s*\n([\s\S]*?)(?=^##\s|\Z)/im);
    const body = match?.[1]?.trim();
    return body || null;
  } catch {
    return null;
  }
}

export function gatherDiaryAnchors({ store = null, runtime = null } = {}) {
  const observations = safeReadStore(
    store,
    'readRecentIntel',
    { days: OPERATOR_FACT_LOOKBACK_DAYS, limit: 50 },
    [],
  );
  const operatorEstablishedFacts = selectActiveOperatorFacts(observations, {
    limit: OPERATOR_FACT_LIMIT,
  })
    .map((record) => ({
      id: record.id ?? null,
      content: record.content ?? record.summary ?? '',
    }))
    .filter((record) => record.content);

  const activeGoals = readActiveGoals(runtime);

  return {
    operator_established_facts: operatorEstablishedFacts,
    active_goals: activeGoals,
    active_goals_flat: flattenGoals(activeGoals),
    operator_guidance: readOperatorGuidanceCurrent(runtime),
  };
}

function clip(value, max = DIARY_CONTEXT_CHAR_LIMIT) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function stripCodeFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function pickSubjectDoc(agentContextDocs = []) {
  if (!Array.isArray(agentContextDocs)) return null;
  return agentContextDocs.find((d) => typeof d?.id === 'string' && d.id.startsWith('js-evolution-agent:subject:'))
    || agentContextDocs.find((d) => typeof d?.id === 'string' && d.id.includes(':subject:'))
    || null;
}

function safeReadStore(store, method, args, fallback) {
  try {
    if (!store || typeof store[method] !== 'function') return fallback;
    return store[method](args);
  } catch {
    return fallback;
  }
}

function compactExecuted(execResult) {
  return asArray(execResult?.executed).map((item) => ({
    action: {
      id: item?.action?.id ?? null,
      type: item?.action?.type ?? null,
      description: item?.action?.description ?? null,
      serves_goal: item?.action?.serves_goal ?? null,
      priority: item?.action?.priority ?? null,
      risk: item?.action?.risk ?? null,
    },
    result: {
      success: item?.result?.success ?? null,
      status: item?.result?.status ?? null,
      message: item?.result?.message ?? item?.result?.error ?? null,
      provider: item?.result?.provider ?? item?.result?.agentic_execution?.provider ?? null,
      requires_approval: item?.result?.requires_approval ?? null,
      fallback_used: item?.result?.fallback_used ?? null,
      writes_applied: item?.result?.writes_applied ?? null,
      verification_hints: item?.result?.verification_hints ?? item?.result?.agentic_execution?.verification_hints ?? [],
      evidence: item?.result?.evidence ?? null,
      writes: item?.result?.writes ?? null,
      boundary_risk: item?.result?.boundary_risk ?? null,
    },
  }));
}

export function buildEvolutionDiaryContext({
  intelResult,
  execResult,
  verification,
  beliefUpdateResult = null,
  goalsAssessResult = null,
  goalsCalibrateResult = null,
  runtime,
  reportPath = null,
  verifyReportPath = null,
  store = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const cycleId = execResult?.cycle_id ?? intelResult?.cycle_id;
  return redactSecrets({
    generated_at: generatedAt,
    subject: runtime?.subject ?? null,
    namespace: runtime?.dataNamespace ?? null,
    cycle: {
      cycle_id: cycleId,
      intel_cycle_id: intelResult?.cycle_id ?? null,
      exec_cycle_id: execResult?.cycle_id ?? null,
      intel_success: intelResult?.success ?? null,
      exec_success: execResult?.success ?? null,
      mode: intelResult?.mode ?? null,
    },
    files: {
      intel_report: reportPath ?? intelResult?.report?.mdPath ?? null,
      verify_report: verifyReportPath ?? null,
      phase1_conversation_context: intelResult?.conversation_context_path ?? null,
    },
    interpretation_anchors: gatherDiaryAnchors({ store, runtime }),
    phase1: {
      report_source: intelResult?.report?.source ?? null,
      report_tldr: intelResult?.report?.indexRecord?.tldr ?? null,
      decision: intelResult?.analysis?.decision ?? null,
      rationale: intelResult?.analysis?.rationale ?? null,
      confidence_score: intelResult?.analysis?.confidence_score ?? null,
      actions: asArray(intelResult?.actions).map((a) => ({
        type: a?.type,
        description: a?.description,
        serves_goal: a?.serves_goal,
        priority: a?.priority,
        risk: a?.risk,
        expected_impact: a?.expected_impact,
      })),
      decisions_queued: intelResult?.decisions_queued ?? [],
      decisions_skipped: intelResult?.decisions_skipped ?? [],
      standing_memory_update: intelResult?.standing_memory_update ?? null,
    },
    phase2: {
      success: execResult?.success ?? null,
      executed_count: asArray(execResult?.executed).length,
      error: execResult?.error ?? null,
      executed: compactExecuted(execResult),
    },
    phase3: {
      verified_count: asArray(verification?.verified).length,
      pending_count: asArray(verification?.pending).length,
      semantic_status: verification?.semantic?.status ?? null,
      semantic_summary: verification?.semantic?.result?.overall_summary ?? null,
      semantic_next_cycle_focus: verification?.semantic?.result?.next_cycle_focus ?? [],
      semantic_precedence: 'latest_semantic_verification_over_older_report_or_diary_claims',
      semantic_verified: asArray(verification?.semantic?.result?.semantic_verified).slice(0, 8).map((item) => ({
        action_type: item?.action_type ?? null,
        final_status: item?.final_status ?? null,
        confidence: item?.confidence ?? null,
        evidence_summary: item?.evidence_summary ?? null,
        issues: item?.issues ?? [],
      })),
      semantic_error: verification?.semantic?.error ?? null,
      mechanical: {
        verified: asArray(verification?.verified).map((r) => ({
          action_type: r?.action?.type ?? r?.action_type ?? null,
          status: r?.status ?? null,
          message: r?.message ?? r?.value?.message ?? null,
        })),
        pending: asArray(verification?.pending).map((r) => ({
          action_type: r?.action?.type ?? r?.action_type ?? null,
          status: r?.status ?? null,
          message: r?.message ?? r?.reason ?? null,
        })),
      },
    },
    phase3_5: beliefUpdateResult ? {
      source: beliefUpdateResult.source ?? null,
      status: beliefUpdateResult.result?.status ?? null,
      reason: beliefUpdateResult.result?.reason ?? null,
      updates_count: beliefUpdateResult.result?.updates?.length ?? 0,
      events_written: beliefUpdateResult.eventsWritten ?? 0,
      updates: asArray(beliefUpdateResult.result?.updates).slice(0, 8).map((item) => ({
        belief_id: item?.belief_id ?? null,
        change: item?.change ?? null,
        reason: item?.reason ?? null,
        next_test: item?.next_test ?? null,
      })),
    } : null,
    phase4: goalsAssessResult ? {
      cycle_id: goalsAssessResult?.report?.cycle_id ?? null,
      status: goalsAssessResult?.assessment?.status ?? null,
      rule_status: goalsAssessResult?.assessment?.rule_status ?? null,
      confidence: goalsAssessResult?.assessment?.confidence ?? null,
      reason: goalsAssessResult?.assessment?.reason ?? null,
      written: goalsAssessResult?.written ?? null,
    } : null,
    phase4_5: goalsCalibrateResult ? {
      status: goalsCalibrateResult?.status ?? null,
      rule_status: goalsCalibrateResult?.rule_status ?? null,
      reason: goalsCalibrateResult?.reason ?? null,
      mode: goalsCalibrateResult?.mode ?? null,
      calibrate_mode: goalsCalibrateResult?.calibrate_mode ?? null,
      detail: goalsCalibrateResult?.detail ?? null,
      warnings: goalsCalibrateResult?.warnings ?? [],
      previous_goal_id: goalsCalibrateResult?.previous_goal_id ?? null,
      next_goal_id: goalsCalibrateResult?.next_goal_id ?? null,
      written: goalsCalibrateResult?.written ?? null,
      active_goals_path: goalsCalibrateResult?.active_goals_path ?? null,
      applied_patches: goalsCalibrateResult?.applied_patches ?? [],
      skipped_patches: goalsCalibrateResult?.skipped_patches ?? [],
      belief_retirements: goalsCalibrateResult?.belief_retirements ?? [],
      children_ids_before: goalsCalibrateResult?.children_ids_before ?? [],
      children_ids_after: goalsCalibrateResult?.children_ids_after ?? [],
    } : null,
    recent_memory: {
      standing_memory: safeReadStore(store, 'readStandingMemory', undefined, null),
      current_beliefs: safeReadStore(store, 'readCurrentBeliefs', undefined, null),
      belief_events: safeReadStore(store, 'readBeliefEvents', { limit: 10 }, []),
      latest_review: safeReadStore(store, 'readLatestReview', undefined, null),
      action_receipts: safeReadStore(store, 'readActionReceipts', { limit: 20 }, []),
      evolution_events: safeReadStore(store, 'readEvolutionEvents', { limit: 20 }, []),
      retrospectives: safeReadStore(store, 'readRetrospectives', { limit: 10 }, []),
    },
  });
}

export function buildEvolutionDiaryPrompt({
  context,
  language = 'zh',
  agentContextDocs = [],
} = {}) {
  const contextJson = clip(redactSecrets(context));
  const subjectDoc = pickSubjectDoc(agentContextDocs);
  if (language === 'en') {
    return [
      'Write a post-execution evolution diary for a completed js-evolution-agent cycle.',
      '',
      'This is not an intelligence report, not a project changelog, and not a new decision step.',
      'Write for a human operator in clear first-person or close third-person operational prose.',
      '',
      'Constraints:',
      '- Output pure Markdown with no outer code fence.',
      '- Do not propose or create new actions.',
      '- Do not invent ids, files, tests, writes, success, or failure not present in the context.',
      '- Keep the diary scoped to the active subject runtime; never describe it as a `journal/` project update.',
      '- Prefer traceable facts such as cycle id, action type, report path, verification status, and receipt summaries.',
      '- If phase3.semantic is present, treat it as the latest interpretation of the executed receipt. Use it to correct stale report/diary inferences, but do not promote semantic summaries to Seen facts.',
      '- Explicitly record Phase 4 goal assessment and Phase 4.5 goal auto-calibration when present in Machine Context. Include status, rule_status (continue, learn, mutate, stop, or insufficient_evidence), confidence, and reason for Phase 4; include status, rule_status, mode (patch, patch_partial, or full_replace), calibrate_mode, reason, detail, applied_patches, children_ids_before/after, belief_retirements, next_goal_id, and written count for Phase 4.5. If calibration was skipped, state the skipped reason and detail instead of omitting it.',
      '- Explicitly record Phase 3.5 belief update when present in Machine Context. Include status, reason, updates_count, and which beliefs were strengthened, weakened, validated, refuted, created, or retired.',
      '- When interpreting metrics such as rank or score, follow interpretation_anchors.operator_established_facts. When judging progress vs no progress, use interpretation_anchors.active_goals or active_goals_flat good_signal / bad_signal. Do not infer metric direction from raw numeric delta alone (for example, a lower rank may be improvement). Execution and verification conclusions in phase2/phase3 still override anchors; anchors only interpret them.',
      '- Be readable and candid: say what moved, what did not move, and what the next cycle should remember.',
      '',
      'Suggested sections:',
      '- What happened this cycle',
      '- What actually moved',
      '- What did not move',
      '- Goal assessment and calibration',
      '- Belief update',
      '- My judgement of the cycle',
      '- What the next cycle should remember',
      '',
      '## Active Subject Policy',
      subjectDoc?.text || '(missing)',
      '',
      '## Machine Context',
      '```json',
      contextJson,
      '```',
    ].join('\n');
  }

  return [
    '请为一个已经执行完成的 js-evolution-agent cycle 写一份「进化日记」。',
    '',
    '这不是情报报告，不是项目更新日志，也不是新的决策阶段。它是给人类操作者阅读的 post-execution 复盘日记。',
    '',
    '写作要求：',
    '- 输出纯 Markdown，不要使用最外层代码围栏。',
    '- 不要生成新的 action，不要替本轮继续决策。',
    '- 不要编造上下文中不存在的 id、文件、测试、写入、成功或失败结论。',
    '- 只记录 active subject 的运行时进化，不要写成 `journal/` 项目开发日志。',
    '- 尽量引用可追溯事实，例如 cycle id、action type、报告路径、验证状态、receipt 摘要。',
    '- 如果 phase3.semantic 存在，它是本轮执行 receipt 的最新解释层结论。用它修正旧 report/diary 推断，但不要把 semantic summary 升级成 Seen 事实。',
    '- 如果 Machine Context 中存在 phase4 或 phase4_5，必须显式记录 Phase 4 目标评估与 Phase 4.5 自动校准结果。Phase 4 至少写出 status、rule_status（continue/learn/mutate/stop/insufficient_evidence）、confidence、reason；Phase 4.5 至少写出 status、rule_status、mode（patch、patch_partial 或 full_replace）、calibrate_mode、reason、detail、applied_patches、children_ids 前后变化、belief_retirements、next_goal_id、written。若校准被 skipped，也要写明 skipped reason 与 detail，不要省略。',
    '- 如果 Machine Context 中存在 phase3_5，必须显式记录 Phase 3.5 信念更新结果。至少写出 status、reason、updates_count，以及哪些 belief 被 strengthen/weaken/validate/refute/create/retire。',
    '- 解读 rank、score 等指标时，遵循 interpretation_anchors.operator_established_facts；判断「是否推进」时对照 interpretation_anchors.active_goals 或 active_goals_flat 的 good_signal / bad_signal，不要仅凭裸数值 delta 推断方向（例如 rank 数值更低可能是改善）。phase2/phase3 的执行与验证结论仍优先于 anchors；anchors 只用于解释它们。',
    '- 文风要像认真复盘的人写给操作者看：清楚、坦诚、可读，说清楚推进了什么、没推进什么、下一轮该记住什么。',
    '- 使用现代汉语书面语，避免文言、玄学散文、典故标题和过度模板化表格。',
    '',
    '建议章节：',
    '- 这一轮发生了什么',
    '- 真正推进了什么',
    '- 没有推进的地方',
    '- 目标评估与自动校准',
    '- 信念更新',
    '- 我对这轮的判断',
    '- 下轮应该注意什么',
    '',
    '## Active Subject Policy',
    subjectDoc?.text || '(missing)',
    '',
    '## Machine Context',
    '```json',
    contextJson,
    '```',
  ].join('\n');
}

function renderFallbackDiary({ context, generatedAt, reason, language }) {
  const isZh = language !== 'en';
  const t = (zh, en) => (isZh ? zh : en);
  const cycleId = context?.cycle?.cycle_id ?? 'unknown-cycle';
  const executed = asArray(context?.phase2?.executed);
  const lines = [
    `# ${t('进化日记', 'Evolution Diary')}：${cycleId}`,
    '',
    `> ${t('生成时间', 'Generated')}: ${generatedAt}`,
    `> ${t('主体', 'Subject')}: ${context?.subject ?? 'unknown'}`,
    `> ${t('命名空间', 'Namespace')}: ${context?.namespace ?? 'unknown'}`,
    '',
    `> ${t('AI 日记生成失败，以下为机械事实回退版本', 'AI diary generation failed; this is a mechanical fallback')}${reason ? `：${reason}` : ''}。`,
    '',
    `## ${t('这一轮发生了什么', 'What happened this cycle')}`,
    '',
    `- cycle: ${cycleId}`,
    `- ${t('情报阶段状态', 'intel success')}: ${context?.cycle?.intel_success ?? 'unknown'}`,
    `- ${t('执行阶段状态', 'exec success')}: ${context?.cycle?.exec_success ?? 'unknown'}`,
    `- ${t('执行动作数', 'executed actions')}: ${executed.length}`,
    `- ${t('验证通过数', 'verified count')}: ${context?.phase3?.verified_count ?? 0}`,
    `- ${t('待处理验证数', 'pending count')}: ${context?.phase3?.pending_count ?? 0}`,
    `- ${t('语义验证状态', 'semantic verification')}: ${context?.phase3?.semantic_status ?? 'unknown'}`,
    '',
  ];

  if (executed.length) {
    lines.push(`## ${t('动作结果', 'Action results')}`, '');
    for (const item of executed) {
      lines.push(`- \`${item.action?.type ?? 'unknown'}\`: ${item.result?.status ?? item.result?.success ?? 'unknown'}${item.result?.message ? ` - ${item.result.message}` : ''}`);
    }
    lines.push('');
  }

  if (context?.phase4) {
    lines.push(
      `## ${t('目标评估', 'Goal Assessment')}`,
      '',
      `- ${t('状态', 'status')}: ${context.phase4.status}`,
      `- ${t('规则状态', 'rule status')}: ${context.phase4.rule_status ?? 'n/a'}`,
      `- ${t('置信度', 'confidence')}: ${context.phase4.confidence ?? 'n/a'}`,
      `- ${t('原因', 'reason')}: ${context.phase4.reason ?? 'n/a'}`,
      '',
    );
  }

  if (context?.phase4_5) {
    lines.push(
      `## ${t('目标自动校准', 'Goal Auto Calibration')}`,
      '',
      `- ${t('状态', 'status')}: ${context.phase4_5.status}`,
      `- ${t('规则状态', 'rule status')}: ${context.phase4_5.rule_status ?? 'n/a'}`,
      `- ${t('模式', 'mode')}: ${context.phase4_5.mode ?? 'n/a'}`,
      `- ${t('校准策略', 'calibrate mode')}: ${context.phase4_5.calibrate_mode ?? 'n/a'}`,
      `- ${t('原因', 'reason')}: ${context.phase4_5.reason ?? 'n/a'}`,
      ...(context.phase4_5.detail
        ? [`- ${t('详情', 'detail')}: ${context.phase4_5.detail}`]
        : []),
      `- ${t('新目标', 'next goal')}: ${context.phase4_5.next_goal_id ?? 'n/a'}`,
      `- ${t('子目标（前）', 'children before')}: ${(context.phase4_5.children_ids_before || []).join(', ') || 'n/a'}`,
      `- ${t('子目标（后）', 'children after')}: ${(context.phase4_5.children_ids_after || []).join(', ') || 'n/a'}`,
      `- ${t('应用补丁数', 'applied patches')}: ${(context.phase4_5.applied_patches || []).length}`,
      `- ${t('信念退役数', 'belief retirements')}: ${(context.phase4_5.belief_retirements || []).length}`,
      '',
    );
  }

  lines.push(
    `## ${t('下轮应该注意什么', 'What the next cycle should remember')}`,
    '',
    t(
      '这份回退日记只保留了机器可确认的事实。下一轮应优先查看情报报告、执行 receipt 和验证报告，再判断本轮是否真正推进了目标。',
      'This fallback diary only preserves mechanically confirmed facts. The next cycle should inspect the intel report, execution receipts, and verification report before judging goal progress.',
    ),
    '',
  );
  return lines.join('\n');
}

export function persistEvolutionDiary({
  markdown,
  context,
  runtime,
  store = null,
  generatedAt = new Date().toISOString(),
  source = 'ai',
  fallbackReason = null,
  promptCache = null,
} = {}) {
  if (!runtime?.runtimeRoot) throw new Error('runtime.runtimeRoot is required');
  const cycleId = context?.cycle?.cycle_id;
  if (!cycleId) throw new Error('cycle_id is required');

  const finalMarkdown = redactSecrets(stripCodeFence(markdown)).trim() + '\n';
  const mdPath = resolveEvolutionDiaryWritePath(runtime.runtimeRoot, cycleId, { generatedAt });
  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, finalMarkdown, 'utf-8');

  const tldr = extractTldr(finalMarkdown);
  const event = {
    type: 'evolution_diary',
    status: source === 'ai' ? 'ok' : 'fallback',
    cycle_id: cycleId,
    subject: runtime.subject ?? context?.subject ?? null,
    namespace: runtime.dataNamespace ?? context?.namespace ?? null,
    diary_path: mdPath,
    source,
    tldr,
    fallback_reason: fallbackReason,
    generated_at: generatedAt,
    prompt_cache: promptCache,
  };
  store?.recordEvolutionEvent?.(event);
  return { mdPath, source, markdown: finalMarkdown, tldr, event, prompt_cache: promptCache };
}

export async function buildEvolutionDiary({
  aiClient = null,
  intelResult,
  execResult,
  verification,
  beliefUpdateResult = null,
  goalsAssessResult = null,
  goalsCalibrateResult = null,
  runtime,
  store = null,
  agentContextDocs = [],
  reportPath = null,
  verifyReportPath = null,
  logger = null,
  useAi = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  const subjectDoc = pickSubjectDoc(agentContextDocs);
  const language = detectLanguage(subjectDoc?.text);
  const context = buildEvolutionDiaryContext({
    intelResult,
    execResult,
    verification,
    beliefUpdateResult,
    goalsAssessResult,
    goalsCalibrateResult,
    runtime,
    reportPath,
    verifyReportPath,
    store,
    generatedAt,
  });

  let markdown = null;
  let source = 'fallback';
  let fallbackReason = useAi ? null : 'use-ai-disabled';
  const systemPrompt = 'You write post-execution evolution diaries from provided evidence only. Never invent facts or continue execution.';
  const prompt = buildEvolutionDiaryPrompt({ context, language, agentContextDocs });
  const stablePrompt = buildEvolutionDiaryPrompt({ context: {}, language, agentContextDocs });
  const promptCache = buildPromptCacheMetadata({
    profile: 'diary',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    stablePrefix: [systemPrompt, stablePrompt].join('\n\n--- stable turn ---\n\n'),
    dynamicPayload: JSON.stringify(context, null, 2),
  });
  const promptCacheInvariant = markPromptCacheInvariant({
    scope: 'diary',
    metadata: promptCache,
    logger,
  });
  if (useAi && aiClient) {
    try {
      const text = await chatMessages(aiClient, [
        {
          role: 'system',
          content: systemPrompt,
        },
        { role: 'user', content: prompt },
      ], { thinking: 'low', timeout: 180 });
      const cleaned = stripCodeFence(text);
      if (cleaned.trim()) {
        markdown = cleaned;
        source = 'ai';
      } else {
        fallbackReason = 'empty-output';
      }
    } catch (e) {
      fallbackReason = e?.message || String(e);
      logger?.warning?.(`[diary] AI generation failed: ${fallbackReason}; using fallback diary`);
      logger?.warn?.(`[diary] AI generation failed: ${fallbackReason}; using fallback diary`);
    }
  } else if (useAi) {
    fallbackReason = 'no-ai-client';
  }

  if (!markdown) {
    markdown = renderFallbackDiary({ context, generatedAt, reason: fallbackReason, language });
  }

  return persistEvolutionDiary({
    markdown,
    context,
    runtime,
    store,
    generatedAt,
    source,
    fallbackReason,
    promptCache: {
      ...promptCache,
      invariant: promptCacheInvariant,
    },
  });
}
