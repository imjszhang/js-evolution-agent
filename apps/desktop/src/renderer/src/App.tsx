import { useCallback, useEffect, useState } from 'react'
import type { SubjectSnapshot } from '../../shared/contract'

function number(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function statusClass(ok: unknown): string {
  return ok === false ? 'bad' : 'good'
}

function SubjectPanel({ snapshot }: { snapshot: SubjectSnapshot }) {
  const { subject, daemon, observability } = snapshot
  const tasks = daemon.tasks ?? {}
  const counts = tasks.counts ?? {}
  const cycles = daemon.cycles ?? {}
  const worker = daemon.worker ?? {}
  const attention = observability.attention ?? {}
  const recentCycles = Array.isArray(cycles.recent) ? cycles.recent : []
  const taskRows = [
    ...(Array.isArray(tasks.running) ? tasks.running : []),
    ...(Array.isArray(tasks.step_tasks) ? tasks.step_tasks : [])
  ].filter((task, index, all) =>
    all.findIndex((candidate) => candidate.task_id === task.task_id) === index
  )

  return (
    <article className="subject-panel">
      <header className="subject-header">
        <div>
          <p className="eyebrow">{subject.namespace}{subject.isDefault ? ' · default' : ''}</p>
          <h2>{subject.name}</h2>
        </div>
        <span className={`health ${statusClass(daemon.health?.ok)}`}>
          {daemon.health?.status ?? 'unknown'}
        </span>
      </header>

      <section className="kpis" aria-label={`${subject.name} KPIs`}>
        <div><strong>{number(cycles.open_count)}</strong><span>Open cycles</span></div>
        <div><strong>{number(counts.pending)}</strong><span>Pending tasks</span></div>
        <div><strong>{number(counts.running)}</strong><span>Running tasks</span></div>
        <div><strong>{number(counts.failed)}</strong><span>Failed tasks</span></div>
        <div><strong>{number(attention.summary?.active_count)}</strong><span>Attention</span></div>
      </section>

      <div className="grid">
        <section className="card">
          <h3>Worker & tasks</h3>
          <dl>
            <dt>Worker</dt><dd>{worker.running ? 'running' : 'stopped'}</dd>
            <dt>PID</dt><dd>{worker.pid ?? '—'}</dd>
            <dt>Heartbeat</dt><dd>{worker.heartbeat_at ?? '—'}</dd>
            <dt>Pipeline</dt><dd>{daemon.pipeline ?? '—'}</dd>
          </dl>
          {taskRows.length ? (
            <ul className="compact-list">
              {taskRows.slice(0, 8).map((task: any) => (
                <li key={task.task_id}>
                  <span>{task.type}</span>
                  <code>{task.status ?? (task.expired ? 'expired' : 'running')}</code>
                </li>
              ))}
            </ul>
          ) : <p className="empty">No active or recent step tasks.</p>}
        </section>

        <section className="card">
          <h3>Cycle steps</h3>
          {recentCycles.length ? recentCycles.map((cycle: any) => (
            <div className="cycle" key={cycle.cycle_id}>
              <p><code>{cycle.cycle_id}</code><span>{cycle.status ?? 'open'}</span></p>
              <div className="steps">
                {Object.entries(cycle.steps ?? {}).map(([step, detail]: [string, any]) => (
                  <span className={`step step-${detail?.status ?? detail}`} key={step}>
                    {step}: {detail?.status ?? detail}
                  </span>
                ))}
              </div>
            </div>
          )) : <p className="empty">No open cycles.</p>}
        </section>

        <section className="card attention-card">
          <h3>Attention</h3>
          {attention.items?.length ? (
            <ul className="attention-list">
              {attention.items.slice(0, 10).map((item: any, index: number) => (
                <li key={`${item.kind}-${index}`} className={`severity-${item.severity}`}>
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                </li>
              ))}
            </ul>
          ) : <p className="empty">No attention items.</p>}
        </section>
      </div>
    </article>
  )
}

export default function App() {
  const [snapshots, setSnapshots] = useState<SubjectSnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.jea.invoke<SubjectSnapshot[]>('ops.refresh')
      setSnapshots(next)
      setRefreshedAt(new Date().toLocaleTimeString())
    } catch {
      setError('Unable to read JEA operational state.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Read-only operations</p>
          <h1>JEA Ops</h1>
          <p className="subtitle">Daemon health, cycle progress and attention across subjects.</p>
        </div>
        <div className="refresh">
          <span>{refreshedAt ? `Updated ${refreshedAt}` : 'Not refreshed'}</span>
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <p className="error" role="alert">{error}</p>}
      {!loading && snapshots.length === 0 && !error && <p className="empty-state">No subjects registered.</p>}
      <div className="subjects">
        {snapshots.map((snapshot) => (
          <SubjectPanel key={snapshot.subject.name} snapshot={snapshot} />
        ))}
      </div>
    </main>
  )
}
