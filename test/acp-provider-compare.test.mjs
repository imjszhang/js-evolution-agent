import { describe, expect, it } from 'vitest';
import {
  compareProviderResults,
  runProviderComparison,
} from '../scripts/acp-provider-compare.mjs';

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

  it('keeps the legacy default when verification attempts are missing or worse', () => {
    const missing = compareProviderResults({
      action_id: 'missing',
      results: {
        'acp:claude-code': {
          success: true,
          agent: { schema_status: 'valid', outputs: { agent_loop: {} } },
        },
        claude_code_sdk: {
          success: true,
          agent: { schema_status: 'valid', outputs: { agent_loop: {} } },
        },
      },
    });
    expect(missing.recommendation).toBe('keep_legacy_default');
    expect(missing.comparison_basis.attempts_comparable).toBe(false);

    const worse = compareProviderResults({
      action_id: 'worse',
      results: {
        'acp:claude-code': {
          success: true,
          agent: {
            schema_status: 'valid',
            outputs: { agent_loop: { verification_attempts: 5 } },
          },
        },
        claude_code_sdk: {
          success: true,
          agent: {
            schema_status: 'valid',
            outputs: { agent_loop: { verification_attempts: 1 } },
          },
        },
      },
    });
    expect(worse.recommendation).toBe('keep_legacy_default');
  });

  it('refuses write-profile comparisons without isolated execution roots', async () => {
    await expect(runProviderComparison({
      action: {
        id: 'write-1',
        params: { run_spec: { permission_profile: 'workspace_write' } },
      },
      context: { projectRoot: '/tmp/shared' },
      run: async () => ({ success: true }),
    })).rejects.toThrow('isolated execution roots');

    const seen = [];
    await runProviderComparison({
      action: {
        id: 'write-2',
        params: { run_spec: { permission_profile: 'workspace_write' } },
      },
      context: { projectRoot: '/tmp/shared', mutated: true },
      executionRoots: {
        claude_code_sdk: '/tmp/legacy',
        'acp:claude-code': '/tmp/acp',
      },
      run: async (_action, context) => {
        seen.push(context.projectRoot);
        context.mutated = true;
        return { success: true, agent: { schema_status: 'valid' } };
      },
    });
    expect(seen).toEqual(['/tmp/legacy', '/tmp/acp']);
  });
});
