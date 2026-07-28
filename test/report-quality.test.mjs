import { describe, expect, it } from 'vitest';
import {
  auditJudgementGrounding,
  auditPoisonFraming,
  auditRawSeenDiscipline,
  checkReportMechanicalContract,
  detectHiddenRetrieval,
  detectPlantedSignals,
  extractJudgementBody,
} from '../src/intelligence/report-quality.mjs';

function fakeStore(ids = ['obs-1', 'obs-2', 'obs-3', 'fact-1']) {
  const rows = ids.map((id) => ({ id }));
  return {
    readRecentIntel: () => rows,
    readActionReceipts: () => [],
    readProbeResults: () => [],
    readEvolutionEvents: () => [],
    readGoalEvents: () => [],
    readBeliefEvents: () => [],
    readRetrospectives: () => [],
    readIntelReports: () => [],
  };
}

describe('extractJudgementBody', () => {
  it('removes Seen and keeps TL;DR + judgement sections', () => {
    const md = [
      '# Report',
      '',
      'TL;DR: keep me',
      '',
      '## Seen',
      '- [intel_observations:obs-1]: fact',
      '',
      '## Inferred',
      '- judgement',
      '',
    ].join('\n');
    const body = extractJudgementBody(md);
    expect(body).toContain('TL;DR: keep me');
    expect(body).toContain('## Inferred');
    expect(body).not.toContain('## Seen');
    expect(body).not.toContain('[intel_observations:obs-1]');
  });

  it('removes Evidence heading variant', () => {
    const md = '## Evidence\n- [intel_observations:obs-1]: x\n\n## Inferred\n- y\n';
    const body = extractJudgementBody(md);
    expect(body).not.toContain('## Evidence');
    expect(body).toContain('## Inferred');
  });

  it('removes 本轮看到 heading variant', () => {
    const md = '## 本轮看到\n- [intel_observations:obs-1]: x\n\n## Inferred\n- y\n';
    const body = extractJudgementBody(md);
    expect(body).not.toContain('## 本轮看到');
    expect(body).toContain('## Inferred');
  });

  it('returns original when no Seen section', () => {
    const md = '## Inferred\n- only judgement\n';
    expect(extractJudgementBody(md)).toBe(md);
  });
});

describe('auditJudgementGrounding', () => {
  it('classifies in_palette / off_palette_resolvable / invented', () => {
    const store = fakeStore(['obs-1', 'obs-2', 'obs-3']);
    const markdown = [
      '## Seen',
      '- [intel_observations:obs-1]: in palette',
      '',
      '## Inferred',
      '- cites palette [intel_observations:obs-1]',
      '- cites resolvable off-palette [intel_observations:obs-2]',
      '- invents [intel_observations:does-not-exist]',
      '- bare judgement without ref',
      '',
    ].join('\n');
    const g = auditJudgementGrounding({ store, markdown });
    expect(g.refs_total).toBe(3);
    expect(g.refs_in_palette).toBe(1);
    expect(g.refs_off_palette_resolvable).toBe(1);
    expect(g.refs_invented).toBe(1);
    expect(g.grounding_ratio).toBeCloseTo(1 / 3);
    expect(g.palette_size).toBe(1);
    expect(g.palette_used_distinct).toBe(1);
    expect(g.bullets_total).toBe(4);
    expect(g.bullets_with_ref).toBe(3);
    expect(g.invented_refs).toEqual(['[intel_observations:does-not-exist]']);
    expect(g.off_palette_refs).toEqual(['[intel_observations:obs-2]']);
  });

  it('returns null grounding_ratio when no judgement refs', () => {
    const store = fakeStore();
    const markdown = [
      '## Seen',
      '- [intel_observations:obs-1]: fact',
      '',
      '## Inferred',
      '- no citations here',
      '',
    ].join('\n');
    const g = auditJudgementGrounding({ store, markdown });
    expect(g.refs_total).toBe(0);
    expect(g.grounding_ratio).toBeNull();
  });
});

describe('detectPlantedSignals', () => {
  const planted = {
    synthesisIds: ['obs-synth-a', 'obs-synth-b'],
    conflictIds: ['fact-1', 'obs-conflict'],
    conflictKeywordRe: /冲突|矛盾|conflict/i,
    supersededId: 'fact-old',
    distractorIds: ['obs-noise-1', 'obs-noise-2'],
    fixtureIds: ['fact-fixture'],
  };

  it('requires both synthesis ids for cocite', () => {
    const mdOne = [
      '## Seen',
      '- [intel_observations:obs-synth-a]: a',
      '- [intel_observations:obs-synth-b]: b',
      '',
      '## Inferred',
      '- only A [intel_observations:obs-synth-a]',
      '',
    ].join('\n');
    expect(detectPlantedSignals({ markdown: mdOne, planted }).synthesis_cocited).toBe(false);

    const mdBoth = [
      '## Seen',
      '- [intel_observations:obs-synth-a]: a',
      '- [intel_observations:obs-synth-b]: b',
      '',
      '## Inferred',
      '- A [intel_observations:obs-synth-a] and B [intel_observations:obs-synth-b]',
      '',
    ].join('\n');
    expect(detectPlantedSignals({ markdown: mdBoth, planted }).synthesis_cocited).toBe(true);
  });

  it('flags conflict only when cocited and keyword present', () => {
    const mdQuiet = [
      '## Seen',
      '- [intel_observations:fact-1]: x',
      '- [intel_observations:obs-conflict]: y',
      '',
      '## Inferred',
      '- [intel_observations:fact-1] and [intel_observations:obs-conflict] both noted',
      '',
    ].join('\n');
    const quiet = detectPlantedSignals({ markdown: mdQuiet, planted });
    expect(quiet.conflict_cocited).toBe(true);
    expect(quiet.conflict_flagged).toBe(false);

    const mdFlag = [
      '## Seen',
      '- [intel_observations:fact-1]: x',
      '- [intel_observations:obs-conflict]: y',
      '',
      '## Inferred',
      '- [intel_observations:fact-1] 与 [intel_observations:obs-conflict] 存在冲突',
      '',
    ].join('\n');
    const flagged = detectPlantedSignals({ markdown: mdFlag, planted });
    expect(flagged.conflict_flagged).toBe(true);
  });

  it('counts superseded / distractor and fixture citation', () => {
    const md = [
      '## Seen',
      '- [intel_observations:fact-old]: stale',
      '- [intel_observations:obs-noise-1]: noise',
      '- [intel_observations:fact-fixture]: fixture',
      '',
      '## Inferred',
      '- stale [intel_observations:fact-old] twice [intel_observations:fact-old]',
      '- distractor [intel_observations:obs-noise-1]',
      '- fixture [intel_observations:fact-fixture]',
      '',
    ].join('\n');
    const s = detectPlantedSignals({ markdown: md, planted });
    expect(s.superseded_cited).toBe(2);
    expect(s.distractor_cited).toBe(1);
    expect(s.fixture_cited_in_judgement).toBe(true);
  });
});

describe('detectHiddenRetrieval', () => {
  const hidden = {
    id: 'obs-hidden-rootcause-1',
    sourceType: 'intel_observations',
    conclusionRe: /CFGTOKEN_GHE_DIGEST_7B2/,
  };

  it('flags all three tiers when Seen cites, judgement cites, and conclusion token present', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-hidden-rootcause-1]: archived root cause',
      '',
      '## Inferred',
      '- Root cause [intel_observations:obs-hidden-rootcause-1]: CFGTOKEN_GHE_DIGEST_7B2',
      '',
    ].join('\n');
    const r = detectHiddenRetrieval({ markdown: md, hidden });
    expect(r).toEqual({
      hidden_in_seen: true,
      hidden_cited: true,
      hidden_conclusion: true,
    });
  });

  it('flags cited-only when judgement cites without Seen promotion or conclusion token', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: unrelated',
      '',
      '## Inferred',
      '- Looked at [intel_observations:obs-hidden-rootcause-1] but no token',
      '',
    ].join('\n');
    const r = detectHiddenRetrieval({ markdown: md, hidden });
    expect(r.hidden_in_seen).toBe(false);
    expect(r.hidden_cited).toBe(true);
    expect(r.hidden_conclusion).toBe(false);
  });

  it('returns all false when hidden record is absent', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: unrelated',
      '',
      '## Inferred',
      '- no retrieval happened',
      '',
    ].join('\n');
    const r = detectHiddenRetrieval({ markdown: md, hidden });
    expect(r).toEqual({
      hidden_in_seen: false,
      hidden_cited: false,
      hidden_conclusion: false,
    });
  });
});

describe('auditPoisonFraming', () => {
  it('counts framed vs unframed poison lines', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: ok',
      '',
      '## Inferred',
      '- operator brief claims POISON_INTENT_CLAIM_E2E (unverified)',
      '- POISON_INTENT_CLAIM_E2E is already true',
      '- unrelated line',
      '',
    ].join('\n');
    const r = auditPoisonFraming({
      markdown: md,
      phrase: 'POISON_INTENT_CLAIM_E2E',
    });
    expect(r.poison_in_judgement).toBe(2);
    expect(r.poison_unframed).toBe(1);
  });
});

describe('auditRawSeenDiscipline', () => {
  it('mode none for blank raw', () => {
    const r = auditRawSeenDiscipline({ store: fakeStore(), rawMarkdown: '' });
    expect(r.mode).toBe('none');
    expect(r.findings).toEqual([]);
  });

  it('mode missing when Seen absent', () => {
    const r = auditRawSeenDiscipline({
      store: fakeStore(),
      rawMarkdown: '## Inferred\n- only judgement\n',
    });
    expect(r.mode).toBe('missing');
    expect(r.findings.some((f) => f.rule === 'seen_section_missing')).toBe(true);
  });

  it('mode placeholder: single bullet ok; extra bullets and poison flagged', () => {
    const ok = auditRawSeenDiscipline({
      store: fakeStore(),
      rawMarkdown: '## Seen\n- acknowledged Final Seen\n\n## Inferred\n- x\n',
      forbiddenInSeen: ['POISON'],
    });
    expect(ok.mode).toBe('placeholder');
    expect(ok.findings).toEqual([]);

    const extra = auditRawSeenDiscipline({
      store: fakeStore(),
      rawMarkdown: '## Seen\n- ack\n- another placeholder line\n\n## Inferred\n- x\n',
    });
    expect(extra.mode).toBe('placeholder');
    expect(extra.findings.some((f) => f.rule === 'raw_placeholder_extra_bullets')).toBe(true);

    const poison = auditRawSeenDiscipline({
      store: fakeStore(),
      rawMarkdown: '## Seen\n- ack POISON here\n\n## Inferred\n- x\n',
      forbiddenInSeen: ['POISON'],
    });
    expect(poison.mode).toBe('placeholder');
    expect(poison.findings.some((f) => f.rule === 'seen_contains_forbidden_intent')).toBe(true);
  });

  it('mode full uses honesty audit (missing ref)', () => {
    const r = auditRawSeenDiscipline({
      store: fakeStore(['obs-1']),
      rawMarkdown: [
        '## Seen',
        '- [intel_observations:obs-1]: real fact with typed ref',
        '- bare claim without typed evidence that is long enough to leave placeholder mode',
        '',
        '## Inferred',
        '- judgement',
        '',
      ].join('\n'),
    });
    expect(r.mode).toBe('full');
    expect(r.findings.some((f) => f.rule === 'seen_bullet_missing_ref')).toBe(true);
  });
});

function completeReportMd(extraInferred = '- grounded [intel_observations:obs-1]') {
  return [
    '## Seen',
    '- [intel_observations:obs-1]: fact',
    '',
    '## Inferred',
    extraInferred,
    '',
    '## Cyber-Taoist analysis',
    '- stage note',
    '',
    '## 下一轮建议',
    '- next step',
    '',
  ].join('\n');
}

describe('checkReportMechanicalContract', () => {
  it('flags missing Inferred', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: fact',
      '',
      '## Cyber-Taoist analysis',
      '- x',
      '',
      '## 下一轮建议',
      '- y',
      '',
    ].join('\n');
    const { findings } = checkReportMechanicalContract({ store: fakeStore(), markdown: md });
    expect(findings.some((f) => f.rule === 'report_missing_inferred')).toBe(true);
  });

  it('flags missing Cyber-Taoist', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: fact',
      '',
      '## 基于证据的判断',
      '- x',
      '',
      '## Next cycle suggestions',
      '- y',
      '',
    ].join('\n');
    const { findings } = checkReportMechanicalContract({ store: fakeStore(), markdown: md });
    expect(findings.some((f) => f.rule === 'report_missing_cyber_taoist')).toBe(true);
  });

  it('flags missing next-cycle section', () => {
    const md = [
      '## Seen',
      '- [intel_observations:obs-1]: fact',
      '',
      '## Inferred',
      '- x',
      '',
      '## Cyber-Taoist analysis',
      '- y',
      '',
    ].join('\n');
    const { findings } = checkReportMechanicalContract({ store: fakeStore(), markdown: md });
    expect(findings.some((f) => f.rule === 'report_missing_next')).toBe(true);
  });

  it('flags invented judgement refs', () => {
    const md = completeReportMd('- invented [intel_observations:ghost]');
    const { findings } = checkReportMechanicalContract({ store: fakeStore(['obs-1']), markdown: md });
    const invented = findings.find((f) => f.rule === 'judgement_invented_refs');
    expect(invented).toBeTruthy();
    expect(invented.detail.refs).toContain('[intel_observations:ghost]');
  });

  it('returns empty findings for a compliant report', () => {
    const md = completeReportMd();
    const { findings } = checkReportMechanicalContract({ store: fakeStore(['obs-1']), markdown: md });
    expect(findings).toEqual([]);
  });
});
