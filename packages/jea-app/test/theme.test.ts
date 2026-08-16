import { describe, expect, it } from 'vitest'
import { parseStoredTheme, resolveTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from '../src/theme/theme'

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

  it('keeps the static boot script aligned with the storage key', () => {
    expect(THEME_STORAGE_KEY).toBe('jea.theme')
    expect(THEME_BOOT_SCRIPT.includes(THEME_STORAGE_KEY)).toBe(true)
    expect(THEME_BOOT_SCRIPT.includes('JSON.stringify')).toBe(false)
    expect(THEME_BOOT_SCRIPT.includes('${')).toBe(false)
  })
})
