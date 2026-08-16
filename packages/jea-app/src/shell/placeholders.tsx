import { BookOpen, MessagesSquare, Orbit } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider'
import type { FeatureSlotProps } from '../slots/types'
import { cn } from '../lib/cn'

export function SubjectListPlaceholder({ adapters }: FeatureSlotProps) {
  const { t } = useLocale()
  const subjects = adapters.subjects ?? []

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="subjectList">
      <section className="min-h-0 flex-1 overflow-auto p-3" aria-labelledby="jea-subjects-label">
        <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
          <h2 id="jea-subjects-label">{t('subjects')}</h2>
          <span>{subjects.length}</span>
        </div>
        {subjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSubjects')}</p>
        ) : (
          <ul className="space-y-1">
            {subjects.map((subject) => {
              const selected = subject.id === adapters.selectedSubjectId
              return (
                <li key={subject.id}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-hover',
                      selected && 'bg-secondary'
                    )}
                    aria-pressed={selected}
                    onClick={() => adapters.onSelectSubject?.(subject.id)}
                  >
                    <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm">{subject.name}</strong>
                      {subject.namespace ? (
                        <small className="block truncate text-xs text-muted-foreground">{subject.namespace}</small>
                      ) : null}
                    </span>
                    {subject.isDefault ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t('defaultSubject')}
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

export function ConversationPlaceholder(_props: FeatureSlotProps) {
  const { t } = useLocale()
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center" data-slot="conversation">
      <MessagesSquare className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-md text-sm text-muted-foreground">{t('conversationPlaceholder')}</p>
      <label className="sr-only" htmlFor="jea-conversation-draft">{t('conversation')}</label>
      <textarea
        id="jea-conversation-draft"
        data-testid="conversation-draft"
        className="min-h-24 w-full max-w-xl resize-none rounded-md border border-input bg-surface-raised p-3 text-sm"
        defaultValue=""
      />
    </div>
  )
}

export function EvolutionPlaceholder(_props: FeatureSlotProps) {
  const { t } = useLocale()
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center" data-slot="evolutionInspector">
      <Orbit className="size-8 text-muted-foreground" aria-hidden="true" />
      <p className="max-w-sm text-sm text-muted-foreground">{t('evolutionPlaceholder')}</p>
    </div>
  )
}

export function SettingsPlaceholder(_props: FeatureSlotProps) {
  const { t } = useLocale()
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface-sunken p-4 text-sm text-muted-foreground" data-slot="settings">
      <div className="mb-2 flex items-center gap-2 text-foreground">
        <BookOpen className="size-4" aria-hidden="true" />
        <strong>{t('settingsSlotHint')}</strong>
      </div>
    </div>
  )
}

export function ServiceStatusPlaceholder({ adapters }: FeatureSlotProps) {
  const { t } = useLocale()
  const status = adapters.serviceStatus ?? 'online'
  const label = status === 'offline'
    ? t('statusOffline')
    : status === 'degraded'
      ? t('statusDegraded')
      : t('statusOnline')
  const tone = status === 'offline'
    ? 'bg-status-offline'
    : status === 'degraded'
      ? 'bg-status-warn'
      : 'bg-status-ok'

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-slot="serviceStatus">
      <span className={cn('size-2 rounded-full', tone)} aria-hidden="true" />
      <span>{t('serviceStatus')}: {label}</span>
    </div>
  )
}
