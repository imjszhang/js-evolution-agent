import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '../JeaApp'
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
const settingsOpen = readParam('settings') === '1'
const empty = viewState === 'empty' || readParam('empty') === '1'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JeaApp
      locale={locale}
      viewState={viewState === 'empty' ? 'empty' : viewState}
      settingsOpen={settingsOpen}
      adapters={createWave1Adapters(empty ? {
        subjects: [],
        sessions: [],
        selectedSubjectId: null,
        selectedSessionId: null
      } : viewState === 'offline' ? {
        serviceStatus: 'offline'
      } : {})}
    />
  </StrictMode>
)
