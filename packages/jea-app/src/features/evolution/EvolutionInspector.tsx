import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, CircleDashed, Orbit, ScrollText } from 'lucide-react'
import { useLocale } from '../../i18n/LocaleProvider'
import type { MessageKey } from '../../i18n/messages'
import type { FeatureSlotProps } from '../../slots/types'
import { Button } from '../../ui/button'
import { Separator } from '../../ui/separator'
import { cn } from '../../lib/cn'
import type { LlmBudgetReadinessView } from '../client-types'
import { formatLlmBudgetBlocker } from '../llm-budget-display'
import { createInspectorController } from './controller'
import { subscribeEvolutionNavigation } from './navigation'
import { projectEvolutionCore, projectTimeline, resolveSafeState } from './projection'
import type {
  EvolutionInspectorClient,
  EvolutionInspectorSnapshot,
  InspectorSafeState,
  TimelineCycleView
} from './types'

const SECTIONS = ['report', 'diary', 'verify', 'evidence'] as const
type SectionId = (typeof SECTIONS)[number]

export interface EvolutionInspectorProps extends FeatureSlotProps {
  client?: EvolutionInspectorClient | null
  navFixtureCycleId?: string
  snapshot?: EvolutionInspectorSnapshot
  loading?: boolean
}

export function EvolutionInspector({
  adapters,
  client,
  navFixtureCycleId,
  snapshot: snapshotProp,
  loading: loadingProp
}: EvolutionInspectorProps) {
  const { t } = useLocale()
  const controllerRef = useRef(client ? createInspectorController(client) : null)
  const [liveSnapshot, setLiveSnapshot] = useState<EvolutionInspectorSnapshot>(
    () => snapshotProp ?? controllerRef.current?.snapshot ?? {
      subject: adapters.selectedSubjectId ?? null,
      list: null,
      observability: null,
      cycles: {},
      rounds: {},
      selectedCycleId: adapters.selectedCycleId ?? null,
      error: null
    }
  )
  const [liveLoading, setLiveLoading] = useState(Boolean(client) && !snapshotProp)
  const [section, setSection] = useState<SectionId>('report')
  const subject = adapters.selectedSubjectId ?? null

  const apply = useCallback((next: EvolutionInspectorSnapshot, loading = false) => {
    setLiveSnapshot(next)
    setLiveLoading(loading)
  }, [])

  useEffect(() => {
    if (!client || snapshotProp) return
    const controller = controllerRef.current ?? createInspectorController(client)
    controllerRef.current = controller
    let cancelled = false
    setLiveLoading(true)
    void controller.load(subject, adapters.selectedCycleId).then((next) => {
      if (!cancelled) apply(next, controller.loading)
    })
    const stopClient = controller.subscribe((next) => {
      if (!cancelled) apply(next)
    })
    const stopNav = subscribeEvolutionNavigation((detail) => {
      if (detail.subject && detail.subject !== subject) return
      void controller.selectCycle(detail.cycleId).then((next) => {
        if (!cancelled) apply(next)
      })
    })
    return () => {
      cancelled = true
      stopClient()
      stopNav()
    }
  }, [adapters.selectedCycleId, apply, client, snapshotProp, subject])

  const snapshot = snapshotProp ?? liveSnapshot
  const loading = loadingProp ?? liveLoading
  const timeline = useMemo(() => projectTimeline(snapshot), [snapshot])
  const core = useMemo(() => projectEvolutionCore(snapshot), [snapshot])
  const safeState = resolveSafeState(snapshot, loading)
  const selected = timeline.find((item) => item.cycle_id === core.selected_cycle_id) ?? null

  const pendingEvidence = typeof snapshot.observability?.evidence_pending_count === 'number'
    ? snapshot.observability.evidence_pending_count
    : null
  const onSelect = (cycleId: string) => {
    adapters.onSelectCycle?.(cycleId)
    if (controllerRef.current && !snapshotProp) {
      void controllerRef.current.selectCycle(cycleId).then((next) => apply(next))
      return
    }
    apply({ ...snapshot, selectedCycleId: cycleId })
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-surface text-foreground"
      data-slot="evolutionInspector"
      data-testid="evolution-inspector"
      data-ready={loading ? 'false' : 'true'}
      data-state={safeState}
      data-stale={snapshot.stale ? 'true' : 'false'}
      data-subject={snapshot.subject ?? ''}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Orbit className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('evolutionInspector')}
          </h2>
          <p className="truncate text-xs text-muted-foreground" data-testid="evolution-runtime">
            {evolutionRuntimeCopy(t, adapters.subjectReadiness?.automation, pendingEvidence, adapters.subjectReadiness?.llm_budget)
              ?? (core.open_cycles > 0 ? t('evolutionOpenCycle') : t('evolutionRecentCycles'))}
            {core.round_count ? ` · ${core.round_count}` : ''}
            {pendingEvidence != null && !adapters.subjectReadiness?.automation
              ? ` · ${t('evolutionPendingEvidence')} ${pendingEvidence}`
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {navFixtureCycleId ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="evolution-open-cycle-fixture"
              onClick={() => onSelect(navFixtureCycleId)}
            >
              {t('evolutionOpenFixtureCycle')}
            </Button>
          ) : null}
        </div>
      </header>

      <SafeBanner state={safeState} />

      <div className="flex min-h-0 flex-1 flex-col">
        <nav
          aria-label={t('evolutionTimeline')}
          data-testid="evolution-timeline"
          className="max-h-40 shrink-0 overflow-auto border-b border-border p-2"
        >
          {timeline.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">{emptyCopy(safeState, t)}</p>
          ) : (
            <ul className="space-y-1">
              {timeline.map((item) => (
                <TimelineItem
                  key={item.cycle_id}
                  item={item}
                  selected={item.cycle_id === core.selected_cycle_id}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          )}
        </nav>

        <div className="flex gap-1 overflow-auto border-b border-border px-2 py-1" role="tablist" aria-label={t('evolutionSections')}>
          {SECTIONS.map((id) => (
            <Button
              key={id}
              variant={section === id ? 'secondary' : 'ghost'}
              size="sm"
              role="tab"
              aria-selected={section === id}
              data-testid={`evolution-section-${id}`}
              onClick={() => setSection(id)}
            >
              {sectionLabel(id, t)}
            </Button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="evolution-reader">
          {selected ? (
            <CycleReader
              section={section}
              item={selected}
              core={core}
              snapshot={snapshot}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{emptyCopy(safeState, t)}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function evolutionRuntimeCopy(
  t: (key: 'evolutionAutomaticPaused' | 'evolutionListening' | 'evolutionCatchingUp' | 'evolutionWaitingApproval' | 'evolutionBlocked') => string,
  automation: { mode?: string; intent?: string; remaining_evidence?: number | null; blocker?: string | null } | null | undefined,
  pendingEvidence: number | null,
  llmBudget?: LlmBudgetReadinessView | null,
): string | null {
  if (!automation) return null
  if (automation.mode === 'paused' || automation.intent === 'paused') return t('evolutionAutomaticPaused')
  if (automation.intent === 'catching_up') {
    const remaining = automation.remaining_evidence ?? pendingEvidence ?? 0
    return remaining > 0 ? `${t('evolutionCatchingUp')}: ${remaining}` : t('evolutionCatchingUp')
  }
  if (automation.intent === 'waiting_approval') return t('evolutionWaitingApproval')
  if (automation.intent === 'blocked') {
    const detail = formatLlmBudgetBlocker(automation.blocker, llmBudget)
    return detail ? `${t('evolutionBlocked')}: ${detail}` : t('evolutionBlocked')
  }
  return t('evolutionListening')
}

function SafeBanner({ state }: { state: InspectorSafeState }) {
  const { t } = useLocale()
  if (state === 'open' || state === 'historical') return null
  const copy = {
    'no-subject': t('evolutionNoSubject'),
    loading: t('evolutionLoading'),
    empty: t('evolutionNoCycles'),
    error: t('evolutionLoadError'),
    stale: t('evolutionStale'),
    offline: t('evolutionOffline'),
    'verify-unavailable': t('evolutionVerifyUnavailable'),
    malformed: t('evolutionMalformed')
  }[state]
  if (!copy) return null
  return (
    <p
      className="border-b border-border bg-surface-sunken px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="evolution-safe-state"
    >
      {copy}
    </p>
  )
}

function TimelineItem({
  item,
  selected,
  onSelect
}: {
  item: TimelineCycleView
  selected: boolean
  onSelect(cycleId: string): void
}) {
  const { t } = useLocale()
  return (
    <li>
      <button
        type="button"
        data-testid={`evolution-cycle-${item.cycle_id}`}
        aria-pressed={selected}
        className={cn(
          'flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover',
          selected && 'bg-secondary'
        )}
        onClick={() => onSelect(item.cycle_id)}
      >
        <span className="flex items-center justify-between gap-2">
          <strong className="truncate font-mono text-xs">{item.cycle_id}</strong>
          <span className={cn(
            'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
            item.kind === 'open' ? 'bg-status-ok/15 text-status-ok' : 'bg-muted text-muted-foreground'
          )}>
            {item.kind === 'open' ? t('evolutionStatusOpen') : t('evolutionStatusHistorical')}
          </span>
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {item.status ?? '—'} · {formatTime(item.time)}
        </span>
        <span
          className="flex flex-wrap gap-1"
          aria-label={t('evolutionSteps')}
          data-summary-only={item.steps.length === 0}
        >
          {item.steps.map((step) => (
            <span
              key={step.name}
              title={`${step.name}: ${step.status}`}
              className={cn(
                'rounded px-1 py-px font-mono text-[10px]',
                stepTone(step.status)
              )}
            >
              {step.name}
            </span>
          ))}
        </span>
      </button>
    </li>
  )
}

function CycleReader({
  section,
  item,
  core,
  snapshot
}: {
  section: SectionId
  item: TimelineCycleView
  core: ReturnType<typeof projectEvolutionCore>
  snapshot: EvolutionInspectorSnapshot
}) {
  const { t } = useLocale()
  const round = core.selected_cycle_id ? snapshot.rounds[core.selected_cycle_id] : null
  const detail = core.selected_cycle_id ? snapshot.cycles[core.selected_cycle_id] : null

  return (
    <div className="space-y-3" data-testid="evolution-cycle-reader">
      <div>
        <p className="font-mono text-xs text-muted-foreground">{item.cycle_id}</p>
        <p className="text-sm">{item.tldr ?? t('evolutionNoTldr')}</p>
      </div>
      <Separator />
      {section === 'report' ? (
        <section aria-labelledby="evolution-report-heading" data-testid="evolution-report">
          <h3 id="evolution-report-heading" className="mb-1 flex items-center gap-2 text-sm font-medium">
            <BookOpen className="size-4" aria-hidden="true" />
            {t('evolutionReport')}
          </h3>
          {core.report_available ? (
            <p className="text-sm">{core.report_tldr ?? t('evolutionReportAvailable')}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('evolutionReportUnavailable')}</p>
          )}
        </section>
      ) : null}
      {section === 'diary' ? (
        <section aria-labelledby="evolution-diary-heading" data-testid="evolution-diary">
          <h3 id="evolution-diary-heading" className="mb-1 flex items-center gap-2 text-sm font-medium">
            <ScrollText className="size-4" aria-hidden="true" />
            {t('evolutionDiary')}
          </h3>
          {round?.diary.available && round.diary.items.length > 0 ? (
            <ul className="space-y-2">
              {round.diary.items.map((entry) => (
                <li key={entry.exec_id} className="rounded-md bg-surface-sunken px-2 py-1.5">
                  <strong className="block font-mono text-xs">{entry.exec_id}</strong>
                  <span className="text-sm">{entry.tldr ?? t('evolutionNoTldr')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t('evolutionDiaryUnavailable')}</p>
          )}
        </section>
      ) : null}
      {section === 'verify' ? (
        <section aria-labelledby="evolution-verify-heading" data-testid="evolution-verify">
          <h3 id="evolution-verify-heading" className="mb-1 flex items-center gap-2 text-sm font-medium">
            {core.verify_available ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <CircleDashed className="size-4" aria-hidden="true" />}
            {t('evolutionVerify')}
          </h3>
          {core.verify_available ? (
            <p className="text-sm">
              {t('evolutionVerifyConclusion')}: {core.verify_semantic_status ?? '—'}
              {core.verified_count != null ? ` · ${core.verified_count}` : ''}
              {core.pending_count != null ? ` / ${core.pending_count}` : ''}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('evolutionVerifyUnavailable')}</p>
          )}
        </section>
      ) : null}
      {section === 'evidence' ? (
        <section aria-labelledby="evolution-evidence-heading" data-testid="evolution-evidence">
          <h3 id="evolution-evidence-heading" className="mb-1 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" aria-hidden="true" />
            {t('evolutionEvidence')}
          </h3>
          <p className="text-sm">
            {t('evolutionReceipts')}: {core.receipt_count}
            {core.attention_count != null ? ` · ${t('evolutionAttention')}: ${core.attention_count}` : ''}
          </p>
          {core.blockers.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-status-error">
              {core.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {detail?.blockers.length || round?.blockers.length ? t('evolutionBlockers') : t('evolutionNoBlockers')}
            </p>
          )}
        </section>
      ) : null}
    </div>
  )
}

function sectionLabel(id: SectionId, translate: (key: MessageKey) => string) {
  if (id === 'report') return translate('evolutionReport')
  if (id === 'diary') return translate('evolutionDiary')
  if (id === 'verify') return translate('evolutionVerify')
  return translate('evolutionEvidence')
}

function emptyCopy(state: InspectorSafeState, translate: (key: MessageKey) => string) {
  if (state === 'no-subject') return translate('evolutionNoSubject')
  if (state === 'loading') return translate('evolutionLoading')
  if (state === 'error') return translate('evolutionLoadError')
  if (state === 'stale') return translate('evolutionStale')
  if (state === 'offline') return translate('evolutionOffline')
  if (state === 'malformed') return translate('evolutionMalformed')
  return translate('evolutionNoCycles')
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace('T', ' ').slice(0, 16)
}

function stepTone(status: string): string {
  if (status === 'done') return 'bg-status-ok/15 text-status-ok'
  if (status === 'running') return 'bg-status-warn/15 text-status-warn'
  if (status === 'failed') return 'bg-status-error/15 text-status-error'
  return 'bg-muted text-muted-foreground'
}
