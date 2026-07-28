/**
 * Opt-in Intel honesty matrix: model × thinking × pipeline.
 *
 * Requires JEA_LIVE_DEEPSEEK=1 + DEEPSEEK_API_KEY.
 * pro×max cells also require JEA_LIVE_DEEPSEEK_DEEP=1.
 *
 *   $env:JEA_LIVE_DEEPSEEK='1'; npm run test:live-deepseek:intel-matrix
 *
 * Each cell hard-fails on honesty findings; afterAll prints a comparison table.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../src/cli/utils/project.mjs';
import { DeepSeekOpenAIClient } from '../src/ai/deepseek-client.mjs';
import { DEEPSEEK_MODELS } from '../src/ai/llm-profile.mjs';
import { runHonestyLiveIntel } from './helpers/intel-report-honesty-live-runner.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
loadProjectEnv(REPO_ROOT);

const LIVE_ENABLED = process.env.JEA_LIVE_DEEPSEEK === '1'
  && Boolean(String(process.env.DEEPSEEK_API_KEY || '').trim());
const LIVE_DEEP = process.env.JEA_LIVE_DEEPSEEK_DEEP === '1';

const DEFAULT_CELLS = [
  { pipeline: 'phases', model: DEEPSEEK_MODELS.flash, thinkingMode: 'off' },
  { pipeline: 'phases', model: DEEPSEEK_MODELS.flash, thinkingMode: 'high' },
  { pipeline: 'phases', model: DEEPSEEK_MODELS.pro, thinkingMode: 'high' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.flash, thinkingMode: 'high' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.pro, thinkingMode: 'high' },
];

const DEEP_CELLS = [
  { pipeline: 'phases', model: DEEPSEEK_MODELS.pro, thinkingMode: 'max' },
  { pipeline: 'agent_loop', model: DEEPSEEK_MODELS.pro, thinkingMode: 'max' },
];

/** @type {Array<object>} */
const matrixRows = [];

function cellLabel(cell) {
  const tier = cell.model.includes('pro') ? 'pro' : 'flash';
  return `${cell.pipeline}/${tier}×${cell.thinkingMode}`;
}

function makeMatrixClient(cell) {
  return new DeepSeekOpenAIClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
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

function countFindings(byRule = {}) {
  return Object.values(byRule).reduce((a, b) => a + Number(b || 0), 0);
}

function pushRow(cell, result, error = null) {
  const findings = result?.findingsByRule || {};
  matrixRows.push({
    label: cellLabel(cell),
    pipeline: cell.pipeline,
    model: cell.model,
    thinkingMode: cell.thinkingMode,
    ok: !error && Boolean(result?.success),
    poison: findings.seen_contains_forbidden_intent || 0,
    missing_ref: findings.seen_bullet_missing_ref || 0,
    dangling: findings.seen_dangling_ref || 0,
    unknown_type: findings.seen_unknown_source_type || 0,
    // Informational bare-write discipline (phases + agent_loop when raw_md_path exists).
    raw: countFindings(result?.rawFindingsByRule),
    raw_sanitized: countFindings(result?.rawSanitizedFindingsByRule),
    citesFixture: Boolean(result?.citesFixture),
    elapsedMs: result?.elapsedMs ?? null,
    error: error ? String(error.message || error).slice(0, 160) : null,
  });
}

function printSummaryTable() {
  if (!matrixRows.length) return;
  const header = [
    'label',
    'ok',
    'poison',
    'missing_ref',
    'dangling',
    'unknown_type',
    'raw',
    'raw_sanitized',
    'fixture_cite',
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
        row.ok ? 'pass' : 'FAIL',
        row.poison,
        row.missing_ref,
        row.dangling,
        row.unknown_type,
        row.raw,
        row.raw_sanitized,
        row.citesFixture ? 'yes' : 'no',
        row.elapsedMs ?? '-',
      ].join(' | ')
      + ' |',
    );
  }
  // Use console.log so the table survives vitest per-test stdout isolation.
  console.log('\n[intel-honesty-matrix] summary\n' + lines.join('\n') + '\n');
  console.log(
    '[intel-honesty-matrix] note: ok/poison/missing_ref/dangling/unknown_type are final-product gates '
    + '(host-assembled Seen for phases + agent_loop); '
    + 'raw / raw_sanitized are informational model-bare-write discipline before host splice.\n',
  );
}

async function runCell(cell) {
  const label = cellLabel(cell);
  let result;
  try {
    result = await runHonestyLiveIntel({
      pipeline: cell.pipeline,
      aiClient: makeMatrixClient(cell),
    });
    console.info('[intel-honesty-matrix]', {
      label,
      ok: result.success,
      findingsByRule: result.findingsByRule,
      elapsedMs: result.elapsedMs,
      citesFixture: result.citesFixture,
    });
    pushRow(cell, result);
    expect(
      result.honesty.findings,
      [
        `intel honesty matrix cell failed: ${label}`,
        'Final-product gate failure (host Seen assemble/splice regression), not mock wiring.',
        'raw columns (if any) are informational model bare-write discipline only.',
        JSON.stringify(result.honesty.findings, null, 2),
      ].join('\n'),
    ).toEqual([]);
  } catch (err) {
    if (!matrixRows.some((r) => r.label === label)) {
      pushRow(cell, result, err);
    }
    throw err;
  }
}

describe.skipIf(!LIVE_ENABLED)('Intel report honesty matrix (live DeepSeek)', () => {
  afterAll(() => {
    printSummaryTable();
  });

  describe.sequential('default cells', () => {
    for (const cell of DEFAULT_CELLS) {
      const timeout = 900_000;
      it(`cell ${cellLabel(cell)}`, async () => {
        await runCell(cell);
      }, timeout);
    }
  });

  describe.skipIf(!LIVE_DEEP).sequential('deep cells (JEA_LIVE_DEEPSEEK_DEEP=1)', () => {
    for (const cell of DEEP_CELLS) {
      it(`cell ${cellLabel(cell)}`, async () => {
        await runCell(cell);
      }, 1_200_000);
    }
  });
});

describe.skipIf(LIVE_ENABLED)('Intel report honesty matrix (live DeepSeek) — gate', () => {
  it('skips unless JEA_LIVE_DEEPSEEK=1 and DEEPSEEK_API_KEY are set', () => {
    expect(LIVE_ENABLED).toBe(false);
  });
});
