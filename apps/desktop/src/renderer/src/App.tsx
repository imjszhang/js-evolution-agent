import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SubjectSnapshot } from '../../shared/contract'
import { AcpWorkspace } from './components/AcpWorkspace'
import { Navigation, type AppPage } from './components/Navigation'
import { OpsView } from './components/OpsView'
import { TodoCenter } from './components/TodoCenter'
import { ChannelChatView } from './components/ChannelChatView'
import { defaultSubjectSelection } from './subject-selection'
import { errorMessage, withTimeout } from './utils'

export default function App() {
  const [snapshots, setSnapshots] = useState<SubjectSnapshot[]>([])
  const [subject, setSubject] = useState<string | null>(null)
  const [page, setPage] = useState<AppPage>('ops')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await withTimeout(
        window.jea.invoke<SubjectSnapshot[]>('ops.refresh'),
        15_000,
        'Timed out while reading JEA operational state.'
      )
      setSnapshots(next)
      setSubject((current) => {
        if (current && next.some((snapshot) => snapshot.subject.name === current)) return current
        return defaultSubjectSelection(next.map((snapshot) => snapshot.subject))
      })
      setRefreshedAt(new Date().toLocaleTimeString())
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to read JEA operational state.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!subject) return
    void window.jea.invoke('projection.watch', { subject })
    return () => {
      void window.jea.invoke('projection.stop').catch(() => undefined)
    }
  }, [subject])

  useEffect(() => window.jea.subscribe((event) => {
    if (event.type === 'projection.ops_updated') {
      const snapshot = event.payload.snapshot as SubjectSnapshot | undefined
      if (!snapshot?.subject?.name) return
      setSnapshots((current) => {
        const index = current.findIndex((item) => item.subject.name === snapshot.subject.name)
        if (index < 0) return [...current, snapshot]
        const next = [...current]
        next[index] = snapshot
        return next
      })
      setRefreshedAt(new Date(event.ts).toLocaleTimeString())
      return
    }
    if (event.type.startsWith('daemon_')) {
      void window.jea.invoke('projection.refresh').catch(() => refresh())
    }
  }), [refresh])

  const subjects = useMemo(() => snapshots.map((snapshot) => snapshot.subject), [snapshots])
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.subject.name === subject)

  return (
    <div className="app-shell">
      <Navigation
        page={page}
        subjects={subjects}
        subject={subject}
        onPageChange={setPage}
        onSubjectChange={setSubject}
      />
      <main className="app-content">
        {page === 'ops' && (
          <OpsView
            snapshot={selectedSnapshot}
            loading={loading}
            error={error}
            refreshedAt={refreshedAt}
            onRefresh={refresh}
          />
        )}
        {page === 'todo' && <TodoCenter subject={subject} />}
        {page === 'channel' && <ChannelChatView subject={subject} />}
        {page === 'acp' && <AcpWorkspace />}
      </main>
    </div>
  )
}
