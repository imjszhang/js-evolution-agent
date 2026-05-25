import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chatMessages } from '../ai/messages.mjs';
import { detectLanguage, extractTldr } from './report-builder.mjs';
import { redactSecrets } from './redaction.mjs';
import { resolveEvolutionDiaryWritePath } from './diary-paths.mjs';

const DIARY_CONTEXT_CHAR_LIMIT = 500000;

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
    phase4: goalsAssessResult ? {
      cycle_id: goalsAssessResult?.report?.cycle_id ?? null,
      status: goalsAssessResult?.assessment?.status ?? null,
      confidence: goalsAssessResult?.assessment?.confidence ?? null,
      reason: goalsAssessResult?.assessment?.reason ?? null,
      written: goalsAssessResult?.written ?? null,
    } : null,
    phase4_5: goalsCalibrateResult ? {
      status: goalsCalibrateResult?.status ?? null,
      reason: goalsCalibrateResult?.reason ?? null,
      previous_goal_id: goalsCalibrateResult?.previous_goal_id ?? null,
      next_goal_id: goalsCalibrateResult?.next_goal_id ?? null,
      written: goalsCalibrateResult?.written ?? null,
      active_goals_path: goalsCalibrateResult?.active_goals_path ?? null,
    } : null,
    recent_memory: {
      standing_memory: safeReadStore(store, 'readStandingMemory', undefined, null),
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
      '- Be readable and candid: say what moved, what did not move, and what the next cycle should remember.',
      '',
      'Suggested sections:',
      '- What happened this cycle',
      '- What actually moved',
      '- What did not move',
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
    '- 文风要像认真复盘的人写给操作者看：清楚、坦诚、可读，说清楚推进了什么、没推进什么、下一轮该记住什么。',
    '- 使用现代汉语书面语，避免文言、玄学散文、典故标题和过度模板化表格。',
    '',
    '建议章节：',
    '- 这一轮发生了什么',
    '- 真正推进了什么',
    '- 没有推进的地方',
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

  if (context?.phase4_5) {
    lines.push(
      `## ${t('目标自动校准', 'Goal Auto Calibration')}`,
      '',
      `- ${t('状态', 'status')}: ${context.phase4_5.status}`,
      `- ${t('原因', 'reason')}: ${context.phase4_5.reason ?? 'n/a'}`,
      `- ${t('新目标', 'next goal')}: ${context.phase4_5.next_goal_id ?? 'n/a'}`,
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
  };
  store?.recordEvolutionEvent?.(event);
  return { mdPath, source, markdown: finalMarkdown, tldr, event };
}

export async function buildEvolutionDiary({
  aiClient = null,
  intelResult,
  execResult,
  verification,
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
  if (useAi && aiClient) {
    try {
      const prompt = buildEvolutionDiaryPrompt({ context, language, agentContextDocs });
      const text = await chatMessages(aiClient, [
        {
          role: 'system',
          content: 'You write post-execution evolution diaries from provided evidence only. Never invent facts or continue execution.',
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
  });
}
