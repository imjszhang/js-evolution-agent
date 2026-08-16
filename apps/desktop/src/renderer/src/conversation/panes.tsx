import { Button, cn, useLocale } from '@jea/app'
import type { ConversationCard } from './cards'
import { conversationText } from './copy'
import type { ConversationWorkspaceModel, ConversationWorkspaceSnapshot } from './model'

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

function cardTone(tone: ConversationCard['tone']): string {
  if (tone === 'error') return 'border-status-error/40 bg-status-error/10 text-status-error-foreground'
  if (tone === 'success') return 'border-status-ok/40 bg-status-ok/10 text-status-ok-foreground'
  if (tone === 'warn') return 'border-status-warn/40 bg-status-warn/10 text-status-warn-foreground'
  return 'border-border bg-surface-sunken text-foreground'
}

export function ConversationCards({ cards }: { cards: ConversationCard[] }) {
  if (cards.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="conversation-cards">
      {cards.map((card) => (
        <article
          key={card.id}
          data-testid={`conversation-card-${card.kind}`}
          className={cn('rounded-md border px-3 py-2 text-sm', cardTone(card.tone))}
        >
          <strong className="block text-xs uppercase tracking-wide">{card.title}</strong>
          <p className="mt-1 whitespace-pre-wrap">{card.body}</p>
        </article>
      ))}
    </div>
  )
}

export function SubjectListPane({
  snapshot,
  model
}: {
  snapshot: ConversationWorkspaceSnapshot
  model: ConversationWorkspaceModel
}) {
  const { locale } = useLocale()
  const selected = snapshot.subject?.name ?? null

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="subjectList" data-testid="subject-list">
      <section className="min-h-0 flex-1 overflow-auto p-3" aria-labelledby="jea-subjects-label">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
          <h2 id="jea-subjects-label">{conversationText(locale, 'subjects')}</h2>
          <span>{snapshot.subjects.length}</span>
        </div>
        {snapshot.subjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{conversationText(locale, 'noSubjects')}</p>
        ) : (
          <ul className="space-y-1">
            {snapshot.subjects.map((subject) => {
              const active = subject.name === selected
              return (
                <li key={subject.name}>
                  <button
                    type="button"
                    data-testid={`subject-${subject.name}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-hover',
                      active && 'bg-secondary'
                    )}
                    aria-pressed={active}
                    onClick={() => void model.selectSubject(subject.name)}
                  >
                    <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{subject.name}</strong>
                      <small className="block truncate text-xs text-muted-foreground">{subject.namespace}</small>
                    </span>
                    {subject.isDefault ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {conversationText(locale, 'defaultBadge')}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section className="border-t border-border p-3" aria-labelledby="jea-sessions-label">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="jea-sessions-label" className="text-xs font-medium text-muted-foreground">
            {conversationText(locale, 'sessions')}
          </h2>
          <Button
            size="sm"
            variant="outline"
            data-testid="session-create"
            disabled={!snapshot.subject}
            onClick={() => void model.createSession()}
          >
            {conversationText(locale, 'newSession')}
          </Button>
        </div>
        {snapshot.sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{conversationText(locale, 'noSessions')}</p>
        ) : (
          <ul className="space-y-1" data-testid="session-list">
            {snapshot.sessions.map((session) => {
              const active = session.session_id === snapshot.sessionId
              return (
                <li key={session.session_id}>
                  <button
                    type="button"
                    data-testid={`session-${session.session_id}`}
                    className={cn(
                      'w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-hover',
                      active && 'bg-secondary'
                    )}
                    aria-pressed={active}
                    onClick={() => void model.selectSession(session.session_id)}
                  >
                    <strong className="block truncate">{session.session_id}</strong>
                    <span className="block text-xs text-muted-foreground">{session.message_count} messages</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

export function ConversationPane({
  snapshot,
  model
}: {
  snapshot: ConversationWorkspaceSnapshot
  model: ConversationWorkspaceModel
}) {
  const { locale } = useLocale()
  const disabled = !snapshot.subject?.desktopChannelEnabled
  const sending = snapshot.sendState === 'pending'
  const failed = snapshot.sendState === 'failed'
  const canSend = Boolean(snapshot.subject && snapshot.sessionId && snapshot.draft.trim() && !disabled && !sending)

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="conversation" data-testid="conversation-workspace">
      <header className="border-b border-border px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {conversationText(locale, 'conversation')}
        </p>
        <h2 className="truncate text-sm font-semibold">
          {snapshot.subject?.name ?? '—'}
          {snapshot.sessionId ? ` / ${snapshot.sessionId}` : ''}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{conversationText(locale, 'conversationHint')}</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        {snapshot.loading ? (
          <p className="text-sm text-muted-foreground">{conversationText(locale, 'loading')}</p>
        ) : null}
        <ConversationCards cards={snapshot.cards} />
        {disabled ? (
          <div
            className="rounded-md border border-status-warn/40 bg-status-warn/10 p-3 text-sm"
            data-testid="conversation-state-disabled"
            role="status"
          >
            <p>{conversationText(locale, 'enableDesktopHint')}</p>
            <Button
              className="mt-2"
              size="sm"
              data-testid="conversation-enable-desktop"
              onClick={() => void model.enableDesktopChannel()}
            >
              {conversationText(locale, 'enableDesktop')}
            </Button>
          </div>
        ) : null}
        {snapshot.cards.some((card) => card.kind === 'offline' || card.kind === 'daemon_unhealthy') ? (
          <div
            className="rounded-md border border-border bg-surface-sunken p-3 text-sm"
            data-testid="conversation-state-offline"
            role="status"
          >
            <p>{conversationText(locale, 'startServiceHint')}</p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              data-testid="conversation-start-service"
              onClick={() => void model.startChannelService()}
            >
              {conversationText(locale, 'startService')}
            </Button>
          </div>
        ) : null}
        {snapshot.error?.kind === 'web_rejected' ? (
          <p className="text-sm text-status-error-foreground" data-testid="conversation-state-web-rejected" role="alert">
            {conversationText(locale, 'webRejected')}
          </p>
        ) : null}
        {failed ? (
          <p className="text-sm text-status-error-foreground" data-testid="conversation-state-failed" role="alert">
            {snapshot.error?.message ?? conversationText(locale, 'failed')}
          </p>
        ) : null}
        {sending ? (
          <p className="text-sm text-muted-foreground" data-testid="conversation-state-pending">
            {conversationText(locale, 'pending')}
          </p>
        ) : null}
        {snapshot.waiting ? (
          <p className="text-sm text-muted-foreground" data-testid="conversation-state-waiting">
            {conversationText(locale, 'waiting')}
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-2" aria-live="polite">
          {snapshot.records.map((record) => (
            <article
              key={record.id}
              data-testid={`conversation-message-${record.role}`}
              className={cn(
                'max-w-[85%] rounded-md border border-border px-3 py-2 text-sm',
                record.role === 'user' ? 'self-end bg-secondary' : 'self-start bg-surface-raised'
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <strong>{record.role === 'user' ? conversationText(locale, 'you') : conversationText(locale, 'assistant')}</strong>
                <time>{formatTime(record.created_at)}</time>
              </div>
              <p className="whitespace-pre-wrap">{record.content}</p>
            </article>
          ))}
          {snapshot.records.length === 0 && !snapshot.loading ? (
            <div className="text-sm text-muted-foreground">{conversationText(locale, 'emptyMessages')}</div>
          ) : null}
        </div>
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void (failed ? model.retry() : model.send())
        }}
      >
        <label className="sr-only" htmlFor="jea-conversation-draft">{conversationText(locale, 'conversation')}</label>
        <textarea
          id="jea-conversation-draft"
          data-testid="conversation-draft"
          rows={3}
          disabled={disabled || sending}
          className="min-h-24 w-full resize-none rounded-md border border-input bg-surface-raised p-3 text-sm"
          placeholder={conversationText(locale, 'draftPlaceholder')}
          value={snapshot.draft}
          onChange={(event) => model.setDraft(event.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            data-testid={failed ? 'conversation-retry' : 'conversation-send'}
            disabled={failed ? sending : !canSend}
          >
            {sending
              ? conversationText(locale, 'sending')
              : failed
                ? conversationText(locale, 'retry')
                : conversationText(locale, 'send')}
          </Button>
          {snapshot.waiting ? (
            <Button
              type="button"
              variant="outline"
              data-testid="conversation-stop-waiting"
              onClick={() => model.stopWaiting()}
            >
              {conversationText(locale, 'stopWaiting')}
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  )
}

export function ServiceStatusPane({
  snapshot,
  model
}: {
  snapshot: ConversationWorkspaceSnapshot
  model: ConversationWorkspaceModel
}) {
  const { locale } = useLocale()
  const offline = snapshot.cards.some((card) => card.kind === 'offline')
  const degraded = snapshot.cards.some((card) => card.kind === 'daemon_unhealthy' || card.kind === 'desktop_disabled')
  const label = offline
    ? conversationText(locale, 'serviceOffline')
    : degraded
      ? conversationText(locale, 'serviceDegraded')
      : conversationText(locale, 'serviceOnline')
  const tone = offline ? 'bg-status-offline' : degraded ? 'bg-status-warn' : 'bg-status-ok'

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-slot="serviceStatus" data-testid="conversation-service-status">
      <span className={cn('size-2 rounded-full', tone)} aria-hidden="true" />
      <span>{label}</span>
      {(offline || degraded) && snapshot.subject ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="conversation-service-start"
          onClick={() => void model.startChannelService()}
        >
          {conversationText(locale, 'startService')}
        </Button>
      ) : null}
    </div>
  )
}
