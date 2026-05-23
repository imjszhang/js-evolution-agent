import 'dotenv/config';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTION_REGISTRY,
  MockAIClient,
} from 'js-evolution-engine';
import { DeepSeekOpenAIClient } from './src/ai/deepseek-client.mjs';
import { actionRegistry } from './src/actions/registry.mjs';
import {
  actionHandlers,
  actionVerifiers,
} from './src/actions/handlers.mjs';
import { createIntelligenceStore } from './src/intelligence/store.mjs';
import { getDefaultCyberTaoistDocsDir } from './src/cli/utils/project.mjs';
import {
  getActiveSubjectRuntimeInfo,
  parseSubjectRepoLane,
  parseSubjectExternalRoots,
  parseSubjectResourceRules,
  readActiveSubjectPolicy,
} from './src/cli/utils/subjects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDocsDir() {
  if (process.env.CYBER_TAOIST_DOCS_DIR) {
    return resolve(process.env.CYBER_TAOIST_DOCS_DIR);
  }
  return getDefaultCyberTaoistDocsDir();
}

function readRequiredFile(fullPath, hint) {
  if (!existsSync(fullPath)) {
    throw new Error(`${hint} not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

function buildAgentContextDocs() {
  const docsDir = resolveDocsDir();
  const subjectPolicy = readActiveSubjectPolicy(__dirname);
  return [
    {
      id: 'cyber-taoist:constitution',
      source: resolve(docsDir, 'CONSTITUTION.md'),
      text: readRequiredFile(resolve(docsDir, 'CONSTITUTION.md'), 'Cyber-Taoist constitution'),
    },
    {
      id: 'cyber-taoist:skill',
      source: resolve(docsDir, 'SKILL.md'),
      text: readRequiredFile(resolve(docsDir, 'SKILL.md'), 'Cyber-Taoist skill guide'),
    },
    {
      id: `js-evolution-agent:subject:${subjectPolicy.active.active}`,
      source: subjectPolicy.file,
      text: subjectPolicy.text,
    },
  ];
}

function registerGlobalActionTypes() {
  for (const spec of actionRegistry.listAll()) {
    ACTION_REGISTRY.register(spec);
  }
}

const consoleLogger = {
  info: (msg) => console.log(`[info] ${msg}`),
  warning: (msg) => console.warn(`[warn] ${msg}`),
  error: (msg) => console.error(`[err ] ${msg}`),
};

const cannedAnalyzeDecide = {
  analysis: {
    key_patterns: [
      'js-evolution-agent has no prior live cycles yet',
      'The first cycle should only record observations, proposals, and reviews',
    ],
    root_causes: {
      high_performers_why: 'n/a during bootstrap',
      low_performers_why: 'n/a during bootstrap',
      failures_why: 'n/a during bootstrap',
    },
    opportunities: [
      {
        opportunity: 'Verify document injection and intelligence-store receipts',
        potential_impact: 'medium',
        effort: 'low',
      },
    ],
  },
  decision: 'execute',
  rationale: 'Bootstrap the controlled self-evolution loop without mutating external projects.',
  actions: [
    {
      type: 'record_observation',
      description: 'Record bootstrap context for js-evolution-agent',
      serves_goal: 'bootstrap',
      priority: 'medium',
      layer: 'buffer',
      params: {
        source: 'bootstrap-cycle',
        subject: 'js-evolution-agent',
        kind: 'project_state',
        content: 'Initial controlled loop uses js-evolution-engine, cyber-taoist docs, and js-intel-store.',
        confidence: 'high',
        tags: ['bootstrap', 'controlled-loop'],
      },
      expected_impact: 'The next cycle can see the bootstrap state in intelligence context.',
      risk: 'low',
    },
    {
      type: 'propose_probe',
      description: 'Create a bounded probe proposal for the first loop',
      serves_goal: 'bootstrap',
      priority: 'medium',
      layer: 'probe',
      params: {
        target: 'self-evolution workflow',
        hypothesis: 'A record-only first cycle proves the integration path before any mutation is allowed.',
        success_signal: 'Decision queue executes and receipts appear under the active subject runtime data namespace.',
        failure_signal: 'Any action tries to modify js-evolution-engine or cyber-taoist-docs.',
        death_boundary: 'Do not write outside the active subject runtime during the first cycle.',
      },
      expected_impact: 'One decisive integration signal with no external side effects.',
      risk: 'low',
    },
    {
      type: 'write_retrospective',
      description: 'Write a bootstrap retrospective',
      serves_goal: 'bootstrap',
      priority: 'low',
      layer: 'buffer',
      params: {
        summary: 'Bootstrap cycle validates wiring rather than evolving production behavior.',
        outcome: 'pending verification',
        lessons: ['Keep core mutations behind human review', 'Persist receipts in js-intel-store'],
        next_actions: ['Review generated receipts', 'Decide whether to enable real AI client'],
      },
      expected_impact: 'Latest review becomes available to the next analyze/decide prompt.',
      risk: 'low',
    },
  ],
  goal_coverage: { covered: ['bootstrap'], not_covered: {} },
  deferred: [],
  risk_mitigation: [
    'Only record-oriented handlers are enabled in the bootstrap loop.',
  ],
  goal_suggestions: [],
  confidence_score: 0.5,
};

function createAiClient() {
  if (process.env.JEA_FORCE_MOCK === '1') {
    consoleLogger.warning('AI: JEA_FORCE_MOCK=1; using MockAIClient');
    return createMockAiClient();
  }
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (key) {
    consoleLogger.info('AI: using DeepSeek (OpenAI-compatible API)');
    return new DeepSeekOpenAIClient({ logger: consoleLogger });
  }
  consoleLogger.warning('AI: DEEPSEEK_API_KEY not set; using MockAIClient');
  return createMockAiClient();
}

function createMockAiClient() {
  const mockJournalZh =
    '# 情报报告（mock 输出）\n\n' +
    '本轮处于无 AI 网络调用的兜底模式。机器仅汇总当前运行时状态要点：\n\n' +
    '- buffer：观测已落盘，未触及核心。\n' +
    '- probe：尚无新的探针结果。\n' +
    '- core：只读，符合主体策略边界。\n\n' +
    '本段为占位输出，不代表 DeepSeek 真实生成；切换到 `--deepseek` 可获得完整分析报告。\n';
  const mockJournalEn =
    '# Intelligence Report (mock output)\n\n' +
    'This cycle ran without a real AI call. The machine only summarizes baseline runtime posture:\n\n' +
    '- buffer layer: observations absorbed, core untouched.\n' +
    '- probe layer: no new probe results.\n' +
    '- core layer: read-only, consistent with the subject policy boundary.\n\n' +
    'This placeholder text does not replace a DeepSeek run; switch to `--deepseek` for a full Cyber-Taoist-aligned reading.\n';
  const mockDiaryZh =
    '# 进化日记（mock 输出）\n\n' +
    '这一轮在 mock 模式下完成，日记只记录可确认的运行事实。\n\n' +
    '## 这一轮发生了什么\n\n' +
    '系统完成了情报、执行、验证与目标评估后的收尾记录。\n\n' +
    '## 下轮应该注意什么\n\n' +
    '切换到真实 LLM 后，应重点阅读执行 receipt 与验证报告，再判断目标是否真正推进。\n';
  const mockDiaryEn =
    '# Evolution Diary (mock output)\n\n' +
    'This cycle completed in mock mode, so the diary only preserves confirmed runtime facts.\n\n' +
    '## What happened this cycle\n\n' +
    'The system completed the post-intel, execution, verification, and goal-assessment recording path.\n\n' +
    '## What the next cycle should remember\n\n' +
    'With a real LLM enabled, inspect execution receipts and verification reports before judging goal progress.\n';

  return new MockAIClient({
    canned: [
      { match: /Strategic Analysis & Decision/i, response: cannedAnalyzeDecide },
      {
        match: /observation report/i,
        response:
          '# Observation Report\n\n' +
          '## State\njs-evolution-agent bootstrap cycle with Cyber-Taoist context and js-intel-store memory enabled.\n\n' +
          '## Signals\nNo production mutations are allowed in the first cycle.\n\n' +
          '## Recommended Focus\nConfirm docs injection, local decision queue, and intelligence receipts.\n',
      },
      { match: /进化日记/, response: mockDiaryZh },
      { match: /evolution diary/i, response: mockDiaryEn },
      { match: /情报报告/, response: mockJournalZh },
      { match: /intelligence report/i, response: mockJournalEn },
    ],
    defaultResponse: cannedAnalyzeDecide,
  });
}

export default async function ({ cwd }) {
  registerGlobalActionTypes();
  const runtime = getActiveSubjectRuntimeInfo(cwd);
  const subjectPolicy = readActiveSubjectPolicy(cwd);
  const subjectRepoLane = parseSubjectRepoLane(subjectPolicy.text, {
    root: cwd,
    subject: subjectPolicy.active.active,
  });
  const externalRoots = parseSubjectExternalRoots(subjectPolicy.text);
  if (subjectRepoLane.configured) {
    externalRoots.target_repo = subjectRepoLane.repoRoot;
  }
  const resourceRules = parseSubjectResourceRules(subjectPolicy.text);

  const intelligenceStore = createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
    logger: consoleLogger,
  });

  const aiClient = createAiClient();
  const agentContextDocs = buildAgentContextDocs();

  return {
    aiClient,
    actionRegistry,
    agentContextDocs,
    host: {
      basePath: runtime.runtimeRoot,
      sourceRoot: cwd,
      runtimeRoot: runtime.runtimeRoot,
      dataRoot: runtime.dataRoot,
      dataNamespace: runtime.dataNamespace,
      subjectRepoLane,
      appName: 'js-evolution-agent',
      logger: consoleLogger,
      intelligenceStore,
      knowledgeWriter: intelligenceStore,
      agentContextDocs,
      externalRoots,
      resourceRoots: externalRoots,
      resourceRules,
      actionHandlers,
      actionVerifiers,
    },
  };
}

