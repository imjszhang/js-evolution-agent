import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type ResolvedTheme,
  type ThemePreference
} from './theme'

export type { ThemePreference, ResolvedTheme }

export interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference(preference: ThemePreference): void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({
  children,
  initialPreference
}: {
  children: ReactNode
  initialPreference?: ThemePreference
}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => initialPreference ?? readStoredTheme(typeof localStorage === 'undefined' ? null : localStorage)
  )
  const [systemDark, setSystemDark] = useState(systemPrefersDark)
  const resolved = resolveTheme(preference, systemDark)

  useEffect(() => {
    if (typeof document === 'undefined') return
    applyResolvedTheme(document.documentElement, resolved)
  }, [resolved])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setSystemDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    writeStoredTheme(typeof localStorage === 'undefined' ? null : localStorage, next)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used within ThemeProvider')
  return value
}
