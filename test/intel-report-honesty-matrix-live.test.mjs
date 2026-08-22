/**
 * Opt-in Intel honesty matrix: model × thinking × pipeline.
 *
 * Requires JEA_LIVE_DEEPSEEK=1 + DEEPSEEK_API_KEY.
 * pro×max cells also require JEA_LIVE_DEEPSEEK_DEEP=1.
 *
 *   $env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:intel-matrix
 *
 * Hard-fails on host-wiring honesty findings; quality columns are informational.
 * Optional: JEA_MATRIX_REPEATS=N (1–5), JEA_MATRIX_JUDGE=1,
 *           JEA_MATRIX_PIPELINES=agent_loop|phases|agent_loop,phases (default: both).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../src/infra/project.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { DEEPSEEK_MODELS } from '../src/ai/llm-profile.mjs';
import { runHonestyLiveIntel } from './helpers/intel-report-honesty-live-runner.mjs';
import { judgeIntelReport, judgeMean } from './helpers/intel-report-judge.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
loadProjectEnv(REPO_ROOT);

const LIVE_ENABLED = process.env.JEA_LIVE_DEEPSEEK === '1'
  && Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());
const LIVE_DEEP = process.env.JEA_LIVE_DEEPSEEK_DEEP === '1';
const JUDGE_ENABLED = process.env.JEA_MATRIX_JUDGE === '1';
const REPEATS = Math.min(5, Math.max(1, parseInt(process.env.JEA_MATRIX_REPEATS || '1', 10) || 1));
const PIPELINE_FILTER = new Set(
  String(process.env.JEA_MATRIX_PIPELINES || 'agent_loop')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
let GIT_COMMIT = null;
try {
  GIT_COMMIT = execSync('git rev-parse --short HEAD', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  }).trim();
} catch {
  GIT_COMMIT = null;
}

const ALL_DEFAULT_CELLS = [
  { pipeline: 'phases', model: DEEPSEEK_MODELS.flash, thinkingMode: 'off' },
  { pipeline: 'phases', model: DEEPSEEK_MODELS.flash, thinkingMode: 'high' },
  { pipeline: 'phases', model: DEEPSEEK_MODELS.pro, thinkingMode: 'high' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.flash, thinkingMode: 'high' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.pro, thinkingMode: 'high' },
];

const ALL_DEEP_CELLS = [
  { pipeline: 'phases', model: DEEPSEEK_MODELS.pro, thinkingMode: 'max' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.pro, thinkingMode: 'max' },
];

const DEFAULT_CELLS = ALL_DEFAULT_CELLS.filter((cell) => PIPELINE_FILTER.has(cell.pipeline));
const DEEP_CELLS = ALL_DEEP_CELLS.filter((cell) => PIPELINE_FILTER.has(cell.pipeline));

/** @type {Array<object>} */
const matrixRows = [];
/** @type {string[]} */
let lastGatesTable = '';
/** @type {string[]} */
let lastQualityTable = '';

function cellLabel(cell) {
  const tier = cell.model.includes('pro') ? 'pro' : 'flash';
  return `${cell.pipeline}/${tier}×${cell.thinkingMode}`;
}

function makeMatrixClient(cell) {
  const subjectKey = `live-matrix-${cellLabel(cell)}`;
  return new DeepSeekOpenAIClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
    subjectKey,
    budgetLedgerPath: join(
      REPO_ROOT,
      'test-artifacts',
      'intel-honesty-matrix',
      `${RUN_ID}-${subjectKey.replace(/[^a-z0-9-]+/gi, '-')}.budget.json`,
    ),
    baseURL: process.env.DEEPSEEK_BASE_URL,
    model: cell.model,
    thinkingMode: cell.thinkingMode,
    // Isolate from operator JEA_LLM_PROFILE / legacy thinking env.
    env: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    },
    timeout: 600,
  });
}

function makeJudgeClient() {
  return new DeepSeekOpenAIClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
    subjectKey: 'live-matrix-judge',
    budgetLedgerPath: join(
      REPO_ROOT,
      'test-artifacts',
      'intel-honesty-matrix',
      `${RUN_ID}-judge.budget.json`,
    ),
    baseURL: process.env.DEEPSEEK_BASE_URL,
    model: DEEPSEEK_MODELS.pro,
    thinkingMode: 'high',
    env: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
    },
    timeout: 300,
  });
}

function countFindings(byRule = {}) {
  return Object.values(byRule).reduce((a, b) => a + Number(b || 0), 0);
}

function fmtRatio(value) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return Number(value).toFixed(2);
}

function fmtBool(value) {
  return value ? 'yes' : 'no';
}

function fmtTokens(usageTotals) {
  if (!usageTotals) return '-';
  const p = Number(usageTotals.prompt_tokens) || 0;
  const c = Number(usageTotals.completion_tokens) || 0;
  const sum = p + c;
  return sum > 0 ? String(sum) : '-';
}

function fmtMark(value) {
  return value ? '✓' : '✗';
}

function fmtHidden(hidden) {
  if (!hidden) return 'S✗C✗K✗';
  return `S${fmtMark(hidden.in_seen)}C${fmtMark(hidden.cited)}K${fmtMark(hidden.conclusion)}`;
}

function fmtVf(investigation, pipeline) {
  if (pipeline === 'phases' || !investigation) return '—';
  return `${investigation.vf_accepted ?? 0}/${investigation.vf_submitted ?? 0}`;
}

function pushRow(cell, attempt, result, error = null, judge = null) {
  const findings = result?.findingsByRule || {};
  const grounding = result?.grounding || {};
  const planted = result?.planted || {};
  const poisonFraming = result?.poisonFraming || {};
  const hidden = result?.hidden || {};
  const investigation = result?.investigation || null;
  const raw = result?.raw || {};
  const usage = result?.usage || {};
  matrixRows.push({
    run_id: RUN_ID,
    git_commit: GIT_COMMIT,
    label: cellLabel(cell),
    attempt,
    pipeline: cell.pipeline,
    model: cell.model,
    thinkingMode: cell.thinkingMode,
    ok: !error && Boolean(result?.success),
    poison: findings.seen_contains_forbidden_intent || 0,
    missing_ref: findings.seen_bullet_missing_ref || 0,
    dangling: findings.seen_dangling_ref || 0,
    unknown_type: findings.seen_unknown_source_type || 0,
    host_fixture_missing: findings.host_seen_missing_fixture_ref || 0,
    repair: result?.repair ?? null,
    grounding,
    planted,
    poison_framing: poisonFraming,
    hidden_in_seen: Boolean(hidden.in_seen),
    hidden_cited: Boolean(hidden.cited),
    hidden_conclusion: Boolean(hidden.conclusion),
    leak: result?.leak ?? null,
    vf_submitted: investigation?.vf_submitted ?? null,
    vf_accepted: investigation?.vf_accepted ?? null,
    vf_rejected: investigation?.vf_rejected ?? null,
    readonly_calls: investigation?.readonly_calls ?? null,
    investigation,
    raw_mode: raw.mode || 'none',
    raw_findings: countFindings(raw.findingsByRule),
    raw_sanitized_findings: countFindings(raw.sanitizedFindingsByRule),
    llm_calls: usage.calls ?? 0,
    tokens_prompt: usage.totals?.prompt_tokens ?? null,
    tokens_completion: usage.totals?.completion_tokens ?? null,
    cache_hit_ratio: usage.totals?.cache_hit_ratio ?? null,
    usage_totals: usage.totals ?? null,
    judge,
    elapsedMs: result?.elapsedMs ?? null,
    error: error ? String(error.message || error).slice(0, 160) : null,
  });
}

function buildGatesTableLines() {
  const header = [
    'label',
    'attempt',
    'ok',
    'poison',
    'missing_ref',
    'dangling',
    'unknown_type',
    'host_fixture',
    'repair',
    'raw_mode',
    'raw_findings',
    'ms',
  ];
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
  ];
  for (const row of matrixRows) {
    lines.push(
      '| '
      + [
        row.label,
        row.attempt,
        row.ok ? 'pass' : 'FAIL',
        row.poison,
        row.missing_ref,
        row.dangling,
        row.unknown_type,
        row.host_fixture_missing,
        row.repair?.rounds ?? 0,
        row.raw_mode,
        row.raw_findings,
        row.elapsedMs ?? '-',
      ].join(' | ')
      + ' |',
    );
  }
  return lines;
}

function buildQualityTableLines() {
  const header = [
    'label',
    'attempt',
    'grounding',
    'invented',
    'off_palette',
    'palette_used',
    'synth',
    'conflict',
    'stale',
    'distractor',
    'fixture_j',
    'poison_unframed',
    'hidden',
    'vf',
    'calls',
    'tokens',
    'hit_ratio',
    'judge',
  ];
  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
  ];
  for (const row of matrixRows) {
    const g = row.grounding || {};
    const p = row.planted || {};
    const pf = row.poison_framing || {};
    const mean = judgeMean(row.judge);
    lines.push(
      '| '
      + [
        row.label,
        row.attempt,
        fmtRatio(g.grounding_ratio),
        g.refs_invented ?? 0,
        g.refs_off_palette_resolvable ?? 0,
        `${g.palette_used_distinct ?? 0}/${g.palette_size ?? 0}`,
        fmtBool(p.synthesis_cocited),
        fmtBool(p.conflict_flagged),
        p.superseded_cited ?? 0,
        p.distractor_cited ?? 0,
        fmtBool(p.fixture_cited_in_judgement),
        pf.poison_unframed ?? 0,
        fmtHidden({
          in_seen: row.hidden_in_seen,
          cited: row.hidden_cited,
          conclusion: row.hidden_conclusion,
        }),
        fmtVf(row.investigation, row.pipeline),
        row.llm_calls ?? 0,
        fmtTokens(row.usage_totals),
        fmtRatio(row.cache_hit_ratio),
        mean == null ? '-' : mean.toFixed(1),
      ].join(' | ')
      + ' |',
    );
  }
  return lines;
}

function printSummaryTable() {
  if (!matrixRows.length) return;
  lastGatesTable = buildGatesTableLines();
  lastQualityTable = buildQualityTableLines();
  console.log('\n[intel-honesty-matrix] Gates (host wiring hard gates)\n' + lastGatesTable.join('\n') + '\n');
  console.log('\n[intel-honesty-matrix] Quality (informational model judgement metrics)\n' + lastQualityTable.join('\n') + '\n');
  console.log(
    '[intel-honesty-matrix] note: ok/poison/missing_ref/dangling/unknown_type/host_fixture '
    + 'are final-product host-wiring gates; '
    + 'Quality columns (grounding/planted/hidden/vf/raw_mode/usage/judge) are informational only. '
    + 'hidden=S(in Seen)/C(cited)/K(conclusion token) for both pipelines '
    + '(phases expect all ✗ after reportContext 7d clamp; any ✓ is prompt leakage). '
    + 'vf=accepted/submitted; phases shows — (no investigation channel).\n',
  );
}

function writeArtifacts() {
  if (!matrixRows.length) return;
  const dir = join(REPO_ROOT, 'test-artifacts', 'intel-honesty-matrix');
  mkdirSync(dir, { recursive: true });
  const jsonlPath = join(dir, `${RUN_ID}.jsonl`);
  const mdPath = join(dir, `${RUN_ID}.md`);
  const jsonl = matrixRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(jsonlPath, jsonl, 'utf-8');
  const md = [
    `# Intel honesty matrix ${RUN_ID}`,
    '',
    `- git_commit: ${GIT_COMMIT || '(unknown)'}`,
    `- repeats: ${REPEATS}`,
    `- pipelines: ${[...PIPELINE_FILTER].join(',') || '(none)'}`,
    `- judge: ${JUDGE_ENABLED ? 'on' : 'off'}`,
    '',
    '## Gates',
    '',
    ...(lastGatesTable.length ? lastGatesTable : buildGatesTableLines()),
    '',
    '## Quality',
    '',
    ...(lastQualityTable.length ? lastQualityTable : buildQualityTableLines()),
    '',
  ].join('\n');
  writeFileSync(mdPath, md, 'utf-8');
  console.log(`[intel-honesty-matrix] artifacts written: ${jsonlPath}`);
  console.log(`[intel-honesty-matrix] artifacts written: ${mdPath}`);
}

async function runCell(cell) {
  const label = cellLabel(cell);
  const attemptFailures = [];
  for (let attempt = 1; attempt <= REPEATS; attempt += 1) {
    let result;
    try {
      result = await runHonestyLiveIntel({
        pipeline: cell.pipeline,
        aiClient: makeMatrixClient(cell),
      });
      let judge = null;
      if (JUDGE_ENABLED && result.success && attempt === 1) {
        judge = await judgeIntelReport({
          judgeClient: makeJudgeClient(),
          markdown: result.markdown,
        });
      }
      console.info('[intel-honesty-matrix]', {
        label,
        attempt,
        ok: result.success,
        findingsByRule: result.findingsByRule,
        grounding_ratio: result.grounding?.grounding_ratio,
        planted: result.planted,
        hidden: result.hidden,
        leak: result.leak,
        investigation: result.investigation,
        raw_mode: result.raw?.mode,
        elapsedMs: result.elapsedMs,
      });
      pushRow(cell, attempt, result, null, judge);
      if (result.honesty.findings.length) {
        attemptFailures.push({
          attempt,
          findings: result.honesty.findings,
        });
      }
    } catch (err) {
      pushRow(cell, attempt, result, err);
      throw err;
    }
  }
  expect(
    attemptFailures,
    [
      `intel honesty matrix cell failed: ${label}`,
      'Hard-gate failure = host Seen assemble/splice / host_seen_missing_fixture_ref regression.',
      'Quality columns are informational and do not affect this assertion.',
      JSON.stringify(attemptFailures, null, 2),
    ].join('\n'),
  ).toEqual([]);
}

describe.skipIf(!LIVE_ENABLED)('Intel report honesty matrix (live DeepSeek)', () => {
  afterAll(() => {
    printSummaryTable();
    writeArtifacts();
  });

  describe.sequential('default cells', () => {
    for (const cell of DEFAULT_CELLS) {
      const timeout = 900_000 * REPEATS;
      it(`cell ${cellLabel(cell)}`, async () => {
        await runCell(cell);
      }, timeout);
    }
  });

  describe.skipIf(!LIVE_DEEP).sequential('deep cells (JEA_LIVE_DEEPSEEK_DEEP=1)', () => {
    for (const cell of DEEP_CELLS) {
      it(`cell ${cellLabel(cell)}`, async () => {
        await runCell(cell);
      }, 1_200_000 * REPEATS);
    }
  });
});

describe.skipIf(LIVE_ENABLED)('Intel report honesty matrix (live DeepSeek) — gate', () => {
  it('skips unless JEA_LIVE_DEEPSEEK=1 and DEEPSEEK_API_KEY are set', () => {
    expect(LIVE_ENABLED).toBe(false);
  });
});
