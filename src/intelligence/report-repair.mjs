/**
 * Bounded mechanical-contract repair for Intel report judgement sections.
 * Appends repair turns on the report session (KV-hot prefix); does not enter decide chain.
 */
import { chatMessagesDetailed } from '../ai/messages.mjs';
import { summarizeLlmUsage } from '../ai/prompt-cache-metadata.mjs';
import { spliceHostSeen } from './host-seen.mjs';
import { checkReportMechanicalContract } from './report-quality.mjs';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} 0–2; default 1
 */
export function parseReportRepairMaxRounds(env = process.env) {
  const raw = env?.JEA_REPORT_REPAIR_MAX_ROUNDS;
  if (raw == null || String(raw).trim() === '') return 1;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0, n));
}

function formatFindingLine(finding) {
  const rule = finding?.rule || 'unknown';
  const refs = finding?.detail?.refs;
  if (Array.isArray(refs) && refs.length) {
    return `- ${rule}: ${refs.join(', ')}`;
  }
  return `- ${rule}: ${finding?.message || rule}`;
}

/**
 * Build user prompt asking the model to fix mechanical contract findings.
 */
export function buildReportRepairUserPrompt({ language = 'zh', findings = [] } = {}) {
  const isEn = language === 'en';
  const list = (Array.isArray(findings) ? findings : []).map(formatFindingLine).join('\n')
    || (isEn ? '- (unspecified)' : '- （未指定）');

  if (isEn) {
    return [
      '# Report repair (mechanical contract)',
      '',
      'Your previous report failed a mechanical contract check. Findings:',
      list,
      '',
      'Fix ONLY these issues:',
      '- Add any missing required level-2 headings exactly as: ## Inferred, ## Cyber-Taoist analysis, ## 下一轮建议 (or Next cycle suggestions).',
      '- Remove invented typed refs listed above, or replace them with refs that appear in Final Seen.',
      '- Keep ## Seen as a short host-owned placeholder; do not invent Seen facts.',
      '- Keep the rest of the report content otherwise unchanged.',
      '',
      'Output the FULL corrected Markdown document. Do not wrap the whole document in code fences.',
    ].join('\n');
  }

  return [
    '# 报告修复（机械契约）',
    '',
    '上一份报告未通过机械契约检查。发现：',
    list,
    '',
    '只修复这些问题：',
    '- 补齐缺失的必需二级标题，确切使用：## Inferred、## Cyber-Taoist analysis、## 下一轮建议（或 Next cycle suggestions）。',
    '- 删除上方列出的编造 typed ref，或替换为 Final Seen 调色板中已有的合法 ref。',
    '- ## Seen 保持宿主占位短 bullet，不要自行编造 Seen 事实。',
    '- 其余内容尽量保持不变。',
    '',
    '输出完整修正后的 Markdown 全文。不要用最外层代码围栏包裹整篇文档。',
  ].join('\n');
}

function emptyRepair({ attempted = false } = {}) {
  return {
    rounds: 0,
    attempted,
    repaired: false,
    gave_up: false,
    findings_initial: [],
    findings_final: [],
  };
}

/**
 * Preview-splice → check → bounded re-ask repair loop.
 *
 * @returns {Promise<{
 *   rawReportMarkdown: string|null,
 *   repair: object,
 *   usageSummaries: Array<object|null>,
 * }>}
 */
export async function repairReportIfNeeded({
  aiClient,
  store,
  reportMessages = [],
  rawReportMarkdown = null,
  hostSeenBody = '',
  language = 'zh',
  logger = null,
  label = 'report',
  maxRounds = parseReportRepairMaxRounds(),
} = {}) {
  const initial = rawReportMarkdown == null ? null : String(rawReportMarkdown);
  if (!initial || !initial.trim() || maxRounds <= 0 || !aiClient) {
    return {
      rawReportMarkdown: initial,
      repair: emptyRepair({ attempted: false }),
      usageSummaries: [],
    };
  }

  const preview0 = spliceHostSeen(initial, hostSeenBody);
  const findings0 = checkReportMechanicalContract({ store, markdown: preview0 }).findings;
  if (!findings0.length) {
    return {
      rawReportMarkdown: initial.endsWith('\n') ? initial : `${initial}\n`,
      repair: emptyRepair({ attempted: false }),
      usageSummaries: [],
    };
  }

  let current = initial.endsWith('\n') ? initial : `${initial}\n`;
  let findings = findings0;
  let rounds = 0;
  const usageSummaries = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const rules = findings.map((f) => f.rule).join(', ');
    logger?.info?.(`[${label}] report repair round ${round}: ${rules}`);

    const repairPrompt = buildReportRepairUserPrompt({ language, findings });
    const repairMessages = [
      ...reportMessages,
      { role: 'assistant', content: current },
      { role: 'user', content: repairPrompt },
    ];

    let nextText = '';
    try {
      const result = await chatMessagesDetailed(aiClient, repairMessages, {
        thinking: 'medium',
        timeout: 600,
        phase: 'report',
      });
      usageSummaries.push(summarizeLlmUsage(result?.usage));
      nextText = String(result?.text || '').trim();
    } catch (e) {
      logger?.warning?.(`[${label}] report repair round ${round} failed: ${e?.message || e}`);
      usageSummaries.push(null);
      break;
    }

    if (!nextText) {
      break;
    }

    current = `${nextText}\n`;
    const preview = spliceHostSeen(current, hostSeenBody);
    findings = checkReportMechanicalContract({ store, markdown: preview }).findings;
    if (!findings.length) break;
  }

  const repaired = findings.length === 0;
  return {
    rawReportMarkdown: current,
    repair: {
      rounds,
      attempted: true,
      repaired,
      gave_up: !repaired,
      findings_initial: findings0.slice(0, 10),
      findings_final: findings.slice(0, 10),
    },
    usageSummaries,
  };
}
