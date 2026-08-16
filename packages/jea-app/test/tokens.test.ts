import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/styles/index.css', import.meta.url)), 'utf8')

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
  })
})
