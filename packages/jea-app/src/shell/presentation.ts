export const SHELL_PRESENTATIONS = ['settings', 'base'] as const

export type ShellPresentation = (typeof SHELL_PRESENTATIONS)[number]
export type ShellShortcut = 'settings'

export type ShellCloseAction =
  | { kind: 'none' }
  | { kind: 'close-settings' }

export interface ShellPresentationInput {
  settingsOpen: boolean
}

export interface ShellPresentationProjection {
  active: ShellPresentation
  allowsShortcut(shortcut: ShellShortcut): boolean
  resolveCloseAction(): ShellCloseAction
}

export function resolveShellPresentation(input: ShellPresentationInput): ShellPresentationProjection {
  const active: ShellPresentation = input.settingsOpen ? 'settings' : 'base'
  return {
    active,
    allowsShortcut(shortcut) {
      if (shortcut === 'settings') return active === 'base'
      return false
    },
    resolveCloseAction() {
      if (active === 'settings') return { kind: 'close-settings' }
      return { kind: 'none' }
    }
  }
}

export function isSettingsShortcut(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): boolean {
  return event.key === ',' && (event.metaKey || event.ctrlKey) && !event.altKey
}

export function isEscapeKey(event: { key: string }): boolean {
  return event.key === 'Escape'
}
