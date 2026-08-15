import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(fileURLToPath(new URL('../..', import.meta.url))),
  test: {
    include: ['apps/desktop/test/**/*.test.ts', 'apps/desktop/test/**/*.test.tsx']
  }
})
