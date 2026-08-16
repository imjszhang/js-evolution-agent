import { AlertTriangle, LoaderCircle, WifiOff } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider'
import { Button } from '../ui/button'

export type ShellViewState = 'ready' | 'loading' | 'empty' | 'offline' | 'error'

export function GlobalStateView({
  state,
  onRetry,
  onOpenSettings
}: {
  state: Exclude<ShellViewState, 'ready'>
  onRetry?(): void
  onOpenSettings?(): void
}) {
  const { t } = useLocale()
  const copy = {
    loading: { title: t('loadingTitle'), body: t('loadingBody'), icon: LoaderCircle },
    empty: { title: t('emptyTitle'), body: t('emptyBody'), icon: AlertTriangle },
    offline: { title: t('offlineTitle'), body: t('offlineBody'), icon: WifiOff },
    error: { title: t('errorTitle'), body: t('errorBody'), icon: AlertTriangle }
  }[state]
  const Icon = copy.icon

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid={`global-state-${state}`}
      role={state === 'error' || state === 'offline' ? 'alert' : 'status'}
    >
      <Icon className={state === 'loading' ? 'size-8 animate-spin text-muted-foreground' : 'size-8 text-muted-foreground'} aria-hidden="true" />
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="max-w-md text-sm text-muted-foreground">{copy.body}</p>
      </div>
      {state === 'error' ? (
        <div className="flex gap-2">
          <Button onClick={onRetry}>{t('retry')}</Button>
          <Button variant="outline" onClick={onOpenSettings}>{t('openSettings')}</Button>
        </div>
      ) : null}
    </div>
  )
}
