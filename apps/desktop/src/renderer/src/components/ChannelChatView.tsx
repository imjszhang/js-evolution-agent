import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  ChannelSnapshot,
  DesktopSessionPage,
  DesktopSessionRecord
} from '../../../shared/contract'
import {
  MAX_CHANNEL_RECORDS,
  mergeRecords,
  resolveDraftAttempt,
  type DraftAttempt
} from '../conversation'
import { errorMessage, formatTime, isRecord, text } from '../utils'

export { MAX_CHANNEL_RECORDS, mergeRecords, resolveDraftAttempt, type DraftAttempt }

export function ChannelChatView({ subject }: { subject: string | null }) {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null)
  const [sessionId, setSessionId] = useState('main')
  const [records, setRecords] = useState<DesktopSessionRecord[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef(sessionId)
  const offsetRef = useRef(0)
  const requestGeneration = useRef(0)
  const pendingAttempt = useRef<DraftAttempt | null>(null)

  useEffect(() => {
    sessionRef.current = sessionId
  }, [sessionId])

  const readSession = useCallback(async (reset = false) => {
    if (!subject || !sessionRef.current) return
    const requestedSession = sessionRef.current
    const generation = requestGeneration.current
    try {
      const page = await window.jea.invoke<DesktopSessionPage>('channel.readSession', {
        subject,
        sessionId: requestedSession,
        ...(reset ? { tail: 100 } : { offset: offsetRef.current, limit: 200 })
      })
      if (
        generation !== requestGeneration.current
        || requestedSession !== sessionRef.current
        || page.subject !== subject
        || page.session_id !== requestedSession
      ) return
      offsetRef.current = reset
        ? page.next_offset
        : Math.max(offsetRef.current, page.next_offset)
      setRecords((current) => reset ? page.records : mergeRecords(current, page.records))
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to read the desktop session.'))
    }
  }, [subject])

  const load = useCallback(async () => {
    if (!subject) {
      setSnapshot(null)
      return
    }
    const generation = ++requestGeneration.current
    setError(null)
    try {
      const next = await window.jea.invoke<ChannelSnapshot>('channel.get', { subject })
      if (generation !== requestGeneration.current || next.subject !== subject) return
      setSnapshot(next)
      const config = isRecord(next.projection.desktop)
        && isRecord(next.projection.desktop.config)
        ? next.projection.desktop.config
        : {}
      const preferred = next.sessions.some((item) => item.session_id === sessionRef.current)
        ? sessionRef.current
        : text(config.default_session, next.sessions[0]?.session_id ?? 'main')
      sessionRef.current = preferred
      setSessionId(preferred)
      offsetRef.current = 0
      await readSession(true)
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to read Channel state.'))
    }
  }, [readSession, subject])

  useEffect(() => {
    setRecords([])
    offsetRef.current = 0
    void load()
  }, [load])

  useEffect(() => window.jea.subscribe((event) => {
    if (event.subject && event.subject !== subject) return
    if (event.type === 'projection.refresh_failed') {
      setError('Channel projection is stale.')
      return
    }
    if (event.type === 'projection.channel_updated') {
      void load()
    }
  }), [load, subject])

  const selectSession = (next: string) => {
    requestGeneration.current += 1
    setSessionId(next)
    sessionRef.current = next
    offsetRef.current = 0
    setRecords([])
    void readSession(true)
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const content = message.trim()
    if (!subject || !content || busy) return
    setBusy(true)
    setError(null)
    const attempt = resolveDraftAttempt(pendingAttempt.current, {
      subject,
      sessionId,
      content
    })
    pendingAttempt.current = attempt
    try {
      await window.jea.invoke('channel.sendMessage', {
        subject,
        sessionId,
        text: content,
        messageId: attempt.id
      })
      pendingAttempt.current = null
      setMessage('')
      await readSession(false)
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to send the desktop message.'))
    } finally {
      setBusy(false)
    }
  }

  const projection = snapshot?.projection ?? {}
  const desktop = isRecord(projection.desktop) ? projection.desktop : {}
  const config = isRecord(desktop.config) ? desktop.config : {}
  const worker = isRecord(projection.worker) ? projection.worker : {}
  const tasks = isRecord(projection.tasks) && isRecord(projection.tasks.counts)
    ? projection.tasks.counts
    : {}
  const presence = isRecord(projection.presence) ? projection.presence : {}
  const pendingSpeech = Array.isArray(presence.pending_speech_generation)
    ? presence.pending_speech_generation.length
    : 0
  const inbound = useMemo(() => snapshot?.inbound.processed ?? [], [snapshot])

  if (!subject) {
    return <div className="hero-empty"><span>CH</span><h2>Select a subject</h2></div>
  }

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Channel</p>
          <h1>Desktop conversation</h1>
          <p>Messages use the same classifier, presence, speech and notify pipeline as Feishu.</p>
        </div>
        <div className="header-actions">
          <span className="subject-context"><i />{subject}</span>
          <span className={`status-pill ${worker.running ? 'mode-managed' : 'mode-none'}`}>
            {worker.running ? 'channel running' : 'channel idle'}
          </span>
          <button type="button" className="button secondary" onClick={() => void load()}>
            ↻ Refresh
          </button>
        </div>
      </header>

      {error && <p className="global-alert error-alert" role="alert">{error}</p>}
      {!config.enabled && (
        <p className="global-alert" role="status">
          Desktop Channel is disabled for this subject. Enable <code>channels.desktop</code> before sending.
        </p>
      )}
      <section className="todo-summary channel-progress" aria-label="Channel pipeline status">
        <div><strong>{text(tasks.pending, '0')}</strong><span>Pending tasks</span></div>
        <div><strong>{text(tasks.running, '0')}</strong><span>Running tasks</span></div>
        <div><strong>{pendingSpeech}</strong><span>Speech generation</span></div>
        <div><strong>{snapshot?.inbound.pending.length ?? 0}</strong><span>Unclassified inbound</span></div>
      </section>

      <div className="channel-layout">
        <aside className="panel channel-sessions">
          <div className="panel-heading">
            <div><p className="section-kicker">Local transport</p><h3>Sessions</h3></div>
            <span className="panel-count">{snapshot?.sessions.length ?? 0}</span>
          </div>
          {[...(snapshot?.sessions ?? []), ...(
            snapshot?.sessions.some((item) => item.session_id === sessionId)
              ? []
              : [{ session_id: sessionId, target: `desktop:${sessionId}`, message_count: 0, last_message_at: null }]
          )].map((session) => (
            <button
              type="button"
              key={session.session_id}
              className={session.session_id === sessionId ? 'channel-session active' : 'channel-session'}
              onClick={() => selectSession(session.session_id)}
            >
              <strong>{session.session_id}</strong>
              <span>{session.message_count} messages</span>
            </button>
          ))}
        </aside>

        <section className="panel channel-chat">
          <div className="channel-messages" aria-live="polite">
            {records.map((record) => (
              <article className={`chat-message ${record.role === 'user' ? 'user' : 'assistant'}`} key={record.id}>
                <div><strong>{record.role === 'user' ? 'You' : 'JEA'}</strong><time>{formatTime(record.created_at)}</time></div>
                <p>{record.content}</p>
              </article>
            ))}
            {records.length === 0 && <div className="empty-block">No messages in this session.</div>}
          </div>
          <form className="channel-compose" onSubmit={(event) => void send(event)}>
            <textarea
              rows={3}
              value={message}
              disabled={!config.enabled || busy}
              placeholder="Send a message through the complete Channel pipeline…"
              onChange={(event) => setMessage(event.target.value)}
            />
            <button
              className="button primary"
              type="submit"
              disabled={!config.enabled || busy || !message.trim()}
            >
              {busy ? 'Queueing…' : 'Send'}
            </button>
          </form>
        </section>

        <aside className="panel inbound-feed">
          <div className="panel-heading">
            <div><p className="section-kicker">All transports</p><h3>Inbound feed</h3></div>
          </div>
          {inbound.map((entry, index) => {
            const understanding = isRecord(entry.understanding) ? entry.understanding : {}
            return (
              <article className="inbound-item" key={text(entry.message_id, text(entry.file, String(index)))}>
                <div>
                  <strong>{text(entry.chat_id, 'unknown chat')}</strong>
                  <span>{text(entry.classification, 'pending')}</span>
                </div>
                <p>{text(entry.text, '(no text)')}</p>
                <div className="understanding-tags">
                  {understanding.user_intent != null && <span>{text(understanding.user_intent)}</span>}
                  {understanding.temporal != null && <span>{text(understanding.temporal)}</span>}
                  {understanding.complexity != null && <span>{text(understanding.complexity)}</span>}
                </div>
              </article>
            )
          })}
          {inbound.length === 0 && <div className="empty-block">No processed inbound messages.</div>}
        </aside>
      </div>
    </>
  )
}
