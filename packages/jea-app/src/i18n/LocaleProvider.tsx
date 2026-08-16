import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import {
  LOCALE_STORAGE_KEY,
  resolveLocale,
  t,
  type Locale,
  type MessageKey
} from './messages'

export interface LocaleContextValue {
  locale: Locale
  setLocale(locale: Locale): void
  t(key: MessageKey): string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function readInitialLocale(explicit?: Locale): Locale {
  if (explicit) return explicit
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY)
  const language = typeof navigator === 'undefined' ? null : navigator.language
  return resolveLocale(stored, language)
}

export function LocaleProvider({
  children,
  initialLocale
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocaleState] = useState<Locale>(() => readInitialLocale(initialLocale))

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // Persistence is best-effort.
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
    }
  }, [])

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => t(locale, key)
    }),
    [locale, setLocale]
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error('useLocale must be used within LocaleProvider')
  return value
}
