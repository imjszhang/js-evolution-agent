import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('./test/setup-legacy-runtime.mjs', import.meta.url))],
    // Windows git/worktree fixtures can exceed 15s under full-suite parallel load.
    testTimeout: 30_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/*.spec.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Floors from the 2026-08-15 measured run. Do not auto-update in CI.
      thresholds: {
        statements: 69,
        branches: 59,
        functions: 78,
        lines: 71,
      },
      include: [
        'src/**/*.{js,mjs,cjs}',
        'apps/desktop/src/**/*.{js,mjs,cjs,ts,tsx}',
      ],
      exclude: [
        'test/**',
        '**/out/**',
        '**/*.test.*',
        '**/*.{md,html,css,json}',
        'archives/**',
        'runtime/**',
        'backups/**',
      ],
    },
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      'proper-lockfile': resolve(workspaceRoot, 'node_modules/proper-lockfile/index.js'),
    },
  },
});

