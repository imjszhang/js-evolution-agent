import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWebJeaClient } from '../../../../apps/desktop/src/client-api/adapters/web'
import { createClientProductFeatures } from '../../../../apps/desktop/src/renderer/src/product-features'
import { JeaApp } from '../JeaApp'
import { JeaProductApp } from '../features/JeaProductApp'
import { JeaClientProvider } from '../features/client-context'
import { createFixtureSetupClient, createSetupFixtureState, type CliFixtureKind } from '../features/fixtures'
import { settingsFeature } from '../features/settings/module'
import { serviceStatusFeature } from '../features/service-status/module'
import { createWave1Adapters } from '../fixtures/wave1'
import { createEvolutionFixtureClient, createEvolutionInspectorFeature } from '../features/evolution'
import type { Locale } from '../i18n/messages'
import { fetchWebBootstrap, isExplicitWebFixtureMode, isJeaWebHosted, resolveHostedViewState } from './host-connection'
import '../styles/index.css'

function readParam(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

export function WebHostRoot() {
  const hosted = isJeaWebHosted()
  const fixtureMode = isExplicitWebFixtureMode(hosted)
  const queryState = fixtureMode ? readParam('state') : null
  const locale = (readParam('locale') === 'en' ? 'en' : 'zh') as Locale
  const settingsOpen = fixtureMode && readParam('settings') === '1' ? true : undefined
  const empty = fixtureMode && (queryState === 'empty' || readParam('empty') === '1')
  const inspectorMode = fixtureMode ? readParam('inspector') : null
  const subject = fixtureMode ? readParam('subject') : null
  const setupKind = fixtureMode ? readParam('setup') : null
  const cliKind = (readParam('cli') ?? (setupKind ? 'unsupported' : 'native')) as CliFixtureKind
  const [connected, setConnected] = useState<boolean | null>(hosted ? null : fixtureMode)
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
  const fixtureClient = useMemo(() => createFixtureSetupClient(fixture), [fixture])
  const host = cliKind === 'native' || !readParam('cli') ? 'web' : 'electron'
  const hostedClient = useMemo(() => hosted
    ? createWebJeaClient({
        baseUrl: window.location.origin,
        onConnectionChange: (state) => setConnected(state === 'online')
      })
    : null, [hosted])

  const features = useMemo(() => {
    if (hostedClient) return createClientProductFeatures(hostedClient)
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
            observability: {
              alpha: {
                subject: 'alpha',
                attention: { items: [], summary: { count: 0 } },
                open_cycles: 0,
                evidence_pending_count: 0,
                daemon_task_pending_count: 0
              }
            }
          }
        : undefined
    )
    return [
      createEvolutionInspectorFeature({
        client: evolutionClient,
        navFixtureCycleId: 'cycle-20260815-closed'
      }),
      serviceStatusFeature,
      settingsFeature
    ]
  }, [hostedClient, inspectorMode])

  const refresh = useCallback(async () => {
    if (!hosted || queryState) return
    setConnected(null)
    const result = await fetchWebBootstrap()
    setConnected(result.ok)
  }, [hosted, queryState])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (hosted && hostedClient) {
    return (
      <JeaProductApp
        locale={locale}
        host="web"
        client={hostedClient}
        viewState={viewState}
        settingsOpen={settingsOpen}
        features={features}
        adapters={{
          subjects: [],
          sessions: [],
          selectedSubjectId: null,
          selectedSessionId: null,
          serviceStatus: connected === false ? 'offline' : undefined,
          hostKind: 'web',
          onRetry: () => { void refresh() }
        }}
      />
    )
  }

  if (!fixtureMode) {
    return (
      <JeaClientProvider client={null} host="web">
        <JeaApp
          locale={locale}
          viewState="offline"
          features={[serviceStatusFeature, settingsFeature]}
          adapters={{
            subjects: [],
            sessions: [],
            selectedSubjectId: null,
            selectedSessionId: null,
            serviceStatus: 'offline',
            hostKind: 'web'
          }}
        />
      </JeaClientProvider>
    )
  }

  if (setupKind) {
    return (
      <JeaProductApp
        locale={locale}
        host={host}
        client={fixtureClient}
        initialReadiness={fixture.readiness}
      />
    )
  }

  return (
    <JeaClientProvider client={fixtureClient} host={host}>
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
          hostKind: 'web',
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
