import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '../JeaApp'
import { JeaProductApp } from '../features/JeaProductApp'
import { JeaClientProvider } from '../features/client-context'
import { createFixtureSetupClient, createSetupFixtureState, type CliFixtureKind } from '../features/fixtures'
import { settingsFeature } from '../features/settings/module'
import { createWave1Adapters } from '../fixtures/wave1'
import type { ShellViewState } from '../shell/GlobalStates'
import type { Locale } from '../i18n/messages'
import '../styles/index.css'

function readParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

const viewState = (readParam('state') ?? 'ready') as ShellViewState
const locale = (readParam('locale') === 'en' ? 'en' : 'zh') as Locale
const settingsOpen = readParam('settings') === '1' ? true : undefined
const empty = viewState === 'empty' || readParam('empty') === '1'
const setupKind = readParam('setup')
const cliKind = (readParam('cli') ?? (setupKind ? 'unsupported' : 'native')) as CliFixtureKind
const fixture = createSetupFixtureState({
  kind: setupKind === '1' || setupKind === 'empty'
    ? 'empty'
    : setupKind === 'channel'
      ? 'channel'
      : 'ready',
  cli: cliKind,
  model: readParam('model') === 'deepseek' ? 'deepseek' : 'mock'
})
const client = createFixtureSetupClient(fixture)
const host = cliKind === 'native' || !readParam('cli') ? 'web' : 'electron'

const root = (
  setupKind ? (
    <JeaProductApp
      locale={locale}
      host={host}
      client={client}
      initialReadiness={fixture.readiness}
    />
  ) : (
    <JeaClientProvider client={client} host={host}>
      <JeaApp
        locale={locale}
        viewState={viewState === 'empty' ? 'empty' : viewState}
        settingsOpen={settingsOpen}
        features={[settingsFeature]}
        adapters={createWave1Adapters(empty ? {
          subjects: [],
          sessions: [],
          selectedSubjectId: null,
          selectedSessionId: null
        } : viewState === 'offline' ? {
          serviceStatus: 'offline'
        } : {})}
      />
    </JeaClientProvider>
  )
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {root}
  </StrictMode>
)
