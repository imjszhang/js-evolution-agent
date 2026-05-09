import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    preserveSymlinks: true,
    alias: {
      'js-yaml': resolve('node_modules/js-yaml/dist/js-yaml.mjs'),
      'proper-lockfile': resolve('node_modules/proper-lockfile/index.js'),
    },
  },
});

