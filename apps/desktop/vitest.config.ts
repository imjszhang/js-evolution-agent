import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '../..'),
  test: {
    include: ['apps/desktop/test/**/*.test.ts']
  }
})
