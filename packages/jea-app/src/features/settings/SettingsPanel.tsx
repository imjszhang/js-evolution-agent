import { useEffect, useState } from 'react'
import { useLocale } from '../../i18n/LocaleProvider'
import type { Locale } from '../../i18n/messages'
import { Button } from '../../ui/button'
import { useTheme, type ThemePreference } from '../../theme/ThemeProvider'
import { useJeaClientContext } from '../client-context'
import {
  DOCS_HOME_URL,
  FIRST_RUN_DOCS_URL,
  LICENSE_URL,
  languageToLocale,
  localeToLanguage,
  publicErrorMessage,
  type CliStatus,
  type DiagnosticReport,
  type SettingsView,
  type SetupReadiness,
  type SubjectReadiness
} from '../client-types'
import type { EvolutionCycleList, EvolutionObservability } from '../evolution/types'
import { formatLlmBudgetBlocker, isLlmBudgetBlocker } from '../llm-budget-display'
import { projectEvolutionSummary, projectOperatorSurface } from '../operator-projection'
import { ReactorProgressPanel } from '../evolution/ReactorProgressPanel'
import { schedulerStateMessageKey } from '../evolution/reactor-progress-copy'
import { createFixtureDiagnosticReport, createReadyReadiness, createSetupFixtureState } from '../fixtures'

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium" data-testid={testId}>{value}</span>
    </div>
  )
}

function evolutionRuntimeLabel(
  t: (key: import('../../i18n/messages').MessageKey) => string,
  runtime: { mode?: string; intent?: string; remaining_evidence?: number | null; blocker?: string | null } | null
): string {
  if (!runtime) return '—'
  if (runtime.mode === 'paused' || runtime.intent === 'paused') return t('evolutionAutomaticPaused')
  if (runtime.intent === 'catching_up') {
    const remaining = runtime.remaining_evidence ?? 0
    return remaining > 0 ? `${t('evolutionCatchingUp')}: ${remaining}` : t('evolutionCatchingUp')
  }
  if (runtime.blocker && (runtime.intent === 'blocked' || runtime.intent === 'paused_budget')) {
    return `${t(schedulerStateMessageKey(runtime.intent as 'blocked' | 'paused_budget'))}: ${runtime.blocker}`
  }
  return t(schedulerStateMessageKey(runtime.intent as 'listening'))
}

function modelLabel(
  t: (key: 'runtimeModelMock' | 'runtimeModelDeepseek' | 'runtimeModelUnset') => string,
  mode: SetupReadiness['model']['mode']
): string {
  if (mode === 'deepseek') return t('runtimeModelDeepseek')
  if (mode === 'unset') return t('runtimeModelUnset')
  return t('runtimeModelMock')
}

export function SettingsPanel({
  settings: settingsProp,
  readiness: readinessProp,
  cli: cliProp,
  diagnostics: diagnosticsProp,
  subjectReadiness: subjectReadinessProp,
  observability: observabilityProp,
  cycleList: cycleListProp
}: {
  settings?: SettingsView
  readiness?: SetupReadiness
  cli?: CliStatus
  diagnostics?: DiagnosticReport
  subjectReadiness?: SubjectReadiness
  observability?: EvolutionObservability
  cycleList?: EvolutionCycleList
} = {}) {
  const { t, locale, setLocale } = useLocale()
  const { preference, setPreference } = useTheme()
  const { client, host } = useJeaClientContext()
  const [settings, setSettings] = useState<SettingsView | null>(settingsProp ?? null)
  const [readiness, setReadiness] = useState<SetupReadiness | null>(readinessProp ?? null)
  const [cli, setCli] = useState<CliStatus | null>(cliProp ?? null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(diagnosticsProp ?? null)
  const [subjectReadiness, setSubjectReadiness] = useState<SubjectReadiness | null>(subjectReadinessProp ?? null)
  const [observability, setObservability] = useState<EvolutionObservability | null>(observabilityProp ?? null)
  const [cycleList, setCycleList] = useState<EvolutionCycleList | null>(cycleListProp ?? null)
  const [exported, setExported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void Promise.all([
      client.getSettings(),
      client.getReadiness(),
      client.getCliStatus(),
      client.exportDiagnostics ? client.exportDiagnostics({ redactPaths: true }) : Promise.resolve(null)
    ])
      .then(([nextSettings, nextReadiness, nextCli, nextDiagnostics]) => {
        if (cancelled) return
        setSettings(nextSettings)
        setReadiness(nextReadiness)
        setCli(nextCli)
        if (nextDiagnostics) setDiagnostics(nextDiagnostics)
        if (languageToLocale(nextSettings.language) !== locale) {
          setLocale(languageToLocale(nextSettings.language))
        }
        if (nextSettings.theme !== preference) {
          setPreference(nextSettings.theme)
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(publicErrorMessage(caught, t('errorBody')))
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const projectionSubject = settings?.defaultSubject
    ?? settingsProp?.defaultSubject
    ?? readiness?.subjects.defaultSubject
    ?? readinessProp?.subjects.defaultSubject
    ?? null

  useEffect(() => {
    if (!client || !projectionSubject) return
    let cancelled = false
    setSubjectReadiness(null)
    setObservability(null)
    setCycleList(null)
    void Promise.all([
      client.getServiceReadiness?.(projectionSubject) ?? Promise.resolve(null),
      client.getObservability?.(projectionSubject) ?? Promise.resolve(null),
      client.listCycles?.(projectionSubject, 50) ?? Promise.resolve(null)
    ]).then(([nextSubjectReadiness, nextObservability, nextCycleList]) => {
      if (cancelled) return
      if (nextSubjectReadiness) setSubjectReadiness(nextSubjectReadiness)
      if (nextObservability) setObservability(nextObservability)
      if (nextCycleList) setCycleList(nextCycleList)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, projectionSubject])

  const report = diagnostics ?? diagnosticsProp ?? createFixtureDiagnosticReport({
    readiness: readiness ?? readinessProp ?? createReadyReadiness(cli ?? undefined),
    settings: settings ?? settingsProp ?? {
      language: localeToLanguage(locale),
      theme: preference,
      defaultSubject: readinessProp?.subjects.defaultSubject ?? 'alpha',
      appVersion: '0.3.0',
      cliVersion: '0.3.0'
    },
    subjects: (readiness ?? readinessProp)?.subjects.names.map((name) => ({
      name,
      namespace: `${name}-data`,
      isDefault: name === (readiness ?? readinessProp)?.subjects.defaultSubject
    })) ?? [],
    cli: cli ?? cliProp ?? createReadyReadiness(cli ?? undefined).cli
  })

  const view = settings ?? settingsProp ?? {
    language: localeToLanguage(locale),
    theme: preference,
    defaultSubject: readinessProp?.subjects.defaultSubject ?? 'alpha',
    appVersion: '0.3.0',
    cliVersion: '0.3.0',
    commitShort: null,
    buildTime: null,
    platform: undefined,
    architecture: undefined
  }
  const runtime = readiness ?? readinessProp ?? createReadyReadiness(cli ?? undefined)
  const cliView = cli ?? cliProp ?? runtime.cli
  const webNativeOnly = host === 'web'
  const canManageCli = !webNativeOnly && cliView.supported
  const selectedSubject = projectionSubject
  const operatorProjection = subjectReadiness && observability && cycleList
    ? projectOperatorSurface({
        readiness: subjectReadiness,
        observability,
        host,
        evolution: projectEvolutionSummary(cycleList, observability)
      })
    : null
  const allowed = new Set(operatorProjection?.allowed_remediation_actions.map((action) => action.id) ?? [])
  const productAllowed = new Set((
    operatorProjection?.product_actions ?? subjectReadiness?.product_actions ?? []
  ).filter((action) => action.allowed).map((action) => action.id))

  async function persist(patch: { language?: SettingsView['language']; theme?: ThemePreference; defaultSubject?: string }) {
    if (!client) {
      if (patch.language) setLocale(languageToLocale(patch.language))
      if (patch.theme) setPreference(patch.theme)
      setSettings({ ...view, ...patch })
      return
    }
    setBusy('settings')
    setError(null)
    try {
      const next = await client.setSettings(patch)
      setSettings(next)
      setLocale(languageToLocale(next.language))
      setPreference(next.theme)
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  async function exportReport() {
    if (!client?.exportDiagnostics) {
      setDiagnostics(diagnostics ?? createFixtureDiagnosticReport(createSetupFixtureState({ kind: 'ready' })))
      setExported(true)
      return
    }
    setBusy('diagnostics')
    setError(null)
    try {
      const report = await client.exportDiagnostics({ redactPaths: true })
      setDiagnostics(report)
      setExported(true)
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  async function runCli(action: 'install' | 'uninstall') {
    if (!client || !canManageCli) return
    setBusy(action)
    setError(null)
    try {
      const next = action === 'install' ? await client.installCli() : await client.uninstallCli()
      setCli(next)
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  async function runProduct(action: 'pause' | 'resume' | 'check') {
    if (!client || !selectedSubject) return
    setBusy(action)
    setError(null)
    try {
      if (action === 'pause' && client.setAutomation) {
        await client.setAutomation(selectedSubject, 'paused')
      } else if (action === 'resume' && client.setAutomation) {
        await client.setAutomation(selectedSubject, 'automatic')
      } else if (action === 'check' && client.processCycleOnce) {
        const result = await client.processCycleOnce(selectedSubject)
        if (result.status === 'retryable' || result.status === 'blocked') {
          throw new Error(result.reason || t('evolutionCheckNowFailed'))
        }
      }
      if (client.getServiceReadiness) setSubjectReadiness(await client.getServiceReadiness(selectedSubject))
      if (client.getObservability) setObservability(await client.getObservability(selectedSubject))
      if (client.listCycles) setCycleList(await client.listCycles(selectedSubject, 50))
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  async function runAdvanced(action: 'process' | 'start') {
    if (!client || !selectedSubject) return
    setBusy(action)
    setError(null)
    try {
      if (action === 'process' && client.processCycleOnce) {
        const result = await client.processCycleOnce(selectedSubject)
        if (result.status === 'retryable' || result.status === 'blocked') {
          throw new Error(result.reason || t('evolutionProcessOnceFailed'))
        }
      } else if (action === 'start' && client.startService && !webNativeOnly) {
        await client.startService(selectedSubject, 'cycle')
      }
      if (client.getServiceReadiness) setSubjectReadiness(await client.getServiceReadiness(selectedSubject))
      if (client.getObservability) setObservability(await client.getObservability(selectedSubject))
      if (client.listCycles) setCycleList(await client.listCycles(selectedSubject, 50))
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-8" data-slot="settings" data-testid="settings-panel">
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="settings-error">{error}</p>
      ) : null}

      <section aria-labelledby="jea-settings-general" data-testid="settings-general" className="space-y-3">
        <h3 id="jea-settings-general" className="text-sm font-semibold">{t('settingsGeneral')}</h3>
        <p className="text-sm text-muted-foreground">{t('settingsGeneralBody')}</p>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('settingsLanguageCommand')}</p>
          <div className="flex flex-wrap gap-2">
            {(['en', 'zh'] as Locale[]).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={languageToLocale(view.language) === value ? 'default' : 'outline'}
                aria-pressed={languageToLocale(view.language) === value}
                data-testid={`settings-language-${value}`}
                disabled={busy === 'settings'}
                onClick={() => void persist({ language: localeToLanguage(value) })}
              >
                {value === 'en' ? t('languageEnglish') : t('languageChinese')}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('settingsThemeCommand')}</p>
          <div className="flex flex-wrap gap-2">
            {(['system', 'light', 'dark'] as ThemePreference[]).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={view.theme === value ? 'default' : 'outline'}
                aria-pressed={view.theme === value}
                data-testid={`settings-theme-${value}`}
                disabled={busy === 'settings'}
                onClick={() => void persist({ theme: value })}
              >
                {value === 'system' ? t('themeSystem') : value === 'light' ? t('themeLight') : t('themeDark')}
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('settingsDefaultSubject')}</p>
          {runtime.subjects.names.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('settingsNoSubject')}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {runtime.subjects.names.map((name) => (
                <Button
                  key={name}
                  size="sm"
                  variant={view.defaultSubject === name ? 'default' : 'outline'}
                  aria-pressed={view.defaultSubject === name}
                  data-testid={`settings-default-subject-${name}`}
                  disabled={busy === 'settings'}
                  onClick={() => void persist({ defaultSubject: name })}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="jea-settings-runtime" data-testid="settings-runtime" className="space-y-3">
        <h3 id="jea-settings-runtime" className="text-sm font-semibold">{t('settingsRuntime')}</h3>
        <p className="text-sm text-muted-foreground">{t('settingsRuntimeBody')}</p>
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          <Row label={t('runtimeHome')} value={runtime.jeaHome.path} testId="settings-home-path" />
          <Row
            label={t('runtimeWritable')}
            value={runtime.jeaHome.writable ? t('runtimeWritable') : t('runtimeReadOnly')}
            testId="settings-home-writable"
          />
          <Row
            label={t('runtimeModel')}
            value={modelLabel(t, runtime.model.mode)}
            testId="settings-model-mode"
          />
          <Row
            label={t('runtimeData')}
            value={runtime.data.initialized ? t('runtimeDataReady') : t('runtimeDataPending')}
          />
          <Row
            label={t('runtimeConversation')}
            value={runtime.conversation.desktopChannelEnabled ? t('runtimeConversationReady') : t('runtimeConversationBlocked')}
            testId="settings-conversation-ready"
          />
          <Row
            label={t('evolutionAutomaticRunning').split(':')[0]}
            value={evolutionRuntimeLabel(t, operatorProjection?.evolution_runtime ?? subjectReadiness?.automation ?? null)}
            testId="settings-evolution-runtime"
          />
        </div>
        <ReactorProgressPanel
          readiness={subjectReadiness}
          observability={observability}
          host={host}
          client={client}
          onRefresh={async () => {
            if (!client || !selectedSubject) return
            if (client.getServiceReadiness) setSubjectReadiness(await client.getServiceReadiness(selectedSubject))
            if (client.getObservability) setObservability(await client.getObservability(selectedSubject))
            if (client.listCycles) setCycleList(await client.listCycles(selectedSubject, 50))
          }}
        />
        <div className="flex flex-wrap gap-2" data-testid="settings-evolution-actions">
          {productAllowed.has('pause_automatic_evolution') && client?.setAutomation && selectedSubject ? (
            <Button
              size="sm"
              data-testid="settings-pause-evolution"
              disabled={Boolean(busy)}
              onClick={() => void runProduct('pause')}
            >
              {t('evolutionPause')}
            </Button>
          ) : null}
          {productAllowed.has('resume_automatic_evolution') && client?.setAutomation && selectedSubject ? (
            <Button
              size="sm"
              data-testid="settings-resume-evolution"
              disabled={Boolean(busy)}
              onClick={() => void runProduct('resume')}
            >
              {t('evolutionResume')}
            </Button>
          ) : null}
          {productAllowed.has('check_now') && client?.processCycleOnce && selectedSubject ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="settings-check-now"
              disabled={Boolean(busy)}
              onClick={() => void runProduct('check')}
            >
              {t('evolutionCheckNow')}
            </Button>
          ) : null}
          {productAllowed.has('view_blocker') && (operatorProjection?.evolution_runtime.blocker || subjectReadiness?.automation?.blocker || subjectReadiness?.llm_budget?.state === 'exhausted') ? (
            <div className="space-y-1" data-testid="settings-view-blocker">
              <p className="text-sm text-foreground">
                {t('evolutionBlocked')}: {formatLlmBudgetBlocker(
                  operatorProjection?.evolution_runtime.blocker ?? subjectReadiness?.automation?.blocker,
                  subjectReadiness?.llm_budget,
                ) ?? operatorProjection?.evolution_runtime.blocker ?? subjectReadiness?.automation?.blocker}
              </p>
              {subjectReadiness?.llm_budget && isLlmBudgetBlocker(
                operatorProjection?.evolution_runtime.blocker ?? subjectReadiness?.automation?.blocker ?? subjectReadiness.llm_budget.blocked_reason,
              ) ? (
                <p className="text-xs text-muted-foreground" data-testid="settings-llm-budget-recover">
                  {t('evolutionBudgetRecover')}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="jea-settings-cli" data-testid="settings-cli" className="space-y-3">
        <h3 id="jea-settings-cli" className="text-sm font-semibold">{t('settingsCli')}</h3>
        <p className="text-sm text-muted-foreground">{t('settingsCliBody')}</p>
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          <Row
            label={t('cliInstalled')}
            value={cliView.installed ? t('cliInstalled') : t('cliNotInstalled')}
            testId="settings-cli-installed"
          />
          <Row
            label={t('cliOnPath')}
            value={cliView.onPath ? t('cliOnPath') : t('cliNotOnPath')}
            testId="settings-cli-onpath"
          />
          <Row label={t('cliPathHint')} value={cliView.pathHint} testId="settings-cli-path-hint" />
          {cliView.detail ? <p className="text-sm text-muted-foreground">{cliView.detail}</p> : null}
        </div>
        {webNativeOnly ? (
          <p className="text-sm text-muted-foreground" data-testid="settings-cli-native-only">{t('cliNativeOnly')}</p>
        ) : canManageCli ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="settings-cli-install"
              disabled={Boolean(busy) || cliView.installed}
              onClick={() => void runCli('install')}
            >
              {t('cliInstall')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="settings-cli-uninstall"
              disabled={Boolean(busy) || !cliView.installed}
              onClick={() => void runCli('uninstall')}
            >
              {t('cliUninstall')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="settings-cli-unsupported">{t('cliUnsupported')}</p>
        )}
      </section>

      <section aria-labelledby="jea-settings-about" data-testid="settings-about" className="space-y-3">
        <h3 id="jea-settings-about" className="text-sm font-semibold">{t('settingsAbout')}</h3>
        <p className="text-sm text-muted-foreground">{t('settingsAboutBody')}</p>
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          <Row label={t('aboutAppVersion')} value={view.appVersion} testId="settings-app-version" />
          <Row label={t('aboutCliVersion')} value={view.cliVersion} testId="settings-cli-version" />
          <Row label={t('aboutCommit')} value={view.commitShort || view.commitSha || '—'} testId="settings-commit" />
          <Row label={t('aboutBuildTime')} value={view.buildTime || '—'} testId="settings-build-time" />
          <Row
            label={t('aboutPlatform')}
            value={view.platform && view.architecture ? `${view.platform}/${view.architecture}` : (view.platform || '—')}
            testId="settings-platform"
          />
          <Row label={t('runtimeHome')} value={runtime.jeaHome.path} testId="settings-about-home" />
          <Row
            label={t('aboutSubject')}
            value={view.defaultSubject || runtime.subjects.defaultSubject || '—'}
            testId="settings-about-subject"
          />
          <Row label={t('aboutDataLocation')} value={runtime.jeaHome.path} testId="settings-data-location" />
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <a className="underline" href={LICENSE_URL} target="_blank" rel="noreferrer">{t('aboutLicense')}</a>
          <a className="underline" href={DOCS_HOME_URL} target="_blank" rel="noreferrer">{t('aboutDocumentation')}</a>
          <a className="underline" href={FIRST_RUN_DOCS_URL} target="_blank" rel="noreferrer">{t('aboutFirstRun')}</a>
        </div>
      </section>

      <section aria-labelledby="jea-settings-diagnostics" data-testid="settings-diagnostics" className="space-y-3">
        <h3 id="jea-settings-diagnostics" className="text-sm font-semibold">{t('settingsDiagnostics')}</h3>
        <p className="text-sm text-muted-foreground">{t('settingsDiagnosticsBody')}</p>
        <div className="space-y-2 rounded-md border border-border bg-surface-sunken p-3">
          {subjectReadiness?.upgrade ? (
            <div data-testid="settings-diagnostics-upgrade" className="space-y-1">
              <Row
                label={t('diagnosticsUpgrade')}
                value={subjectReadiness.upgrade.phase}
              />
              <p className="text-xs text-muted-foreground" data-testid="settings-diagnostics-upgrade-reasons">
                {t('diagnosticsReasons')}: {[
                  subjectReadiness.upgrade.ready ? 'ready' : 'cycle_blocked',
                  subjectReadiness.upgrade.channel_available ? 'channel_available' : null,
                  subjectReadiness.upgrade.operator_action,
                  subjectReadiness.upgrade.reason,
                ].filter(Boolean).join('; ')}
              </p>
            </div>
          ) : null}
          {(['web', 'cycle', 'channel', 'model', 'conversation'] as const).map((id) => {
            const domain = report.readiness[id]
            const label = id === 'web'
              ? t('diagnosticsWeb')
              : id === 'cycle'
                ? t('diagnosticsCycle')
                : id === 'channel'
                  ? t('diagnosticsChannel')
                  : id === 'model'
                    ? t('diagnosticsModel')
                    : t('diagnosticsConversation')
            return (
              <div key={id} data-testid={`settings-diagnostics-${id}`} className="space-y-1">
                <Row label={label} value={domain?.status ?? 'unavailable'} />
                {domain?.reasons?.length ? (
                  <p className="text-xs text-muted-foreground" data-testid={`settings-diagnostics-${id}-reasons`}>
                    {t('diagnosticsReasons')}: {domain.reasons.join('; ')}
                  </p>
                ) : null}
              </div>
            )
          })}
          {report.daemon.last_startup_failure ? (
            <div data-testid="settings-diagnostics-startup-failure" className="space-y-1">
              <Row label={t('diagnosticsStartupFailure')} value={report.daemon.last_startup_failure.reason} />
              <p className="text-xs text-muted-foreground">
                {t('diagnosticsDaemonLogs')}: {report.daemon.last_startup_failure.log_paths.stdout}; {report.daemon.last_startup_failure.log_paths.stderr}
              </p>
            </div>
          ) : report.daemon.log_paths ? (
            <p className="text-xs text-muted-foreground" data-testid="settings-diagnostics-log-paths">
              {t('diagnosticsDaemonLogs')}: {report.daemon.log_paths.stdout}; {report.daemon.log_paths.stderr}
            </p>
          ) : null}
          <div data-testid="settings-diagnostics-process-failures">
            {report.process_failures?.length ? (
              report.process_failures.map((item, index) => (
                <Row
                  key={`${item.occurred_at}-${index}`}
                  label={t('diagnosticsProcessFailures')}
                  value={`${item.process_type} ${item.reason} ${item.version}`}
                />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{t('diagnosticsNoFailures')}</p>
            )}
          </div>
        </div>
        <Button
          size="sm"
          data-testid="settings-export-diagnostics"
          disabled={busy === 'diagnostics'}
          onClick={() => void exportReport()}
        >
          {t('diagnosticsExport')}
        </Button>
        {exported ? (
          <p className="text-sm text-muted-foreground" data-testid="settings-diagnostics-exported">{t('diagnosticsExported')}</p>
        ) : null}
        <details data-testid="settings-advanced-diagnostics" className="rounded-md border border-border bg-surface-sunken p-3">
          <summary className="cursor-pointer text-sm font-medium">{t('settingsAdvancedDiagnostics')}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">{t('settingsAdvancedDiagnosticsBody')}</p>
            <Row
              label={t('evolutionPendingEvidence')}
              value={String(operatorProjection?.evidence_pending.count ?? 0)}
              testId="settings-pending-evidence"
            />
            <Row
              label={t('evolutionRounds')}
              value={String(operatorProjection?.evolution_summary.roundCount ?? 0)}
              testId="settings-evolution-rounds"
            />
            <Row
              label={t('evolutionOpenCycles')}
              value={String(operatorProjection?.evolution_summary.openCycles ?? 0)}
              testId="settings-evolution-open-cycles"
            />
            <Row
              label={t('evolutionLatestStatus')}
              value={operatorProjection?.evolution_summary.latestStatus ?? '—'}
              testId="settings-evolution-latest-status"
            />
            <Row
              label={t('evolutionLatestSummary')}
              value={operatorProjection?.evolution_summary.latestTldr ?? '—'}
              testId="settings-evolution-latest-summary"
            />
            <Row
              label={t('diagnosticsDaemonTasks')}
              value={String(operatorProjection?.daemon_task_pending.count ?? 0)}
              testId="settings-daemon-queue-pending"
            />
            <div className="flex flex-wrap gap-2">
              {allowed.has('process_cycle_once') && client?.processCycleOnce ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="settings-process-cycle-once"
                  disabled={Boolean(busy)}
                  onClick={() => void runAdvanced('process')}
                >
                  {busy === 'process' ? t('evolutionProcessingOnce') : t('evolutionProcessOnce')}
                </Button>
              ) : null}
              {!webNativeOnly && allowed.has('start_cycle') && client?.startService ? (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="settings-start-cycle"
                  disabled={Boolean(busy)}
                  onClick={() => void runAdvanced('start')}
                >
                  {busy === 'start' ? t('evolutionStartingCycle') : t('evolutionStartCycle')}
                </Button>
              ) : null}
            </div>
            {webNativeOnly && subjectReadiness?.allowed_actions.includes('open_desktop') ? (
              <p className="text-sm text-muted-foreground" data-testid="settings-advanced-open-desktop">
                {t('openDesktopRecovery')}
              </p>
            ) : null}
          </div>
        </details>
      </section>
    </div>
  )
}
