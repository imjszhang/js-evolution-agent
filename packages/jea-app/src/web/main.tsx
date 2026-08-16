import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '../JeaApp'
import { JeaProductApp } from '../features/JeaProductApp'
import { JeaClientProvider } from '../features/client-context'
import { createFixtureSetupClient, createSetupFixtureState, type CliFixtureKind } from '../features/fixtures'
import { settingsFeature } from '../features/settings/module'
import { createWave1Adapters } from '../fixtures/wave1'
import { createEvolutionFixtureClient, createEvolutionInspectorFeature } from '../features/evolution'
import type { Locale } from '../i18n/messages'
import { fetchWebBootstrap, isJeaWebHosted, resolveHostedViewState } from './host-connection'
import '../styles/index.css'

function readParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

function WebHostRoot() {
  const queryState = readParam('state')
  const locale = (readParam('locale') === 'en' ? 'en' : 'zh') as Locale
  const settingsOpen = readParam('settings') === '1' ? true : undefined
  const hosted = isJeaWebHosted()
  const empty = queryState === 'empty' || readParam('empty') === '1'
  const inspectorMode = readParam('inspector')
  const subject = readParam('subject')
  const setupKind = readParam('setup')
  const cliKind = (readParam('cli') ?? (setupKind ? 'unsupported' : 'native')) as CliFixtureKind
  const [connected, setConnected] = useState<boolean | null>(hosted && !queryState ? null : true)
  const viewState = resolveHostedViewState({
    queryState,
    hosted,
    connected
  })

  const fixture = useMemo(() => createSetupFixtureState({
    kind: setupKind === '1' || setupKind === 'empty'
      ? 'empty'
      : setupKind === 'channel'
        ? 'channel'
        : 'ready',
    cli: cliKind,
    model: readParam('model') === 'deepseek' ? 'deepseek' : 'mock'
  }), [cliKind, setupKind])
  const client = useMemo(() => createFixtureSetupClient(fixture), [fixture])
  const host = cliKind === 'native' || !readParam('cli') ? 'web' : 'electron'

  const features = useMemo(() => {
    const evolutionClient = createEvolutionFixtureClient(
      inspectorMode === 'malformed'
        ? {
            lists: {
              alpha: {
                subject: 'alpha',
                namespace: 'alpha-data',
                round_count: 1,
                cycles: [{ cycle_id: 'broken', generated_at: null, tldr: null, has_diary: false, status: null }]
              }
            },
            cycles: { alpha: {} },
            rounds: { alpha: {} },
            observability: { alpha: { subject: 'alpha', attention: {}, open_cycles: 0 } }
          }
        : undefined
    )
    return [
      createEvolutionInspectorFeature({
        client: evolutionClient,
        navFixtureCycleId: 'cycle-20260815-closed'
      }),
      settingsFeature
    ]
  }, [inspectorMode])

  const refresh = useCallback(async () => {
    if (!hosted || queryState) return
    setConnected(null)
    const result = await fetchWebBootstrap()
    setConnected(result.ok)
  }, [hosted, queryState])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (setupKind) {
    return (
      <JeaProductApp
        locale={locale}
        host={host}
        client={client}
        initialReadiness={fixture.readiness}
      />
    )
  }

  return (
    <JeaClientProvider client={client} host={host}>
      <JeaApp
        locale={locale}
        viewState={viewState === 'empty' ? 'empty' : viewState}
        settingsOpen={settingsOpen}
        features={features}
        adapters={createWave1Adapters(empty ? {
          subjects: [],
          sessions: [],
          selectedSubjectId: null,
          selectedSessionId: null
        } : inspectorMode === 'empty' ? {
          subjects: [{ id: 'empty', name: 'empty', namespace: 'empty-data' }],
          selectedSubjectId: 'empty',
          selectedSessionId: null,
          sessions: []
        } : viewState === 'offline' || connected === false ? {
          serviceStatus: 'offline',
          onRetry: () => { void refresh() }
        } : subject ? {
          selectedSubjectId: subject
        } : {})}
      />
    </JeaClientProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebHostRoot />
  </StrictMode>
)
