import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { TodoSnapshot } from '../../../shared/contract'
import { errorMessage, formatTime, isRecord, text, truncate } from '../utils'

type BusyAction =
  | 'load'
  | 'brief'
  | 'fact'
  | 'cycle'
  | 'goals'
  | `question:${string}`

interface Notice {
  kind: 'success' | 'error'
  message: string
}

function recordTitle(record: Record<string, unknown>): string {
  return text(record.summary, text(record.content, text(record.id, 'Untitled record')))
}

export function TodoCenter({ subject }: { subject: string | null }) {
  const [snapshot, setSnapshot] = useState<TodoSnapshot | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [questionNotes, setQuestionNotes] = useState<Record<string, string>>({})
  const [briefSummary, setBriefSummary] = useState('')
  const [briefEffect, setBriefEffect] = useState('')
  const [briefPriority, setBriefPriority] = useState('medium')
  const [briefActions, setBriefActions] = useState('')
  const [factContent, setFactContent] = useState('')
  const [cycleNote, setCycleNote] = useState('')
  const [goalsEditor, setGoalsEditor] = useState('{}')
  const [goalsReason, setGoalsReason] = useState('')
  const [goalsConfirmed, setGoalsConfirmed] = useState(false)
  const loadSequence = useRef(0)

  const load = useCallback(async (showSpinner = true) => {
    const sequence = ++loadSequence.current
    if (!subject) {
      setSnapshot(null)
      return
    }
    if (showSpinner) setBusy('load')
    try {
      const next = await window.jea.invoke<TodoSnapshot>('todo.get', { subject })
      if (sequence !== loadSequence.current) return
      setSnapshot(next)
      setGoalsEditor(JSON.stringify(next.goals ?? {}, null, 2))
    } catch (cause) {
      if (sequence !== loadSequence.current) return
      setNotice({ kind: 'error', message: errorMessage(cause, 'Unable to load operator todos.') })
    } finally {
      if (showSpinner && sequence === loadSequence.current) setBusy(null)
    }
  }, [subject])

  useEffect(() => {
    setNotice(null)
    setQuestionNotes({})
    void load()
    return () => {
      loadSequence.current += 1
    }
  }, [load])

  const mutate = async (
    action: BusyAction,
    command: Parameters<typeof window.jea.invoke>[0],
    payload: Record<string, unknown>,
    success: string
  ): Promise<boolean> => {
    setBusy(action)
    setNotice(null)
    try {
      await window.jea.invoke(command, payload)
      setNotice({ kind: 'success', message: success })
      await load(false)
      return true
    } catch (cause) {
      setNotice({ kind: 'error', message: errorMessage(cause, 'The operator action failed.') })
      return false
    } finally {
      setBusy(null)
    }
  }

  const submitBrief = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject) return
    const suggestedActions = briefActions.split(',').map((item) => item.trim()).filter(Boolean)
    const ok = await mutate('brief', 'todo.putBrief', {
      subject,
      brief: {
        summary: briefSummary,
        desired_decision_effect: briefEffect,
        priority: briefPriority,
        suggested_actions: suggestedActions
      }
    }, 'Brief queued for the next cognitive cycle.')
    if (ok) {
      setBriefSummary('')
      setBriefEffect('')
      setBriefActions('')
    }
  }

  const submitFact = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject) return
    const ok = await mutate('fact', 'todo.putFact', {
      subject,
      fact: { content: factContent, confidence: 'high', subject }
    }, 'Authoritative fact seed recorded for one-cycle digestion.')
    if (ok) setFactContent('')
  }

  const requestCycle = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject) return
    const ok = await mutate('cycle', 'todo.requestCycle', {
      subject,
      ...(cycleNote.trim() ? { note: cycleNote.trim() } : {})
    }, 'A cycle start request and cognitive wake were queued.')
    if (ok) setCycleNote('')
  }

  const resolveQuestion = async (questionId: string) => {
    if (!subject) return
    const note = questionNotes[questionId]?.trim()
    const ok = await mutate(`question:${questionId}`, 'todo.resolveQuestion', {
      subject,
      questionId,
      ...(note ? { note } : {})
    }, 'Question acknowledged and removed from the pending queue.')
    if (ok) {
      setQuestionNotes((current) => {
        const next = { ...current }
        delete next[questionId]
        return next
      })
    }
  }

  const updateGoals = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject) return
    let goals: unknown
    try {
      goals = JSON.parse(goalsEditor)
    } catch {
      setNotice({ kind: 'error', message: 'Goals must be valid JSON.' })
      return
    }
    if (!isRecord(goals)) {
      setNotice({ kind: 'error', message: 'Goals must be a JSON object.' })
      return
    }
    if (!goalsConfirmed) {
      setNotice({ kind: 'error', message: 'Confirm the full goal-tree replacement before saving.' })
      return
    }
    const ok = await mutate('goals', 'todo.updateGoals', {
      subject,
      goals,
      reason: goalsReason
    }, 'The active goal tree was replaced and audited.')
    if (ok) {
      setGoalsReason('')
      setGoalsConfirmed(false)
    }
  }

  if (!subject) {
    return (
      <>
        <header className="page-header">
          <div><p className="eyebrow">Todo Center</p><h1>Operator inbox</h1></div>
        </header>
        <div className="hero-empty"><span>TD</span><h2>Select a subject</h2><p>Todo data is isolated by subject.</p></div>
      </>
    )
  }

  const questions = snapshot?.questions ?? []
  const pending = snapshot?.pending_cycle_request
  const attention = isRecord(snapshot?.attention) ? snapshot.attention : {}
  const attentionSummary = isRecord(attention.summary) ? attention.summary : {}

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Todo Center</p>
          <h1>Operator inbox</h1>
          <p>Resolve questions, seed intent and facts, or deliberately redirect evolution.</p>
        </div>
        <div className="header-actions">
          <span className="subject-context"><i />{subject}</span>
          <button
            type="button"
            className="button secondary"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {notice && (
        <p className={`global-alert ${notice.kind === 'error' ? 'error-alert' : 'success-alert'}`} role="status">
          {notice.message}
        </p>
      )}

      <section className="todo-summary" aria-label="Todo summary">
        <div><strong>{questions.length}</strong><span>Open questions</span></div>
        <div><strong>{snapshot?.briefs.length ?? 0}</strong><span>Pending briefs</span></div>
        <div><strong>{snapshot?.facts.length ?? 0}</strong><span>Fact seeds</span></div>
        <div><strong>{text(attentionSummary.active_count, '0')}</strong><span>Attention signals</span></div>
        <div className={pending ? 'request-active' : ''}>
          <strong>{pending ? 'Queued' : 'Idle'}</strong><span>Cycle request</span>
        </div>
      </section>

      <div className="todo-layout">
        <div className="todo-main">
          <section className="panel questions-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">Needs operator input</p>
                <h3>Open questions</h3>
              </div>
              <span className="panel-count">{questions.length}</span>
            </div>
            <p className="panel-description">
              Answer through a fact or brief when needed, then acknowledge the question here.
            </p>
            {questions.length > 0 ? (
              <div className="question-list">
                {questions.map((question, index) => {
                  const id = text(question.id, `question-${index}`)
                  const resolving = busy === `question:${id}`
                  return (
                    <article className="question-card" key={id}>
                      <div className="question-meta">
                        <span>{text(question.trigger, 'operator question')}</span>
                        <time>{formatTime(question.created_at)}</time>
                      </div>
                      <h4>{text(question.question, text(question.summary, 'Question'))}</h4>
                      {question.reason != null && <p>{text(question.reason)}</p>}
                      <label>
                        <span>Resolution note <small>optional</small></span>
                        <textarea
                          rows={2}
                          value={questionNotes[id] ?? ''}
                          placeholder="Record how this was handled…"
                          onChange={(event) => setQuestionNotes((current) => ({
                            ...current,
                            [id]: event.target.value
                          }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy !== null}
                        onClick={() => void resolveQuestion(id)}
                      >
                        {resolving ? 'Resolving…' : 'Acknowledge & resolve'}
                      </button>
                    </article>
                  )
                })}
              </div>
            ) : <div className="empty-block success-empty">No open operator questions.</div>}
          </section>

          <section className="panel goals-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">High-impact change</p>
                <h3>Active goals JSON</h3>
              </div>
              <span className="risk-badge">full replace</span>
            </div>
            <p className="panel-description">
              Saving replaces the complete active goal tree and writes an audited goal event.
            </p>
            <form className="form-stack" onSubmit={(event) => void updateGoals(event)}>
              <label>
                <span>Goal tree</span>
                <textarea
                  className="code-editor"
                  rows={16}
                  value={goalsEditor}
                  spellCheck={false}
                  onChange={(event) => {
                    setGoalsEditor(event.target.value)
                    setGoalsConfirmed(false)
                  }}
                />
              </label>
              <label>
                <span>Reason for change</span>
                <input
                  required
                  value={goalsReason}
                  placeholder="Why is this replacement necessary?"
                  onChange={(event) => setGoalsReason(event.target.value)}
                />
              </label>
              <label className="confirm-row">
                <input
                  type="checkbox"
                  checked={goalsConfirmed}
                  onChange={(event) => setGoalsConfirmed(event.target.checked)}
                />
                <span>I reviewed the JSON and confirm replacing the full active goal tree.</span>
              </label>
              <button
                className="button danger"
                type="submit"
                disabled={busy !== null || !goalsReason.trim() || !goalsConfirmed}
              >
                {busy === 'goals' ? 'Updating goals…' : 'Replace active goals'}
              </button>
            </form>
          </section>
        </div>

        <aside className="todo-compose">
          <section className="panel compose-card">
            <div className="panel-heading">
              <div><p className="section-kicker">Next-cycle intent</p><h3>New brief</h3></div>
            </div>
            <form className="form-stack" onSubmit={(event) => void submitBrief(event)}>
              <label>
                <span>Summary</span>
                <textarea
                  required
                  rows={3}
                  value={briefSummary}
                  placeholder="What should the next cycle focus on?"
                  onChange={(event) => setBriefSummary(event.target.value)}
                />
              </label>
              <label>
                <span>Desired decision effect</span>
                <textarea
                  rows={3}
                  value={briefEffect}
                  placeholder="How should this change the next decision?"
                  onChange={(event) => setBriefEffect(event.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  <span>Priority</span>
                  <select value={briefPriority} onChange={(event) => setBriefPriority(event.target.value)}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  <span>Suggested actions</span>
                  <input
                    value={briefActions}
                    placeholder="agent_run, probe"
                    onChange={(event) => setBriefActions(event.target.value)}
                  />
                </label>
              </div>
              <button className="button primary" type="submit" disabled={busy !== null || !briefSummary.trim()}>
                {busy === 'brief' ? 'Submitting…' : 'Submit intent brief'}
              </button>
            </form>
          </section>

          <section className="panel compose-card">
            <div className="panel-heading">
              <div><p className="section-kicker">One-cycle authority</p><h3>New fact seed</h3></div>
            </div>
            <p className="panel-description">Facts enter as high-confidence seeds, then evidence can confirm or refute them.</p>
            <form className="form-stack" onSubmit={(event) => void submitFact(event)}>
              <label>
                <span>Established fact</span>
                <textarea
                  required
                  rows={4}
                  value={factContent}
                  placeholder="State a confirmed domain fact…"
                  onChange={(event) => setFactContent(event.target.value)}
                />
              </label>
              <button className="button primary" type="submit" disabled={busy !== null || !factContent.trim()}>
                {busy === 'fact' ? 'Recording…' : 'Record fact seed'}
              </button>
            </form>
          </section>

          <section className="panel compose-card cycle-request-card">
            <div className="panel-heading">
              <div><p className="section-kicker">Dispatch</p><h3>Request cycle</h3></div>
              {pending && <span className="status-pill mode-managed">queued</span>}
            </div>
            {pending && (
              <div className="pending-request">
                <strong>{text(pending.reason, 'Cycle requested')}</strong>
                <span>{text(pending.status, 'pending')}</span>
              </div>
            )}
            <form className="form-stack" onSubmit={(event) => void requestCycle(event)}>
              <label>
                <span>Operator note <small>optional</small></span>
                <textarea
                  rows={2}
                  value={cycleNote}
                  placeholder="Context for the wake request…"
                  onChange={(event) => setCycleNote(event.target.value)}
                />
              </label>
              <button className="button secondary" type="submit" disabled={busy !== null}>
                {busy === 'cycle' ? 'Queueing…' : 'Request cycle & wake'}
              </button>
            </form>
          </section>

          {(snapshot?.briefs.length || snapshot?.facts.length) ? (
            <section className="panel queued-inputs">
              <div className="panel-heading">
                <div><p className="section-kicker">Pending ingestion</p><h3>Recent inputs</h3></div>
              </div>
              {[...(snapshot?.briefs ?? []), ...(snapshot?.facts ?? [])].slice(0, 6).map((record, index) => (
                <div className="queued-record" key={text(record.id, String(index))}>
                  <strong>{truncate(recordTitle(record), 90)}</strong>
                  <span>{formatTime(record.created_at)}</span>
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
    </>
  )
}
