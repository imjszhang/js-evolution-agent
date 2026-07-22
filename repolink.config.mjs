import { defineLinks } from 'js-repolink';

export const links = defineLinks({
  'agentank-evolver': {
    label: 'agentank-evolver',
    envVar: 'AGENTANK_EVOLVER_PATH',
    runtime: 'node',
    entry: 'src/cli.mjs',
    description: 'AgenTank strategy evolution workspace (lane target + configured external actions)',
    preflight: {
      kind: 'json',
      args: ['--help'],
      successField: 'success',
      successMessage: 'agentank-evolver CLI responded with success JSON',
      failMessage: 'agentank-evolver CLI preflight failed',
      timeoutMs: 15000,
    },
    versionProbe: {
      file: 'package.json',
      jsonField: 'version',
      expectedRange: '0.1.x',
      expectedPattern: '^0\\.1\\.',
    },
  },
});
