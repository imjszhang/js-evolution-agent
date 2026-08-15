import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SubjectSnapshot } from '../../shared/contract'
import { AcpWorkspace } from './components/AcpWorkspace'
import { Navigation, type AppPage } from './components/Navigation'
import { OpsView } from './components/OpsView'
import { TodoCenter } from './components/TodoCenter'
import { defaultSubjectSelection } from './subject-selection'
import { errorMessage } from './utils'

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
      const next = await window.jea.invoke<SubjectSnapshot[]>('ops.refresh')
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

  useEffect(() => window.jea.subscribe((event) => {
    if (event.type.startsWith('daemon_')) void refresh()
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
        {page === 'acp' && <AcpWorkspace />}
      </main>
    </div>
  )
}
