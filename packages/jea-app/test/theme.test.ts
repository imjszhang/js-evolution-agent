import { describe, expect, it } from 'vitest'
import { parseStoredTheme, resolveTheme } from '../src/theme/theme'

describe('theme resolution', () => {
  it('follows system preference until an explicit override is stored', () => {
    expect(parseStoredTheme(null)).toBe('system')
    expect(parseStoredTheme('dark')).toBe('dark')
    expect(parseStoredTheme('nope')).toBe('system')
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
