import { useEffect, useState } from 'react'
import type { DaemonSupervisorView } from '../../../shared/contract'
import { errorMessage, formatTime } from '../utils'

type DaemonDomain = 'all' | 'cycle' | 'channel'

const modeCopy: Record<DaemonSupervisorView['mode'], string> = {
  none: 'No daemon process is currently detected.',
  attached: 'This daemon is running outside the desktop supervisor.',
  managed: 'This process is owned and supervised by JEA Desktop.',
  stale: 'A worker record exists, but its heartbeat is stale.',
  zombie: 'A worker record points to a process that is no longer healthy.',
  stopping: 'The managed process is shutting down.'
}

interface DaemonPanelProps {
  subject: string
  initial: DaemonSupervisorView | undefined
  onChanged?(): void | Promise<void>
}

export function DaemonPanel({ subject, initial, onChanged }: DaemonPanelProps) {
  const [supervisor, setSupervisor] = useState<DaemonSupervisorView | undefined>(initial)
  const [domain, setDomain] = useState<DaemonDomain>('all')
  const [busy, setBusy] = useState<'start' | 'stop' | 'load' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSupervisor(initial)
  }, [initial, subject])

  useEffect(() => {
    if (initial) return
    let active = true
    setBusy('load')
    void window.jea.invoke<DaemonSupervisorView>('daemon.getSupervisor', { subject })
      .then((next) => {
        if (active) setSupervisor(next)
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, 'Unable to inspect the daemon supervisor.'))
      })
      .finally(() => {
        if (active) setBusy(null)
      })
    return () => {
      active = false
    }
  }, [initial, subject])

  const run = async (action: 'start' | 'stop') => {
    setBusy(action)
    setError(null)
    try {
      const next = action === 'start'
        ? await window.jea.invoke<DaemonSupervisorView>('daemon.startManaged', { subject, domain })
        : await window.jea.invoke<DaemonSupervisorView>('daemon.stopManaged', { subject })
      setSupervisor(next)
      await onChanged?.()
    } catch (cause) {
      setError(errorMessage(cause, `Unable to ${action} the daemon.`))
    } finally {
      setBusy(null)
    }
  }

  const mode = supervisor?.mode ?? 'none'
  const canStart = mode === 'none' || mode === 'stale' || mode === 'zombie'
  const canStop = mode === 'managed'

  return (
    <section className="panel daemon-panel" aria-labelledby={`daemon-${subject}`}>
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Process supervisor</p>
          <h3 id={`daemon-${subject}`}>Daemon control</h3>
        </div>
        <span className={`status-pill mode-${mode}`}>
          <span className="status-dot" />
          {busy === 'load' ? 'checking' : mode}
        </span>
      </div>

      <p className="panel-description">{modeCopy[mode]}</p>

      <dl className="detail-grid">
        <div><dt>Process ID</dt><dd>{supervisor?.pid ?? '—'}</dd></div>
        <div><dt>Domain</dt><dd>{supervisor?.domain ?? 'external / unknown'}</dd></div>
        <div><dt>Heartbeat</dt><dd>{formatTime(supervisor?.heartbeat_at)}</dd></div>
        <div><dt>Started</dt><dd>{formatTime(supervisor?.started_at)}</dd></div>
      </dl>

      {supervisor?.detail && <p className="inline-note">{supervisor.detail}</p>}
      {(mode === 'stale' || mode === 'zombie') && (
        <p className="inline-warning">
          Starting a managed daemon will replace this non-live supervisor state.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="daemon-actions">
        <label>
          <span>Start domain</span>
          <select
            value={domain}
            disabled={!canStart || busy !== null}
            onChange={(event) => setDomain(event.target.value as DaemonDomain)}
          >
            <option value="all">All workers</option>
            <option value="cycle">Cycle only</option>
            <option value="channel">Channel only</option>
          </select>
        </label>
        {canStart && (
          <button
            type="button"
            className="button primary"
            disabled={busy !== null}
            onClick={() => void run('start')}
          >
            {busy === 'start' ? 'Starting…' : 'Start managed'}
          </button>
        )}
        {canStop && (
          <button
            type="button"
            className="button danger"
            disabled={busy !== null}
            onClick={() => void run('stop')}
          >
            {busy === 'stop' ? 'Stopping…' : 'Stop managed'}
          </button>
        )}
      </div>
    </section>
  )
}
