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

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDocsDir() {
  if (process.env.CYBER_TAOIST_DOCS_DIR) {
    return resolve(process.env.CYBER_TAOIST_DOCS_DIR);
  }
  return resolve(__dirname, '..', 'js-evolution-engine', 'examples', 'cyber-taoist-demo', 'cyber-taoist-docs');
}

function readRequiredFile(fullPath, hint) {
  if (!existsSync(fullPath)) {
    throw new Error(`${hint} not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

function buildAgentContextDocs() {
  const docsDir = resolveDocsDir();
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
      id: 'js-evolution-agent:project-guidance',
      source: resolve(__dirname, 'policies', 'project-guidance.md'),
      text: readRequiredFile(resolve(__dirname, 'policies', 'project-guidance.md'), 'Project guidance'),
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
        success_signal: 'Decision queue executes and receipts appear under data/intelligence.',
        failure_signal: 'Any action tries to modify js-evolution-engine or cyber-taoist-docs.',
        death_boundary: 'Do not write outside js-evolution-agent/data during the first cycle.',
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
    ],
    defaultResponse: cannedAnalyzeDecide,
  });
}

export default async function ({ cwd }) {
  registerGlobalActionTypes();

  const intelligenceStore = createIntelligenceStore({
    baseDir: resolve(cwd, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
    logger: consoleLogger,
  });

  const aiClient = createAiClient();

  return {
    aiClient,
    actionRegistry,
    agentContextDocs: buildAgentContextDocs(),
    host: {
      basePath: cwd,
      appName: 'js-evolution-agent',
      logger: consoleLogger,
      intelligenceStore,
      knowledgeWriter: intelligenceStore,
      actionHandlers,
      actionVerifiers,
    },
  };
}

