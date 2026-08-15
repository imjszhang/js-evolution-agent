import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
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

  it('overrides a shared action cwd with isolated roots and keeps host services', async () => {
    const seen = [];
    class AiService {
      ping() {
        return 'ok';
      }
    }
    class LoggerService {
      info() {}
    }
    const ai = new AiService();
    const logger = new LoggerService();
    const report = await runProviderComparison({
      action: {
        id: 'write-shared',
        params: {
          cwd: '/tmp/shared',
          executionRoot: '/tmp/shared',
          run_spec: {
            permission_profile: 'workspace_write',
            primary_cwd: '/tmp/shared',
          },
        },
      },
      context: {
        projectRoot: '/tmp/shared',
        ai,
        host: { logger },
        scratch: { rows: [] },
      },
      executionRoots: {
        claude_code_sdk: '/tmp/legacy',
        'acp:claude-code': '/tmp/acp',
      },
      run: async (action, context) => {
        seen.push({
          provider: action.params.provider,
          cwd: action.params.cwd,
          primary: action.params.run_spec.primary_cwd,
          projectRoot: context.projectRoot,
          hasAi: context.ai === ai && context.ai.ping() === 'ok',
          hasHost: context.host?.logger === logger,
          scratch: context.scratch,
        });
        context.scratch.rows.push(action.params.provider);
        return { success: true, agent: { schema_status: 'valid' } };
      },
    });

    expect(seen).toEqual([
      {
        provider: 'claude_code_sdk',
        cwd: '/tmp/legacy',
        primary: '/tmp/legacy',
        projectRoot: '/tmp/legacy',
        hasAi: true,
        hasHost: true,
        scratch: { rows: ['claude_code_sdk'] },
      },
      {
        provider: 'acp:claude-code',
        cwd: '/tmp/acp',
        primary: '/tmp/acp',
        projectRoot: '/tmp/acp',
        hasAi: true,
        hasHost: true,
        scratch: { rows: ['acp:claude-code'] },
      },
    ]);
    expect(report.providers[0].execution_root).toBe(resolve('/tmp/legacy'));
    expect(report.providers[1].execution_root).toBe(resolve('/tmp/acp'));
  });

  it('requires a distinct isolated root for every write-profile provider', async () => {
    const action = {
      id: 'write-root-validation',
      params: { run_spec: { permission_profile: 'workspace_write' } },
    };
    const context = { projectRoot: '/tmp/shared' };
    const run = async () => ({ success: true });

    await expect(runProviderComparison({
      action,
      context,
      executionRoots: { claude_code_sdk: '/tmp/legacy' },
      run,
    })).rejects.toThrow(/every provider/);

    await expect(runProviderComparison({
      action,
      context,
      executionRoots: {
        claude_code_sdk: '/tmp/shared-root',
        'acp:claude-code': '/tmp/shared-root',
      },
      run,
    })).rejects.toThrow(/distinct execution roots/);

    await expect(runProviderComparison({
      action,
      context,
      isolateRoots: 'never',
      run,
    })).rejects.toThrow(/cannot disable/);
  });

  it('fails closed when an isolated execution root cannot be applied', async () => {
    let ran = 0;
    await expect(runProviderComparison({
      action: {
        id: 'write-mismatch',
        params: {
          cwd: '/tmp/shared',
          resource_scope: 'source_root',
          run_spec: {
            permission_profile: 'workspace_write',
            primary_cwd: '/tmp/shared',
          },
        },
      },
      context: {
        projectRoot: '/tmp/shared',
        host: { sourceRoot: '/tmp/other-source' },
      },
      executionRoots: {
        claude_code_sdk: '/tmp/legacy',
        'acp:claude-code': '/tmp/acp',
      },
      run: async () => {
        ran += 1;
        return { success: true };
      },
    })).rejects.toThrow(/execution root could not be isolated/);
    expect(ran).toBe(0);
  });
});
