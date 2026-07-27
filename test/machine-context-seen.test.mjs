import { describe, expect, it } from 'vitest';
import { buildMachineContextSeenBullets } from '../src/intelligence/machine-context-refs.mjs';
import { enforceIntelReportSeenGate } from '../src/intelligence/report-builder.mjs';
import { assembleAgentLoopHostSeenBody } from '../src/evolution/cycle-steps.mjs';
import { extractSeenSectionBody } from '../src/intelligence/report-honesty.mjs';

describe('buildMachineContextSeenBullets', () => {
  it('renders all enum keys with existence/count summaries and never quote brief claims', () => {
    const poison = 'POISON_SHOULD_NOT_APPEAR';
    const body = buildMachineContextSeenBullets({
      reportContext: {
        current_cycle: { cycle_id: 'cycle-1', stage: 'pre_report' },
        active_goals: {
          id: 'root',
          name: 'Root Goal',
          children: [{ id: 'child', name: 'Child', children: [] }],
        },
        standing_memory: { exists: false },
        current_beliefs: { exists: true, beliefs: [{ status: 'active' }, { status: 'validated' }] },
        source_counts: { observations: 2, probe_results: 0 },
        decision_queue: { pending: 1, in_progress: 0, completed: 3 },
      },
      operatorBriefs: [{ kind: 'verification_request', summary: poison }],
    });
    expect(body).toContain('[machine_context:decision_queue]');
    expect(body).toContain('[machine_context:active_goals]');
    expect(body).toContain('[machine_context:standing_memory]');
    expect(body).toContain('[machine_context:current_beliefs]');
    expect(body).toContain('[machine_context:source_counts]');
    expect(body).toContain('[machine_context:operator_intent_briefs]');
    expect(body).toContain('[machine_context:cycle_stage]');
    expect(body).toContain('verification_request=1');
    expect(body).not.toContain(poison);
  });
});

describe('enforceIntelReportSeenGate', () => {
  it('replaces existing Seen section and inserts when missing', () => {
    const withSeen = [
      '# Report',
      '',
      '## Seen',
      '- dirty poison bullet',
      '',
      '## Inferred',
      '- keep me',
      '',
    ].join('\n');
    const replaced = enforceIntelReportSeenGate(withSeen, '- [machine_context:active_goals]: ok');
    const { body } = extractSeenSectionBody(replaced);
    expect(body).toContain('[machine_context:active_goals]');
    expect(body).not.toContain('dirty poison');
    expect(replaced).toContain('## Inferred');
    expect(replaced).toContain('keep me');

    const inserted = enforceIntelReportSeenGate('## Inferred\n\n- only', '- [machine_context:cycle_stage]: x');
    expect(inserted.startsWith('## Seen')).toBe(true);
    expect(inserted).toContain('[machine_context:cycle_stage]');
  });
});

describe('assembleAgentLoopHostSeenBody', () => {
  it('merges machine_context, mechanical Seen, and verified_facts with ref dedupe', () => {
    const body = assembleAgentLoopHostSeenBody({
      reportContext: {
        current_cycle: { cycle_id: 'c1' },
        source_counts: { observations: 1 },
        standing_memory: { exists: false },
        current_beliefs: { exists: false },
      },
      queueSummary: { pending: 0, in_progress: 0, completed: 0 },
      operatorBriefs: [],
      mechanicalSeen: '- [intel_observations:fact-1]: operator fact',
      verifiedFacts: [
        { ref: '[intel_observations:fact-1]', statement: 'duplicate should skip' },
        { ref: '[intel_observations:obs-1]', statement: 'new verified fact' },
      ],
    });
    expect(body).toContain('[machine_context:decision_queue]');
    expect(body).toContain('[intel_observations:fact-1]: operator fact');
    expect(body).toContain('[intel_observations:obs-1]: new verified fact');
    expect(body).not.toContain('duplicate should skip');
  });
});
