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
  const serviceStarting = snapshot.serviceStartState === 'pending'
  const canSend = Boolean(snapshot.subject && snapshot.sessionId && snapshot.draft.trim() && !disabled && !sending)

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="conversation" data-testid="conversation-workspace">
      <header className="border-b border-border px-4 py-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {conversationText(locale, 'conversation')}
        </p>
        <h2 className="truncate text-sm font-semibold">
          {snapshot.subject?.name ?? '—'}
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
              disabled={serviceStarting}
              onClick={() => void model.startChannelService()}
            >
              {serviceStarting
                ? conversationText(locale, 'startingService')
                : conversationText(locale, 'startService')}
            </Button>
          </div>
        ) : null}
        {snapshot.serviceStartState === 'failed' ? (
          <p
            className="text-sm text-status-error-foreground"
            data-testid="conversation-state-start-failed"
            role="alert"
          >
            {snapshot.error?.message ?? conversationText(locale, 'serviceStartFailed')}
          </p>
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
  const stale = snapshot.stale || snapshot.cards.some((card) => card.kind === 'stale')
  const degraded = snapshot.cards.some((card) => card.kind === 'daemon_unhealthy' || card.kind === 'desktop_disabled')
  const starting = snapshot.serviceStartState === 'pending'
  const label = starting
    ? conversationText(locale, 'serviceStarting')
    : offline
    ? conversationText(locale, 'serviceOffline')
    : stale
      ? conversationText(locale, 'serviceStale')
    : degraded
      ? conversationText(locale, 'serviceDegraded')
      : conversationText(locale, 'serviceOnline')
  const tone = starting
    ? 'bg-status-warn'
    : offline
      ? 'bg-status-offline'
      : stale || degraded
        ? 'bg-status-warn'
        : 'bg-status-ok'

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-slot="serviceStatus"
      data-testid="conversation-service-status"
      data-stale={stale ? 'true' : 'false'}
    >
      <span className={cn('size-2 rounded-full', tone)} aria-hidden="true" />
      <span>{label}</span>
      {(offline || degraded) && snapshot.subject ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="conversation-service-start"
          disabled={starting}
          onClick={() => void model.startChannelService()}
        >
          {starting
            ? conversationText(locale, 'startingService')
            : conversationText(locale, 'startService')}
        </Button>
      ) : null}
      <CycleRemediationActions snapshot={snapshot} model={model} locale={locale} />
    </div>
  )
}

function CycleRemediationActions({
  snapshot,
  model,
  locale
}: {
  snapshot: ConversationWorkspaceSnapshot
  model: ConversationWorkspaceModel
  locale: 'en' | 'zh'
}) {
  const actions = snapshot.serviceReadiness?.allowed_actions ?? []
  const backlog = typeof snapshot.observability?.attention?.backlog_count === 'number'
    ? snapshot.observability.attention.backlog_count
    : null
  const canProcess = actions.includes('process_cycle_once')
  const canStartCycle = actions.includes('start_cycle')
  if (!snapshot.subject || (!canProcess && !canStartCycle && backlog == null)) return null
  const processing = snapshot.cycleProcessState === 'pending'
  const startingCycle = snapshot.cycleStartState === 'pending'
  return (
    <span className="flex items-center gap-1" data-testid="conversation-cycle-remediation">
      {backlog != null ? (
        <span data-testid="conversation-cycle-backlog">
          {conversationText(locale, 'cycleBacklog')} {backlog}
        </span>
      ) : null}
      {canProcess ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="conversation-process-cycle-once"
          disabled={processing}
          onClick={() => void model.processCycleOnce()}
        >
          {processing
            ? conversationText(locale, 'processingCycleOnce')
            : conversationText(locale, 'processCycleOnce')}
        </Button>
      ) : null}
      {canStartCycle ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="conversation-start-cycle"
          disabled={startingCycle}
          onClick={() => void model.startCycleService()}
        >
          {startingCycle
            ? conversationText(locale, 'startingCycle')
            : conversationText(locale, 'startCycle')}
        </Button>
      ) : null}
    </span>
  )
}
