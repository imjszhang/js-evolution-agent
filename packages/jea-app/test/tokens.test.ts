import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/styles/index.css', import.meta.url)), 'utf8')
const fontsCss = readFileSync(fileURLToPath(new URL('../src/styles/fonts.css', import.meta.url)), 'utf8')
const fontsDir = fileURLToPath(new URL('../src/styles/fonts/', import.meta.url))

describe('semantic design tokens', () => {
  it('covers typography, spacing, surfaces, borders, status, focus, and destructive actions', () => {
    for (const token of [
      '--font-sans',
      '--text-sm',
      '--spacing',
      '--background',
      '--surface',
      '--surface-raised',
      '--border',
      '--ring',
      '--destructive',
      '--status-ok',
      '--status-warn',
      '--status-error',
      '--status-offline'
    ]) {
      expect(css).toContain(token)
    }
    expect(css).toContain(':focus-visible')
    expect(css).toContain('.dark')
    expect(css).toContain('JeaUI')
    expect(css).toContain('JeaCJK')
    expect(fontsCss).toContain('inter-latin-400.woff2')
    expect(fontsCss).toContain('noto-sans-sc-subset.woff2')
    for (const file of ['inter-latin-400.woff2', 'inter-latin-600.woff2', 'noto-sans-sc-subset.woff2']) {
      expect(existsSync(join(fontsDir, file))).toBe(true)
    }
  })
})
