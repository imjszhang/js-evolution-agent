import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '../JeaApp'
import { createWave1Adapters } from '../fixtures/wave1'
import type { ShellViewState } from '../shell/GlobalStates'
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
  const [connected, setConnected] = useState<boolean | null>(hosted && !queryState ? null : true)
  const viewState = resolveHostedViewState({
    queryState,
    hosted,
    connected
  })

  const refresh = useCallback(async () => {
    if (!hosted || queryState) return
    setConnected(null)
    const result = await fetchWebBootstrap()
    setConnected(result.ok)
  }, [hosted, queryState])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <JeaApp
      locale={locale}
      viewState={viewState === 'empty' ? 'empty' : viewState}
      settingsOpen={settingsOpen}
      adapters={createWave1Adapters(empty ? {
        subjects: [],
        sessions: [],
        selectedSubjectId: null,
        selectedSessionId: null
      } : viewState === 'offline' || connected === false ? {
        serviceStatus: 'offline',
        onRetry: () => { void refresh() }
      } : {})}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebHostRoot />
  </StrictMode>
)
