import { describe, expect, it } from 'vitest'
import { isEscapeKey, isSettingsShortcut, resolveShellPresentation } from '../src/shell/presentation'

describe('shell close priority', () => {
  it('lets Esc close Settings before any base-level dismiss', () => {
    const settings = resolveShellPresentation({ settingsOpen: true })
    expect(settings.active).toBe('settings')
    expect(settings.allowsShortcut('settings')).toBe(false)
    expect(settings.resolveCloseAction()).toEqual({ kind: 'close-settings' })

    const base = resolveShellPresentation({ settingsOpen: false })
    expect(base.active).toBe('base')
    expect(base.allowsShortcut('settings')).toBe(true)
    expect(base.resolveCloseAction()).toEqual({ kind: 'none' })
  })

  it('opens Settings from Cmd/Ctrl+, only while the base workspace is active', () => {
    expect(isSettingsShortcut({ key: ',', metaKey: true, ctrlKey: false, altKey: false })).toBe(true)
    expect(isSettingsShortcut({ key: ',', metaKey: false, ctrlKey: true, altKey: false })).toBe(true)
    expect(isSettingsShortcut({ key: ',', metaKey: true, ctrlKey: false, altKey: true })).toBe(false)
    expect(isEscapeKey({ key: 'Escape' })).toBe(true)
  })
})
