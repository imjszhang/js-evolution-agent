import { describe, expect, it } from 'vitest';
import { runProviderComparison } from '../scripts/acp-provider-compare.mjs';

describe('ACP provider comparison harness', () => {
  it('runs the same action through legacy and ACP providers without changing defaults', async () => {
    const seen = [];
    const report = await runProviderComparison({
      action: {
        id: 'compare-1',
        type: 'agent_run',
        params: {
          objective: 'Inspect the fixture',
          run_spec: { permission_profile: 'read_only' },
        },
      },
      context: { projectRoot: '/tmp/fixture' },
      run: async (action) => {
        const provider = action.params.provider;
        seen.push({
          provider,
          objective: action.params.objective,
          profile: action.params.run_spec.permission_profile,
        });
        return {
          success: true,
          agent: {
            schema_status: 'valid',
            acceptance_status: 'accepted',
            outputs: {
              agent_loop: {
                verification_attempts: provider.startsWith('acp:') ? 1 : 2,
                same_session: provider.startsWith('acp:'),
              },
              acp: {
                events: [
                  { event: 'tool_started' },
                  { event: 'tool_finished' },
                  { event: 'permission_decision' },
                ],
              },
            },
          },
        };
      },
    });

    expect(seen).toEqual([
      { provider: 'claude_code_sdk', objective: 'Inspect the fixture', profile: 'read_only' },
      { provider: 'acp:claude-code', objective: 'Inspect the fixture', profile: 'read_only' },
    ]);
    expect(report.providers[1]).toMatchObject({
      provider: 'acp:claude-code',
      schema_status: 'valid',
      verification_attempts: 1,
      same_session: true,
      tool_started: 1,
      tool_finished: 1,
      permission_decisions: 1,
    });
    expect(report.recommendation).toBe('acp_candidate');
    expect(report.default_changed).toBe(false);
  });
});
