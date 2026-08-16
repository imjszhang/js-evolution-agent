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
  type SettingsView,
  type SetupReadiness
} from '../client-types'
import { createReadyReadiness } from '../fixtures'

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium" data-testid={testId}>{value}</span>
    </div>
  )
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
  cli: cliProp
}: {
  settings?: SettingsView
  readiness?: SetupReadiness
  cli?: CliStatus
} = {}) {
  const { t, locale, setLocale } = useLocale()
  const { preference, setPreference } = useTheme()
  const { client, host } = useJeaClientContext()
  const [settings, setSettings] = useState<SettingsView | null>(settingsProp ?? null)
  const [readiness, setReadiness] = useState<SetupReadiness | null>(readinessProp ?? null)
  const [cli, setCli] = useState<CliStatus | null>(cliProp ?? null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void Promise.all([client.getSettings(), client.getReadiness(), client.getCliStatus()])
      .then(([nextSettings, nextReadiness, nextCli]) => {
        if (cancelled) return
        setSettings(nextSettings)
        setReadiness(nextReadiness)
        setCli(nextCli)
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

  const view = settings ?? settingsProp ?? {
    language: localeToLanguage(locale),
    theme: preference,
    defaultSubject: readinessProp?.subjects.defaultSubject ?? 'alpha',
    appVersion: '0.1.0',
    cliVersion: '0.1.0'
  }
  const runtime = readiness ?? readinessProp ?? createReadyReadiness(cli ?? undefined)
  const cliView = cli ?? cliProp ?? runtime.cli
  const webNativeOnly = host === 'web'
  const canManageCli = !webNativeOnly && cliView.supported

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
          <Row label={t('aboutDataLocation')} value={runtime.jeaHome.path} testId="settings-data-location" />
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <a className="underline" href={LICENSE_URL} target="_blank" rel="noreferrer">{t('aboutLicense')}</a>
          <a className="underline" href={DOCS_HOME_URL} target="_blank" rel="noreferrer">{t('aboutDocumentation')}</a>
          <a className="underline" href={FIRST_RUN_DOCS_URL} target="_blank" rel="noreferrer">{t('aboutFirstRun')}</a>
        </div>
      </section>
    </div>
  )
}
