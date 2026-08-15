import { useEffect, useState } from 'react'
import type { SubjectSummary } from '../../../shared/contract'

export type AppPage = 'ops' | 'todo' | 'channel' | 'acp'

const pages: Array<{ id: AppPage; label: string; short: string; detail: string }> = [
  { id: 'ops', label: 'Operations', short: 'OP', detail: 'Health & daemons' },
  { id: 'todo', label: 'Todo Center', short: 'TD', detail: 'Operator inputs' },
  { id: 'channel', label: 'Channel', short: 'CH', detail: 'Local & Feishu messages' },
  { id: 'acp', label: 'ACP Workspace', short: 'AC', detail: 'Agent sessions' }
]

interface NavigationProps {
  page: AppPage
  subjects: SubjectSummary[]
  subject: string | null
  onPageChange(page: AppPage): void
  onSubjectChange(subject: string): void
}

export function Navigation({
  page,
  subjects,
  subject,
  onPageChange,
  onSubjectChange
}: NavigationProps) {
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  useEffect(() => {
    void window.jea.invoke<{ enabled: boolean }>('notifications.get')
      .then((settings) => setNotificationsEnabled(settings.enabled))
      .catch(() => undefined)
  }, [])

  return (
    <aside className="app-sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">J</span>
        <div>
          <strong>JEA Control</strong>
          <span>Evolution console</span>
        </div>
      </div>

      <nav className="primary-nav" aria-label="Primary navigation">
        {pages.map((item) => (
          <button
            key={item.id}
            type="button"
            className={page === item.id ? 'nav-item active' : 'nav-item'}
            aria-current={page === item.id ? 'page' : undefined}
            onClick={() => onPageChange(item.id)}
          >
            <span className="nav-icon" aria-hidden="true">{item.short}</span>
            <span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
          </button>
        ))}
      </nav>

      <section className="subject-nav" aria-labelledby="subjects-label">
        <div className="sidebar-label" id="subjects-label">
          <span>Subjects</span>
          <span className="count">{subjects.length}</span>
        </div>
        <label className="mobile-subject-picker">
          <span>Active subject</span>
          <select
            value={subject ?? ''}
            disabled={subjects.length === 0}
            onChange={(event) => onSubjectChange(event.target.value)}
          >
            {subjects.map((item) => (
              <option value={item.name} key={item.name}>{item.name}</option>
            ))}
          </select>
        </label>
        <div className="subject-list">
          {subjects.map((item) => (
            <button
              type="button"
              key={item.name}
              className={subject === item.name ? 'subject-item active' : 'subject-item'}
              aria-pressed={subject === item.name}
              onClick={() => onSubjectChange(item.name)}
            >
              <span className="subject-dot" aria-hidden="true" />
              <span className="subject-copy">
                <strong>{item.name}</strong>
                <small>{item.namespace}</small>
              </span>
              {item.isDefault && <span className="mini-badge">default</span>}
            </button>
          ))}
          {subjects.length === 0 && <p className="sidebar-empty">No registered subjects</p>}
        </div>
      </section>

      <div className="sidebar-foot">
        <label className="notification-toggle">
          <input
            type="checkbox"
            checked={notificationsEnabled}
            onChange={(event) => {
              const enabled = event.target.checked
              setNotificationsEnabled(enabled)
              void window.jea.invoke('notifications.set', { enabled }).catch(() => {
                setNotificationsEnabled(!enabled)
              })
            }}
          />
          System alerts
        </label>
        <span><span className="connection-dot" /> Context isolated</span>
      </div>
    </aside>
  )
}
