import { useMemo, useState } from 'react'
import { LocaleProvider } from './i18n/LocaleProvider'
import type { Locale } from './i18n/messages'
import { AppShell } from './shell/AppShell'
import type { ShellViewState } from './shell/GlobalStates'
import { createFeatureRegistry } from './slots/registry'
import type { FeatureModule, FeatureRegistry, ShellAdapters } from './slots/types'
import { ThemeProvider } from './theme/ThemeProvider'
import type { ThemePreference } from './theme/theme'
import { createWave1Adapters } from './fixtures/wave1'

export interface JeaAppProps {
  adapters?: ShellAdapters
  features?: FeatureModule[]
  registry?: FeatureRegistry
  locale?: Locale
  theme?: ThemePreference
  viewState?: ShellViewState
  settingsOpen?: boolean
  onSettingsOpenChange?(open: boolean): void
}

export function JeaApp({
  adapters,
  features = [],
  registry,
  locale,
  theme,
  viewState = 'ready',
  settingsOpen,
  onSettingsOpenChange
}: JeaAppProps) {
  const [selectedSubjectId, setSelectedSubjectId] = useState(adapters?.selectedSubjectId ?? 'alpha')
  const [selectedSessionId, setSelectedSessionId] = useState(adapters?.selectedSessionId ?? 'alpha-main')
  const resolvedRegistry = useMemo(
    () => registry ?? createFeatureRegistry(features),
    [features, registry]
  )
  const resolvedAdapters = useMemo<ShellAdapters>(() => {
    const base = createWave1Adapters(adapters)
    return {
      ...base,
      selectedSubjectId: adapters?.selectedSubjectId ?? selectedSubjectId,
      selectedSessionId: adapters?.selectedSessionId ?? selectedSessionId,
      onSelectSubject: adapters?.onSelectSubject ?? setSelectedSubjectId,
      onSelectSession: adapters?.onSelectSession ?? setSelectedSessionId
    }
  }, [adapters, selectedSessionId, selectedSubjectId])

  return (
    <ThemeProvider initialPreference={theme}>
      <LocaleProvider initialLocale={locale}>
        <AppShell
          adapters={resolvedAdapters}
          registry={resolvedRegistry}
          viewState={viewState}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={onSettingsOpenChange}
        />
      </LocaleProvider>
    </ThemeProvider>
  )
}
