import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['test/setup-legacy-runtime.mjs'],
    // Windows git/worktree fixtures can exceed 15s under full-suite parallel load.
    testTimeout: 30_000,
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
      'proper-lockfile': resolve('node_modules/proper-lockfile/index.js'),
    },
  },
});

