import { useLocale } from '../../i18n/LocaleProvider'
import type { FeatureSlotProps } from '../../slots/types'
import { cn } from '../../lib/cn'
import { useJeaClientContext } from '../client-context'
import { deriveServiceStatusKind, needsOpenDesktop, webHostStoppedIsNotOutage } from './derive'

function toneClass(kind: 'online' | 'offline' | 'degraded'): string {
  if (kind === 'offline') return 'bg-status-offline'
  if (kind === 'degraded') return 'bg-status-warn'
  return 'bg-status-ok'
}

function DomainRow({
  label,
  state,
  reasons,
  testId
}: {
  label: string
  state: string
  reasons: string[]
  testId: string
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{state}</span>
      {reasons.length > 0 ? (
        <span className="w-full text-[10px] text-muted-foreground">{reasons.join('; ')}</span>
      ) : null}
    </div>
  )
}

export function ServiceStatusView({ adapters }: FeatureSlotProps) {
  const { t } = useLocale()
  const { host } = useJeaClientContext()
  const readiness = adapters.subjectReadiness ?? null
  const kind = deriveServiceStatusKind(readiness, {
    host: adapters.hostKind ?? host,
    connection: adapters.serviceStatus === 'offline' ? 'offline' : undefined
  })
  const label = kind === 'offline'
    ? t('statusOffline')
    : kind === 'degraded'
      ? t('statusDegraded')
      : t('statusOnline')
  const showOpenDesktop = (adapters.hostKind ?? host) === 'web' && needsOpenDesktop(readiness)
  const webStoppedOk = webHostStoppedIsNotOutage(readiness, adapters.hostKind ?? host)

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-slot="serviceStatus" data-testid="service-status">
      <span className={cn('size-2 rounded-full', toneClass(kind))} aria-hidden="true" />
      <span data-testid="service-status-kind">{t('serviceStatus')}: {label}</span>
      {readiness ? (
        <details className="relative" data-testid="service-status-details">
          <summary className="cursor-pointer list-none text-xs underline-offset-2 hover:underline">
            {t('serviceStatusDetails')}
          </summary>
          <div className="absolute right-0 z-20 mt-2 w-72 space-y-2 rounded-md border border-border bg-surface-raised p-3 text-xs shadow-md">
            <DomainRow
              label={t('diagnosticsWeb')}
              state={readiness.web_host.state}
              reasons={readiness.web_host.reasons}
              testId="service-status-web"
            />
            <DomainRow
              label={t('diagnosticsCycle')}
              state={readiness.cycle.state}
              reasons={readiness.cycle.reasons}
              testId="service-status-cycle"
            />
            <DomainRow
              label={t('diagnosticsChannel')}
              state={readiness.channel.state}
              reasons={readiness.channel.reasons}
              testId="service-status-channel"
            />
            <DomainRow
              label={t('diagnosticsModel')}
              state={readiness.model.state}
              reasons={readiness.model.reasons}
              testId="service-status-model"
            />
            <DomainRow
              label={t('diagnosticsConversation')}
              state={readiness.conversation.state}
              reasons={readiness.conversation.reasons}
              testId="service-status-conversation"
            />
            {webStoppedOk ? (
              <p className="text-muted-foreground" data-testid="service-status-web-not-outage">
                {t('webHostStoppedNotOutage')}
              </p>
            ) : null}
            {showOpenDesktop ? (
              <p className="text-foreground" data-testid="service-status-open-desktop">
                {t('openDesktopRecovery')}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}
