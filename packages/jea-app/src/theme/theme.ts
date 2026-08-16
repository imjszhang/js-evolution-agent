export const THEME_STORAGE_KEY = 'jea.theme'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export function parseStoredTheme(value: string | null | undefined): ThemePreference {
  if (value === 'light' || value === 'dark' || value === 'system') return value
  return 'system'
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

export function readStoredTheme(storage: Pick<Storage, 'getItem'> | null | undefined): ThemePreference {
  try {
    return parseStoredTheme(storage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function writeStoredTheme(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  preference: ThemePreference
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Persistence is best-effort in private browsing and fixture hosts.
  }
}

export function applyResolvedTheme(
  root: { classList: { toggle(token: string, force?: boolean): unknown }; dataset: DOMStringMap },
  theme: ResolvedTheme
): void {
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
  root.dataset.themeReady = 'true'
}

export const THEME_BOOT_SCRIPT = "(function(){try{var k='jea.theme';var s=localStorage.getItem(k);var p=s==='light'||s==='dark'||s==='system'?s:'system';var dark=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',dark);document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.dataset.themeReady='true';}catch(e){document.documentElement.dataset.theme='light';document.documentElement.dataset.themeReady='true';}})();"
