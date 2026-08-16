import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '../JeaApp'
import { createWave1Adapters } from '../fixtures/wave1'
import { createEvolutionFixtureClient, createEvolutionInspectorFeature } from '../features/evolution'
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

const inspectorMode = readParam('inspector')
const subject = readParam('subject')
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
const features = [
  createEvolutionInspectorFeature({
    client: evolutionClient,
    navFixtureCycleId: 'cycle-20260815-closed'
  })
]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
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
      } : viewState === 'offline' ? {
        serviceStatus: 'offline'
      } : subject ? {
        selectedSubjectId: subject
      } : {})}
    />
  </StrictMode>
)
