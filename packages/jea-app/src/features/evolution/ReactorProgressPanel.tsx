import { useState } from 'react'
import { useLocale } from '../../i18n/LocaleProvider'
import type { MessageKey } from '../../i18n/messages'
import { Button } from '../../ui/button'
import type { LlmBudgetReadinessView, ProductHostKind, SubjectReadiness } from '../client-types'
import { formatLlmBudgetBlocker, formatLlmBudgetUsage, isLlmBudgetBlocker } from '../llm-budget-display'
import { publicErrorMessage } from '../client-types'
import {
  projectReactorControlPlane,
  type ReactorActionId,
  type ReactorControlPlaneView
} from '../reactor-progress'
import type { EvolutionObservability } from './types'
import { actionLabelKey, actionReasonKey, freshnessMessageKey, schedulerStateMessageKey } from './reactor-progress-copy'

export function ReactorProgressPanel({
  readiness,
  observability,
  host,
  client,
  onRefresh
}: {
  readiness?: SubjectReadiness | null
  observability?: EvolutionObservability | null
  host: ProductHostKind
  client?: {
    setAutomation?(subject: string, mode: 'automatic' | 'paused'): Promise<unknown>
    processCycleOnce?(subject: string): Promise<{ status?: string; reason?: string } | unknown>
    startService?(subject: string, domain?: 'all' | 'cycle' | 'channel'): Promise<unknown>
    stopService?(subject: string): Promise<unknown>
  } | null
  onRefresh?: () => Promise<void> | void
}) {
  const { t } = useLocale()
  const plane = projectReactorControlPlane({ readiness, observability, host })
  const [busy, setBusy] = useState<ReactorActionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const subject = readiness?.subject ?? observability?.subject ?? plane.progress?.subject ?? null

  async function run(id: ReactorActionId) {
    if (!client || !subject) return
    setBusy(id)
    setError(null)
    try {
      if (id === 'pause_automatic_evolution' && client.setAutomation) {
        await client.setAutomation(subject, 'paused')
      } else if (id === 'resume_automatic_evolution' && client.setAutomation) {
        await client.setAutomation(subject, 'automatic')
      } else if ((id === 'check_now' || id === 'process_cycle_once') && client.processCycleOnce) {
        const result = await client.processCycleOnce(subject) as { status?: string; reason?: string }
        if (result.status === 'retryable' || result.status === 'blocked') {
          throw new Error(result.reason || t('evolutionCheckNowFailed'))
        }
      } else if (id === 'start_worker' && client.startService && host !== 'web') {
        await client.startService(subject, 'cycle')
      } else if (id === 'stop_worker' && client.stopService && host !== 'web') {
        await client.stopService(subject)
      }
      await onRefresh?.()
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      className="space-y-2 border-b border-border bg-surface-sunken px-3 py-2"
      data-testid="reactor-progress"
      data-scheduler-state={plane.display_state}
      data-freshness={plane.freshness}
      data-worker-alive={plane.worker_alive ? 'true' : 'false'}
      data-catching-up={plane.catching_up_truthful ? 'true' : 'false'}
      data-overlap-additive="false"
      data-evidence-is-work="false"
      aria-labelledby="reactor-progress-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="reactor-progress-heading" className="text-xs font-semibold">
            {t('reactorProgress')}
          </h3>
          <p className="text-sm" data-testid="reactor-scheduler-state">
            {t(schedulerStateMessageKey(plane.display_state))}
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="reactor-freshness">
            {t('reactorSnapshot')}: {t(freshnessMessageKey(plane.freshness))}
            {plane.projection_generation != null ? ` · ${t('reactorGeneration')} ${plane.projection_generation}` : ''}
            {plane.freshness_reason ? ` · ${plane.freshness_reason}` : ''}
          </p>
        </div>
        <p className="text-[11px] text-muted-foreground" data-testid="reactor-liveness">
          {t('reactorWorker')}: {plane.worker_alive ? t('reactorWorkerAlive') : t('reactorWorkerIdle')}
          {plane.progress?.worker_liveness.heartbeat_at
            ? ` · ${t('reactorHeartbeat')} ${formatStamp(plane.progress.worker_liveness.heartbeat_at)}`
            : ''}
        </p>
      </div>

      <ActivityRows plane={plane} />
      <LaneTable plane={plane} />
      <BudgetAndBlocker readiness={readiness} plane={plane} />
      {error ? <p className="text-xs text-destructive" role="alert" data-testid="reactor-progress-error">{error}</p> : null}
      <ActionRow
        plane={plane}
        host={host}
        busy={busy}
        disabled={!client || !subject}
        onRun={(id) => void run(id)}
      />
    </section>
  )
}

function ActivityRows({ plane }: { plane: ReactorControlPlaneView }) {
  const { t } = useLocale()
  const activity = plane.progress?.activity
  const limits = plane.progress?.limits
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" data-testid="reactor-activity">
      <Row label={t('reactorTask')} value={activity?.current_task
        ? `${activity.current_task.id}${activity.current_task.lane ? ` · ${activity.current_task.lane}` : ''}`
        : t('reactorNoActiveTask')} />
      <Row label={t('reactorClaim')} value={activity?.current_claim?.claim_id
        ?? activity?.current_claim?.reactor
        ?? '—'} />
      <Row label={t('reactorBatch')} value={activity?.current_batch?.candidate_id
        ?? activity?.current_batch?.batch_id
        ?? '—'} />
      <Row label={t('reactorStage')} value={activity?.current_stage ?? '—'} />
      <Row label={t('reactorLastProgress')} value={formatStamp(activity?.last_progress_at)} />
      <Row
        label={t('reactorLimits')}
        value={[
          limits?.replay_batch_limit != null ? `${t('reactorReplayBatch')} ${limits.replay_batch_limit}` : null,
          limits?.replay_wall_clock_ms != null ? `${t('reactorReplayClock')} ${limits.replay_wall_clock_ms}ms` : null,
          limits?.token_reserve != null ? `${t('reactorTokenReserve')} ${limits.token_reserve}` : null,
          limits?.spend_allowance != null ? `${t('reactorSpendAllowance')} ${limits.spend_allowance}` : null
        ].filter(Boolean).join(' · ') || '—'}
      />
    </dl>
  )
}

function LaneTable({ plane }: { plane: ReactorControlPlaneView }) {
  const { t } = useLocale()
  return (
    <div className="space-y-1" data-testid="reactor-lanes">
      <p className="text-[11px] text-muted-foreground" data-testid="reactor-overlap-note">
        {t('reactorOverlapNote')}
      </p>
      <p className="text-[11px]" data-testid="reactor-lane-totals">
        {t('reactorRealtime')}: {plane.realtime_ready} · {t('reactorReplay')}: {plane.replay_ready}
      </p>
      {plane.progress?.evidence_authority ? (
        <p className="text-[11px] text-muted-foreground" data-testid="reactor-evidence-authority">
          {t('reactorEvidenceNotWork')}
          {plane.progress.evidence_authority.envelope_count != null
            ? ` · ${plane.progress.evidence_authority.envelope_count}`
            : ''}
        </p>
      ) : null}
      {plane.lanes.length > 0 ? (
        <table className="w-full text-left text-[11px]">
          <caption className="sr-only">{t('reactorLanes')}</caption>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col">{t('reactorName')}</th>
              <th scope="col">{t('reactorRealtime')}</th>
              <th scope="col">{t('reactorReplay')}</th>
            </tr>
          </thead>
          <tbody>
            {plane.lanes.map((lane) => (
              <tr key={lane.reactor} data-testid={`reactor-lane-${lane.reactor}`}>
                <th scope="row" className="font-medium">{lane.reactor}</th>
                <td>{lane.realtime.ready}/{lane.realtime.claimed}/{lane.realtime.deferred}/{lane.realtime.blocked}</td>
                <td>{lane.replay.ready}/{lane.replay.claimed}/{lane.replay.deferred}/{lane.replay.blocked}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

function BudgetAndBlocker({
  readiness,
  plane
}: {
  readiness?: SubjectReadiness | null
  plane: ReactorControlPlaneView
}) {
  const { t } = useLocale()
  const budget = readiness?.llm_budget as LlmBudgetReadinessView | null | undefined
  const blocker = plane.primary_blocker
  const budgetCopy = formatLlmBudgetBlocker(blocker, budget)
  return (
    <div className="space-y-1" data-testid="reactor-blocker">
      {blocker ? (
        <p className="text-xs">
          {t('evolutionBlocked')}: {budgetCopy ?? blocker}
          {plane.progress?.stop_reason?.detail ? ` · ${plane.progress.stop_reason.detail}` : ''}
        </p>
      ) : null}
      {budget ? (
        <p className="text-[11px] text-muted-foreground" data-testid="reactor-llm-budget">
          {formatLlmBudgetUsage(budget)} · {budget.cycle_admission === 'parked' ? t('reactorCycleParked') : t('reactorCycleOpen')}
        </p>
      ) : null}
      {budget && isLlmBudgetBlocker(blocker ?? budget.blocked_reason) ? (
        <p className="text-[11px] text-muted-foreground" data-testid="reactor-budget-recover">
          {t('evolutionBudgetRecover')}
        </p>
      ) : null}
    </div>
  )
}

function ActionRow({
  plane,
  host,
  busy,
  disabled,
  onRun
}: {
  plane: ReactorControlPlaneView
  host: ProductHostKind
  busy: ReactorActionId | null
  disabled: boolean
  onRun(id: ReactorActionId): void
}) {
  const { t } = useLocale()
  const visible = plane.actions.filter((action) => (
    action.id !== 'open_desktop'
    && action.id !== 'raise_budget'
    && (action.id !== 'start_worker' && action.id !== 'stop_worker' ? true : host === 'electron' || !action.allowed)
  ))
  return (
    <div className="flex flex-wrap gap-1" data-testid="reactor-actions">
      {visible.map((action) => {
        const reasonKey = actionReasonKey(action.reason)
        const title = reasonKey ? t(reasonKey) : (action.reason ?? undefined)
        const showDisabled = action.id === 'start_replay_plan' || action.id === 'start_worker' || action.id === 'stop_worker' || action.allowed
        if (!showDisabled && !action.allowed) return null
        if ((action.id === 'start_worker' || action.id === 'stop_worker') && host === 'web') {
          return (
            <span
              key={action.id}
              className="text-[11px] text-muted-foreground"
              data-testid={`reactor-action-${action.id}`}
              data-allowed="false"
              title={title}
            >
              {t(actionLabelKey(action.id))}: {t('openDesktopRecovery')}
            </span>
          )
        }
        return (
          <Button
            key={action.id}
            size="sm"
            variant={action.id === 'check_now' || action.id === 'start_replay_plan' ? 'outline' : 'default'}
            data-testid={`reactor-action-${action.id}`}
            data-allowed={action.allowed ? 'true' : 'false'}
            disabled={disabled || Boolean(busy) || !action.allowed}
            title={title}
            onClick={() => onRun(action.id)}
          >
            {busy === action.id ? t('evolutionProcessingOnce' as MessageKey) : t(actionLabelKey(action.id))}
          </Button>
        )
      })}
      {host === 'web' && plane.actions.some((action) => action.id === 'open_desktop' && action.allowed) ? (
        <p className="w-full text-[11px] text-muted-foreground" data-testid="reactor-open-desktop">
          {t('openDesktopRecovery')}
        </p>
      ) : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  )
}

function formatStamp(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace('T', ' ').slice(0, 16)
}
