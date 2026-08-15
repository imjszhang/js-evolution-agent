import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react'
import type {
  AcpFrameworkView,
  AcpPermissionView,
  AcpSessionStatus,
  AcpSessionView,
  JeaEventEnvelope
} from '../../../shared/contract'
import { errorMessage, formatTime, isRecord, pretty, text, truncate, type UnknownRecord } from '../utils'
import {
  PermissionCard,
  type PermissionOption,
  type PermissionRequest
} from './PermissionCard'

interface TimelineEntry {
  id: number
  type: string
  ts: string
  payload: UnknownRecord
}

const sessionStatuses: AcpSessionStatus[] = [
  'starting',
  'ready',
  'prompting',
  'awaiting_permission',
  'cancelling',
  'closing',
  'closed',
  'error'
]

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function sessionFromPayload(value: unknown): AcpSessionView | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.framework !== 'string') return null
  if (typeof value.execution_root !== 'string' || typeof value.status !== 'string') return null
  if (!sessionStatuses.includes(value.status as AcpSessionStatus)) return null
  return {
    id: value.id,
    acp_session_id: typeof value.acp_session_id === 'string' ? value.acp_session_id : null,
    framework: value.framework,
    execution_root: value.execution_root,
    status: value.status as AcpSessionStatus,
    pid: typeof value.pid === 'number' ? value.pid : null,
    created_at: typeof value.created_at === 'string' ? value.created_at : '',
    config_options: records(value.config_options),
    error: typeof value.error === 'string' ? value.error : null
  }
}

function permissionFromPayload(payload: UnknownRecord): PermissionRequest | null {
  if (typeof payload.request_id !== 'string') return null
  const advisory = isRecord(payload.advisory) ? payload.advisory : {}
  const options: PermissionOption[] = records(payload.options)
    .filter((option) => typeof option.optionId === 'string')
    .map((option) => ({
      optionId: String(option.optionId),
      kind: text(option.kind, 'unknown'),
      ...(typeof option.name === 'string' ? { name: option.name } : {})
    }))
  return {
    requestId: payload.request_id,
    title: text(payload.title, 'Tool permission'),
    toolKind: text(payload.tool_kind, 'unknown'),
    inputSummary: text(payload.input_summary, ''),
    paths: Array.isArray(payload.paths)
      ? payload.paths.filter((path): path is string => typeof path === 'string')
      : [],
    options,
    reason: typeof payload.reason === 'string'
      ? payload.reason
      : typeof advisory.reason === 'string'
        ? advisory.reason
        : null
  }
}

function upsertSession(sessions: AcpSessionView[], next: AcpSessionView): AcpSessionView[] {
  const index = sessions.findIndex((session) => session.id === next.id)
  if (index < 0) return [next, ...sessions]
  return sessions.map((session) => session.id === next.id ? next : session)
}

function configValue(option: UnknownRecord): string | boolean {
  const value = option.currentValue ?? option.current_value ?? option.value
  return typeof value === 'boolean' ? value : text(value, '')
}

function optionChoices(option: UnknownRecord): Array<{ value: string; label: string }> {
  if (!Array.isArray(option.options)) return []
  return option.options.flatMap((choice) => {
    if (typeof choice === 'string') return [{ value: choice, label: choice }]
    if (!isRecord(choice)) return []
    const value = text(choice.value, text(choice.id, ''))
    return value ? [{ value, label: text(choice.name, text(choice.label, value)) }] : []
  })
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const type = entry.type.replace(/^acp_/, '')
  const payload = entry.payload

  if (entry.type === 'acp_assistant_chunk') {
    return (
      <article className="timeline-entry assistant-entry">
        <div className="timeline-rail"><span>AI</span></div>
        <div className="timeline-content">
          <div className="timeline-title"><strong>Assistant</strong><time>{formatTime(entry.ts)}</time></div>
          <p className="assistant-text">{text(payload.text, '')}</p>
        </div>
      </article>
    )
  }

  const toolEvent = entry.type === 'acp_tool_started' || entry.type === 'acp_tool_finished'
  const thinking = entry.type === 'acp_thinking_segment'
  const plan = entry.type === 'acp_plan_update'
  const permission = entry.type.includes('permission_')
  const title = toolEvent
    ? `${entry.type.endsWith('started') ? 'Tool started' : 'Tool finished'} · ${text(payload.name, 'tool')}`
    : thinking
      ? 'Thinking'
      : plan
        ? 'Plan updated'
        : permission
          ? `Permission ${entry.type.endsWith('requested') ? 'requested' : 'resolved'}`
          : type.split('_').join(' ')
  const detail = thinking
    ? text(payload.text, '')
    : entry.type === 'acp_tool_started'
      ? text(payload.input_summary, '')
      : entry.type === 'acp_tool_finished'
        ? text(payload.result_summary, '')
        : plan
          ? `${text(payload.entries, '0')} plan entries`
          : entry.type === 'acp_turn_finished'
            ? `Completed in ${text(payload.duration_ms, '—')} ms · ${text(payload.stop_reason, 'unknown stop reason')}`
            : entry.type === 'acp_turn_start'
              ? `Prompt accepted · ${text(payload.prompt_chars, '0')} characters`
              : permission
                ? text(payload.reason, text(payload.title, 'Permission state changed'))
                : text(payload.text, '')

  return (
    <article className={`timeline-entry ${toolEvent ? 'tool-entry' : ''} ${thinking ? 'thinking-entry' : ''}`}>
      <div className="timeline-rail"><span>{toolEvent ? 'TL' : plan ? 'PL' : permission ? 'PM' : '•'}</span></div>
      <div className="timeline-content">
        <div className="timeline-title">
          <strong>{title}</strong>
          <time>{formatTime(entry.ts)}</time>
        </div>
        {detail && <p>{detail}</p>}
        {entry.type === 'acp_tool_finished' && (
          <div className="timeline-tags">
            <span>{text(payload.status, 'finished')}</span>
            {payload.duration_ms != null && <span>{text(payload.duration_ms)} ms</span>}
          </div>
        )}
      </div>
    </article>
  )
}

export function AcpWorkspace() {
  const [frameworks, setFrameworks] = useState<AcpFrameworkView[]>([])
  const [sessions, setSessions] = useState<AcpSessionView[]>([])
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [executionRoot, setExecutionRoot] = useState('')
  const [permissionProfile, setPermissionProfile] = useState('workspace_write')
  const [prompt, setPrompt] = useState('')
  const [timeline, setTimeline] = useState<Record<string, TimelineEntry[]>>({})
  const [permissions, setPermissions] = useState<Record<string, PermissionRequest[]>>({})
  const [busy, setBusy] = useState<string | null>('load')
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null)
  const eventSequence = useRef(0)
  const permissionRevision = useRef(0)
  const timelineEnd = useRef<HTMLDivElement | null>(null)

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? null
  const selectedTimeline = selectedSessionId ? timeline[selectedSessionId] ?? [] : []
  const selectedPermissions = selectedSessionId ? permissions[selectedSessionId] ?? [] : []

  const appendTimeline = useCallback((sessionId: string, event: JeaEventEnvelope) => {
    setTimeline((current) => {
      const previous = current[sessionId] ?? []
      const last = previous.at(-1)
      if (event.type === 'acp_assistant_chunk' && last?.type === event.type) {
        const merged: TimelineEntry = {
          ...last,
          ts: event.ts,
          payload: {
            ...last.payload,
            text: `${text(last.payload.text, '')}${text(event.payload.text, '')}`
          }
        }
        return { ...current, [sessionId]: [...previous.slice(0, -1), merged] }
      }
      eventSequence.current += 1
      const next: TimelineEntry = {
        id: eventSequence.current,
        type: event.type,
        ts: event.ts,
        payload: event.payload
      }
      return { ...current, [sessionId]: [...previous, next].slice(-400) }
    })
  }, [])

  const loadWorkspace = useCallback(async () => {
    setBusy('load')
    setNotice(null)
    try {
      const [nextFrameworks, nextSessions] = await Promise.all([
        window.jea.invoke<AcpFrameworkView[]>('acp.listFrameworks'),
        window.jea.invoke<AcpSessionView[]>('acp.listSessions')
      ])
      let nextPermissionViews: AcpPermissionView[] = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const revision = permissionRevision.current
        nextPermissionViews = await window.jea.invoke<AcpPermissionView[]>('acp.listPermissions')
        if (revision === permissionRevision.current) break
      }
      const nextPermissions: Record<string, PermissionRequest[]> = {}
      for (const view of nextPermissionViews) {
        const request = permissionFromPayload(view as unknown as UnknownRecord)
        if (!request) continue
        nextPermissions[view.session_id] = [
          ...(nextPermissions[view.session_id] ?? []),
          request
        ]
      }
      setFrameworks(nextFrameworks)
      setSessions(nextSessions)
      setPermissions(nextPermissions)
      setSelectedProvider((current) => {
        if (nextFrameworks.some((item) => item.provider === current)) return current
        return nextFrameworks.find((item) => item.available)?.provider
          ?? nextFrameworks[0]?.provider
          ?? ''
      })
      setSelectedSessionId((current) =>
        nextSessions.some((session) => session.id === current)
          ? current
          : nextSessions[0]?.id ?? null)
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'Unable to load ACP frameworks.') })
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void loadWorkspace()
    return window.jea.subscribe((event) => {
      if (!event.type.startsWith('acp_') || !event.session_id) return
      const sessionId = event.session_id
      if (event.type === 'acp_session_status') {
        const next = sessionFromPayload(event.payload)
        if (next) {
          setSessions((current) => upsertSession(current, next))
          setSelectedSessionId((current) => current ?? next.id)
        }
      } else {
        appendTimeline(sessionId, event)
      }
      if (event.type === 'acp_permission_requested') {
        permissionRevision.current += 1
        const request = permissionFromPayload(event.payload)
        if (request) {
          setPermissions((current) => ({
            ...current,
            [sessionId]: [
              ...(current[sessionId] ?? []).filter((item) => item.requestId !== request.requestId),
              request
            ]
          }))
        }
      }
      if (event.type === 'acp_permission_resolved') {
        permissionRevision.current += 1
        const requestId = typeof event.payload.request_id === 'string'
          ? event.payload.request_id
          : null
        setPermissions((current) => ({
          ...current,
          [sessionId]: requestId
            ? (current[sessionId] ?? []).filter((item) => item.requestId !== requestId)
            : []
        }))
      }
    })
  }, [appendTimeline, loadWorkspace])

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedSessionId, selectedTimeline.length])

  const chooseRoot = async () => {
    setBusy('choose-root')
    setNotice(null)
    try {
      const result = await window.jea.invoke<{ path: string | null }>('acp.chooseExecutionRoot')
      if (result.path) setExecutionRoot(result.path)
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'Directory selection failed.') })
    } finally {
      setBusy(null)
    }
  }

  const startSession = async (event: FormEvent) => {
    event.preventDefault()
    setBusy('start')
    setNotice(null)
    try {
      const next = await window.jea.invoke<AcpSessionView>('acp.startSession', {
        provider: selectedProvider,
        executionRoot,
        permissionProfile,
        additionalDirectories: []
      })
      setSessions((current) => upsertSession(current, next))
      setSelectedSessionId(next.id)
      setNotice({ kind: 'success', message: 'ACP session is ready.' })
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'Unable to start the ACP session.') })
    } finally {
      setBusy(null)
    }
  }

  const sendPrompt = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedSession || !prompt.trim()) return
    const submittedPrompt = prompt.trim()
    setPrompt('')
    eventSequence.current += 1
    setTimeline((current) => ({
      ...current,
      [selectedSession.id]: [
        ...(current[selectedSession.id] ?? []),
        {
          id: eventSequence.current,
          type: 'operator_prompt',
          ts: new Date().toISOString(),
          payload: { text: submittedPrompt }
        }
      ]
    }))
    setBusy('prompt')
    setNotice(null)
    try {
      await window.jea.invoke('acp.prompt', {
        sessionId: selectedSession.id,
        text: submittedPrompt
      })
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'ACP prompt failed.') })
    } finally {
      setBusy(null)
    }
  }

  const controlSession = async (action: 'cancel' | 'close') => {
    if (!selectedSession) return
    setBusy(action)
    setNotice(null)
    try {
      if (action === 'cancel') {
        const next = await window.jea.invoke<AcpSessionView>('acp.cancelSession', {
          sessionId: selectedSession.id
        })
        setSessions((current) => upsertSession(current, next))
      } else {
        await window.jea.invoke('acp.closeSession', { sessionId: selectedSession.id })
        const remaining = await window.jea.invoke<AcpSessionView[]>('acp.listSessions')
        setSessions(remaining)
        setSelectedSessionId(remaining[0]?.id ?? null)
      }
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, `Unable to ${action} the session.`) })
    } finally {
      setBusy(null)
    }
  }

  const respondPermission = async (request: PermissionRequest, optionId?: string) => {
    if (!selectedSession) return
    const busyId = `permission:${request.requestId}`
    setBusy(busyId)
    setNotice(null)
    try {
      await window.jea.invoke('acp.respondPermission', {
        sessionId: selectedSession.id,
        requestId: request.requestId,
        ...(optionId ? { optionId } : {})
      })
      setPermissions((current) => ({
        ...current,
        [selectedSession.id]: (current[selectedSession.id] ?? [])
          .filter((item) => item.requestId !== request.requestId)
      }))
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'Permission response failed.') })
    } finally {
      setBusy(null)
    }
  }

  const setConfigOption = async (option: UnknownRecord, value: string | boolean) => {
    if (!selectedSession || typeof option.id !== 'string') return
    setBusy(`config:${option.id}`)
    setNotice(null)
    try {
      const next = await window.jea.invoke<AcpSessionView>('acp.setConfigOption', {
        sessionId: selectedSession.id,
        configId: option.id,
        value
      })
      setSessions((current) => upsertSession(current, next))
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'Unable to update the model option.') })
    } finally {
      setBusy(null)
    }
  }

  const modelOptions = useMemo(() => {
    if (!selectedSession) return []
    return selectedSession.config_options.filter((option) => {
      const category = text(option.category, '').toLowerCase()
      const id = text(option.id, '').toLowerCase()
      return category === 'model' || id.includes('model')
    })
  }, [selectedSession])

  const selectedFramework = frameworks.find((item) => item.provider === selectedProvider)
  const canPrompt = selectedSession?.status === 'ready' && busy === null
  const canCancel = selectedSession != null
    && ['prompting', 'awaiting_permission'].includes(selectedSession.status)
  const canClose = selectedSession != null
    && !['closing', 'closed'].includes(selectedSession.status)

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Agent Client Protocol</p>
          <h1>ACP Workspace</h1>
          <p>Launch isolated agent sessions and supervise their live execution timeline.</p>
        </div>
        <div className="header-actions">
          <span className="session-total">{sessions.length} active {sessions.length === 1 ? 'session' : 'sessions'}</span>
          <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void loadWorkspace()}>
            ↻ Reload frameworks
          </button>
        </div>
      </header>

      {notice && (
        <p className={`global-alert ${notice.kind === 'error' ? 'error-alert' : 'success-alert'}`} role="status">
          {notice.message}
        </p>
      )}

      <div className="acp-layout">
        <aside className="acp-sidebar">
          <section className="panel launch-panel">
            <div className="panel-heading">
              <div><p className="section-kicker">New runtime</p><h3>Launch session</h3></div>
            </div>
            <form className="form-stack" onSubmit={(event) => void startSession(event)}>
              <label>
                <span>Framework</span>
                <select
                  required
                  value={selectedProvider}
                  disabled={busy !== null || frameworks.length === 0}
                  onChange={(event) => setSelectedProvider(event.target.value)}
                >
                  {frameworks.length === 0 && <option value="">No frameworks found</option>}
                  {frameworks.map((framework) => (
                    <option
                      key={framework.provider}
                      value={framework.provider}
                      disabled={!framework.available}
                    >
                      {framework.id} {framework.available ? '' : '— unavailable'}
                    </option>
                  ))}
                </select>
              </label>
              {selectedFramework && (
                <div className="framework-health">
                  <span className={selectedFramework.available ? 'available' : 'unavailable'}>
                    {selectedFramework.available ? 'Available' : 'Unavailable'}
                  </span>
                  <span>v{selectedFramework.version ?? 'unknown'}</span>
                  <span>{selectedFramework.credentials_configured ? 'Credentials ready' : 'Credentials not detected'}</span>
                </div>
              )}
              <label>
                <span>Execution root</span>
                <div className="directory-field">
                  <input
                    required
                    readOnly
                    value={executionRoot}
                    placeholder="Choose a local project directory"
                  />
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy !== null}
                    onClick={() => void chooseRoot()}
                  >
                    {busy === 'choose-root' ? 'Opening…' : 'Choose…'}
                  </button>
                </div>
              </label>
              <label>
                <span>Permission profile</span>
                <select value={permissionProfile} onChange={(event) => setPermissionProfile(event.target.value)}>
                  <option value="read_only">Read only</option>
                  <option value="workspace_write">Workspace write</option>
                  <option value="remote_write_review">Remote write review</option>
                </select>
              </label>
              <button
                className="button primary"
                type="submit"
                disabled={busy !== null || !executionRoot || !selectedFramework?.available}
              >
                {busy === 'start' ? 'Starting agent…' : 'Start ACP session'}
              </button>
            </form>
          </section>

          <section className="session-list-panel">
            <div className="sidebar-label">
              <span>Sessions</span><span className="count">{sessions.length}</span>
            </div>
            <div className="session-list">
              {sessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  className={session.id === selectedSessionId ? 'session-item active' : 'session-item'}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <span className={`session-state state-${session.status}`} />
                  <span>
                    <strong>{session.framework.replace(/^acp:/, '')}</strong>
                    <small>{truncate(session.execution_root, 34)}</small>
                  </span>
                  <em>{session.status.replace('_', ' ')}</em>
                </button>
              ))}
              {sessions.length === 0 && <div className="empty-block">No live ACP sessions.</div>}
            </div>
          </section>
        </aside>

        <main className="acp-workspace">
          {selectedSession ? (
            <>
              <section className="session-toolbar">
                <div className="session-heading">
                  <span className={`large-state state-${selectedSession.status}`} />
                  <div>
                    <h2>{selectedSession.framework.replace(/^acp:/, '')}</h2>
                    <p title={selectedSession.execution_root}>{selectedSession.execution_root}</p>
                  </div>
                </div>
                <div className="session-toolbar-meta">
                  <span className={`status-pill state-${selectedSession.status}`}>{selectedSession.status.replace('_', ' ')}</span>
                  <span>PID {selectedSession.pid ?? '—'}</span>
                  {canCancel && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy !== null && busy !== 'prompt'}
                      onClick={() => void controlSession('cancel')}
                    >
                      {busy === 'cancel' ? 'Cancelling…' : 'Cancel turn'}
                    </button>
                  )}
                  {canClose && (
                    <button
                      type="button"
                      className="button ghost danger-text"
                      disabled={busy === 'close'}
                      onClick={() => void controlSession('close')}
                    >
                      {busy === 'close' ? 'Closing…' : 'Close session'}
                    </button>
                  )}
                </div>
              </section>

              {selectedSession.error && <p className="global-alert error-alert">{selectedSession.error}</p>}

              {modelOptions.length > 0 && (
                <section className="model-options" aria-label="Model configuration">
                  <span className="section-kicker">Model configuration</span>
                  {modelOptions.map((option, index) => {
                    const id = text(option.id, `model-${index}`)
                    const choices = optionChoices(option)
                    const value = configValue(option)
                    return (
                      <label key={id}>
                        <span>{text(option.name, id)}</span>
                        {option.type === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={value === true}
                            disabled={busy !== null}
                            onChange={(event) => void setConfigOption(option, event.target.checked)}
                          />
                        ) : choices.length > 0 ? (
                          <select
                            value={String(value)}
                            disabled={busy !== null}
                            onChange={(event) => void setConfigOption(option, event.target.value)}
                          >
                            {choices.map((choice) => (
                              <option key={choice.value} value={choice.value}>{choice.label}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            value={String(value)}
                            disabled={busy !== null}
                            onChange={(event) => void setConfigOption(option, event.target.value)}
                          />
                        )}
                      </label>
                    )
                  })}
                </section>
              )}

              <section className="conversation-panel">
                <div className="timeline" aria-live="polite">
                  {selectedTimeline.length > 0 ? (
                    selectedTimeline.map((entry) => {
                      if (entry.type === 'operator_prompt') {
                        return (
                          <article className="timeline-entry operator-entry" key={entry.id}>
                            <div className="timeline-rail"><span>YOU</span></div>
                            <div className="timeline-content">
                              <div className="timeline-title"><strong>Operator prompt</strong><time>{formatTime(entry.ts)}</time></div>
                              <p>{text(entry.payload.text, '')}</p>
                            </div>
                          </article>
                        )
                      }
                      return <TimelineItem entry={entry} key={entry.id} />
                    })
                  ) : (
                    <div className="timeline-empty">
                      <span>AC</span>
                      <h3>Session ready</h3>
                      <p>Send a prompt to begin. Tool calls, thinking, plans and permission requests appear here live.</p>
                    </div>
                  )}
                  <div ref={timelineEnd} />
                </div>

                {selectedPermissions.length > 0 && (
                  <div className="permission-stack">
                    {selectedPermissions.map((request) => (
                      <PermissionCard
                        key={request.requestId}
                        request={request}
                        busy={busy === `permission:${request.requestId}`}
                        onRespond={(optionId) => respondPermission(request, optionId)}
                      />
                    ))}
                  </div>
                )}

                <form className="prompt-composer" onSubmit={(event) => void sendPrompt(event)}>
                  <textarea
                    rows={3}
                    value={prompt}
                    disabled={selectedSession.status !== 'ready'}
                    placeholder={selectedSession.status === 'ready'
                      ? 'Ask the agent to inspect, reason, or act in this execution root…'
                      : `Session is ${selectedSession.status.replace('_', ' ')}…`}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canPrompt && prompt.trim()) {
                        event.currentTarget.form?.requestSubmit()
                      }
                    }}
                  />
                  <div className="composer-foot">
                    <span>Ctrl/⌘ + Enter to send</span>
                    <button className="button primary" type="submit" disabled={!canPrompt || !prompt.trim()}>
                      {busy === 'prompt' ? 'Agent working…' : 'Send prompt'}
                    </button>
                  </div>
                </form>
              </section>
            </>
          ) : (
            <div className="hero-empty acp-empty">
              <span>AC</span>
              <h2>Launch an ACP session</h2>
              <p>Choose an available framework and a native execution root to get started.</p>
              {frameworks.length > 0 && (
                <details>
                  <summary>Framework diagnostics</summary>
                  <pre>{pretty(frameworks)}</pre>
                </details>
              )}
            </div>
          )}
        </main>
      </div>
    </>
  )
}
