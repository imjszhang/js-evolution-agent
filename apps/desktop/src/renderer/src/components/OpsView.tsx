import type { SubjectSnapshot } from '../../../shared/contract'
import { isRecord, numeric, text, truncate, type UnknownRecord } from '../utils'
import { DaemonPanel } from './DaemonPanel'

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function SubjectOperations({
  snapshot,
  onRefresh
}: {
  snapshot: SubjectSnapshot
  onRefresh(): Promise<void>
}) {
  const { daemon, observability, subject } = snapshot
  const tasks = isRecord(daemon.tasks) ? daemon.tasks : {}
  const counts = isRecord(tasks.counts) ? tasks.counts : {}
  const cycles = isRecord(daemon.cycles) ? daemon.cycles : {}
  const worker = isRecord(daemon.worker) ? daemon.worker : {}
  const attention = isRecord(observability.attention) ? observability.attention : {}
  const summary = isRecord(attention.summary) ? attention.summary : {}
  const recentCycles = records(cycles.recent)
  const attentionItems = records(attention.items)
  const dedupedTasks = [...records(tasks.running), ...records(tasks.step_tasks)]
    .filter((task, index, all) => {
      const id = text(task.task_id, `${index}`)
      return all.findIndex((candidate, candidateIndex) =>
        text(candidate.task_id, `${candidateIndex}`) === id) === index
    })

  return (
    <div className="ops-layout">
      <section className="metric-strip" aria-label={`${subject.name} operational metrics`}>
        <div><span>Open cycles</span><strong>{numeric(cycles.open_count)}</strong><small>in progress</small></div>
        <div><span>Pending</span><strong>{numeric(counts.pending)}</strong><small>queued tasks</small></div>
        <div><span>Running</span><strong>{numeric(counts.running)}</strong><small>active tasks</small></div>
        <div><span>Failed</span><strong>{numeric(counts.failed)}</strong><small>need review</small></div>
        <div><span>Attention</span><strong>{numeric(summary.active_count)}</strong><small>open signals</small></div>
      </section>

      <div className="ops-grid">
        <DaemonPanel subject={subject.name} initial={snapshot.supervisor} onChanged={onRefresh} />

        <section className="panel" aria-labelledby="worker-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Runtime</p>
              <h3 id="worker-title">Worker & tasks</h3>
            </div>
            <span className={`status-pill ${worker.running ? 'mode-managed' : 'mode-none'}`}>
              <span className="status-dot" />
              {worker.running ? 'running' : 'stopped'}
            </span>
          </div>
          <dl className="detail-grid">
            <div><dt>PID</dt><dd>{text(worker.pid)}</dd></div>
            <div><dt>Pipeline</dt><dd>{text(daemon.pipeline)}</dd></div>
            <div className="wide"><dt>Heartbeat</dt><dd>{text(worker.heartbeat_at)}</dd></div>
          </dl>
          <div className="subsection-head">
            <h4>Task activity</h4>
            <span>{dedupedTasks.length} visible</span>
          </div>
          {dedupedTasks.length > 0 ? (
            <ul className="data-list">
              {dedupedTasks.slice(0, 8).map((task, index) => (
                <li key={text(task.task_id, String(index))}>
                  <div>
                    <strong>{text(task.type, 'Task')}</strong>
                    <small>{truncate(task.task_id, 48)}</small>
                  </div>
                  <span className="compact-status">
                    {text(task.status, task.expired ? 'expired' : 'running')}
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="empty-block">No active or recent step tasks.</div>}
        </section>

        <section className="panel span-two" aria-labelledby="cycles-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Pipeline progress</p>
              <h3 id="cycles-title">Recent cycles</h3>
            </div>
            <span className="panel-count">{recentCycles.length}</span>
          </div>
          {recentCycles.length > 0 ? (
            <div className="cycle-list">
              {recentCycles.map((cycle, index) => {
                const steps = isRecord(cycle.steps) ? cycle.steps : {}
                return (
                  <article className="cycle-row" key={text(cycle.cycle_id, String(index))}>
                    <div className="cycle-identity">
                      <strong>{text(cycle.cycle_id, 'Unidentified cycle')}</strong>
                      <span>{text(cycle.status, 'open')}</span>
                    </div>
                    <div className="step-track">
                      {Object.entries(steps).map(([name, raw]) => {
                        const detail = isRecord(raw) ? raw.status : raw
                        const status = text(detail, 'pending')
                        return (
                          <span className={`step-chip step-${status}`} key={name}>
                            <i />{name}<small>{status}</small>
                          </span>
                        )
                      })}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : <div className="empty-block">No open cycles for this subject.</div>}
        </section>

        <section className="panel span-two" aria-labelledby="attention-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Operator review</p>
              <h3 id="attention-title">Attention queue</h3>
            </div>
            <span className="panel-count">{attentionItems.length}</span>
          </div>
          {attentionItems.length > 0 ? (
            <div className="attention-grid">
              {attentionItems.slice(0, 12).map((item, index) => (
                <article
                  className={`attention-item severity-${text(item.severity, 'info')}`}
                  key={`${text(item.kind, 'signal')}-${index}`}
                >
                  <span className="attention-mark" />
                  <div>
                    <strong>{text(item.title, text(item.kind, 'Attention item'))}</strong>
                    <p>{text(item.summary, 'No additional detail.')}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : <div className="empty-block success-empty">No attention items. Systems look clear.</div>}
        </section>
      </div>
    </div>
  )
}

interface OpsViewProps {
  snapshot: SubjectSnapshot | undefined
  loading: boolean
  error: string | null
  refreshedAt: string | null
  onRefresh(): Promise<void>
}

export function OpsView({ snapshot, loading, error, refreshedAt, onRefresh }: OpsViewProps) {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>{snapshot?.subject.name ?? 'Subject operations'}</h1>
          <p>Daemon health, cycle progress and operator attention in one control surface.</p>
        </div>
        <div className="header-actions">
          <span className="last-updated">{refreshedAt ? `Updated ${refreshedAt}` : 'Not refreshed'}</span>
          <button
            type="button"
            className="button secondary"
            onClick={() => void onRefresh()}
            disabled={loading}
          >
            <span aria-hidden="true">↻</span>
            {loading ? 'Refreshing…' : 'Refresh state'}
          </button>
        </div>
      </header>
      {error && <p className="global-alert error-alert" role="alert">{error}</p>}
      {!snapshot && !loading && !error && (
        <div className="hero-empty">
          <span>00</span>
          <h2>No subject selected</h2>
          <p>Register a subject to populate the operations console.</p>
        </div>
      )}
      {snapshot && <SubjectOperations snapshot={snapshot} onRefresh={onRefresh} />}
    </>
  )
}
