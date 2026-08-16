import { useState } from 'react'
import { useLocale } from '../../i18n/LocaleProvider'
import { Button } from '../../ui/button'
import { publicErrorMessage, type SetupReadiness, type SetupSettingsClient } from '../client-types'
import { allowsMockCompletion, resolveSetupStep } from '../readiness'

const SUBJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function SetupFlow({
  client,
  readiness,
  onReadinessChange,
  onComplete
}: {
  client: SetupSettingsClient
  readiness: SetupReadiness
  onReadinessChange(next: SetupReadiness): void
  onComplete(): void
}) {
  const { t } = useLocale()
  const [homeConfirmed, setHomeConfirmed] = useState(readiness.subjects.count > 0 && readiness.jeaHome.writable)
  const [homePath, setHomePath] = useState(readiness.jeaHome.path)
  const [subjectName, setSubjectName] = useState(readiness.conversation.subject ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const step = resolveSetupStep(readiness, { homeConfirmed })
  const resume = readiness.subjects.count > 0 && !readiness.conversationReady

  async function refresh(subject?: string): Promise<SetupReadiness> {
    const next = await client.getReadiness(subject)
    onReadinessChange(next)
    return next
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(publicErrorMessage(caught, t('errorBody')))
    } finally {
      setBusy(false)
    }
  }

  const title = {
    home: t('setupHomeTitle'),
    subject: readiness.subjects.count > 0 ? t('setupUseExistingTitle') : t('setupSubjectTitle'),
    init: t('setupInitTitle'),
    channel: t('setupChannelTitle'),
    ready: t('setupTitle')
  }[step]

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="setup-flow" data-setup-step={step}>
      <header className="border-b border-border bg-surface px-6 py-4">
        <strong className="block text-sm">{t('appName')}</strong>
        <span className="block text-xs text-muted-foreground">{t('setupTagline')}</span>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-6 py-10">
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('setupTitle')}</p>
          <h1 className="text-2xl font-semibold">{title}</h1>
        </div>
        {resume ? <p className="text-sm text-muted-foreground" data-testid="setup-resume-hint">{t('setupResumeHint')}</p> : null}
        <p className="text-sm text-muted-foreground" data-testid="setup-model-banner">
          {allowsMockCompletion(readiness) ? t('setupModelMock') : t('setupModelReady')}
        </p>
        {error ? <p className="text-sm text-destructive" role="alert" data-testid="setup-error">{error}</p> : null}

        {step === 'home' ? (
          <HomeStep
            path={homePath}
            writable={readiness.jeaHome.writable}
            busy={busy}
            onPathChange={setHomePath}
            onConfirm={() => void run(async () => {
              const home = await client.confirmHome(homePath)
              setHomePath(home.path)
              setHomeConfirmed(true)
              await refresh()
            })}
          />
        ) : null}

        {step === 'subject' ? (
          readiness.subjects.count > 0 ? (
            <ExistingSubjectStep
              names={readiness.subjects.names}
              selected={readiness.conversation.subject ?? readiness.subjects.defaultSubject}
              busy={busy}
              onContinue={() => void run(async () => {
                const selected = readiness.conversation.subject ?? readiness.subjects.names[0]
                if (selected) await client.setSettings({ defaultSubject: selected })
                await refresh(selected ?? undefined)
              })}
            />
          ) : (
            <CreateSubjectStep
              name={subjectName}
              busy={busy}
              onNameChange={setSubjectName}
              onCreate={() => void run(async () => {
                if (!SUBJECT_PATTERN.test(subjectName.trim())) {
                  throw Object.assign(new Error(t('setupSubjectName')), { name: 'PublicCommandError', code: 'INVALID_REQUEST' })
                }
                const created = await client.createSubject(subjectName.trim(), { enableDesktopChannel: true })
                setSubjectName(created.name)
                await refresh(created.name)
              })}
            />
          )
        ) : null}

        {step === 'init' ? (
          <InitStep
            subject={readiness.conversation.subject ?? readiness.subjects.defaultSubject}
            busy={busy}
            onInit={() => void run(async () => {
              const subject = readiness.conversation.subject ?? readiness.subjects.names[0]
              if (!subject) return
              await client.initData(subject)
              const next = await refresh(subject)
              if (next.conversationReady) onComplete()
            })}
          />
        ) : null}

        {step === 'channel' ? (
          <ChannelStep
            subject={readiness.conversation.subject ?? readiness.subjects.defaultSubject}
            busy={busy}
            onEnable={() => void run(async () => {
              const subject = readiness.conversation.subject ?? readiness.subjects.names[0]
              if (!subject) return
              await client.enableDesktopChannel(subject)
              const next = await refresh(subject)
              if (next.conversationReady) onComplete()
            })}
          />
        ) : null}

        {step === 'ready' ? (
          <div className="space-y-4" data-testid="setup-step-ready">
            <Button data-testid="setup-enter-workspace" onClick={onComplete}>{t('setupEnterWorkspace')}</Button>
          </div>
        ) : null}
      </main>
    </div>
  )
}

function HomeStep({
  path,
  writable,
  busy,
  onPathChange,
  onConfirm
}: {
  path: string
  writable: boolean
  busy: boolean
  onPathChange(value: string): void
  onConfirm(): void
}) {
  const { t } = useLocale()
  return (
    <section className="space-y-4" data-testid="setup-step-home">
      <p className="text-sm text-muted-foreground">{t('setupHomeBody')}</p>
      <label className="block space-y-2 text-sm">
        <span>{t('setupHomePath')}</span>
        <input
          data-testid="setup-home-path"
          className="w-full rounded-md border border-input bg-surface-raised px-3 py-2"
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground" data-testid="setup-home-writable">
        {writable ? t('runtimeWritable') : t('runtimeReadOnly')}
      </p>
      <Button data-testid="setup-confirm-home" disabled={busy || !path.trim()} onClick={onConfirm}>
        {busy ? t('setupBusy') : t('setupConfirmHome')}
      </Button>
    </section>
  )
}

function CreateSubjectStep({
  name,
  busy,
  onNameChange,
  onCreate
}: {
  name: string
  busy: boolean
  onNameChange(value: string): void
  onCreate(): void
}) {
  const { t } = useLocale()
  return (
    <section className="space-y-4" data-testid="setup-step-subject">
      <p className="text-sm text-muted-foreground">{t('setupSubjectBody')}</p>
      <label className="block space-y-2 text-sm">
        <span>{t('setupSubjectName')}</span>
        <input
          data-testid="setup-subject-name"
          className="w-full rounded-md border border-input bg-surface-raised px-3 py-2"
          value={name}
          placeholder={t('setupSubjectPlaceholder')}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <Button data-testid="setup-create-subject" disabled={busy || !SUBJECT_PATTERN.test(name.trim())} onClick={onCreate}>
        {busy ? t('setupBusy') : t('setupCreateSubject')}
      </Button>
    </section>
  )
}

function ExistingSubjectStep({
  names,
  selected,
  busy,
  onContinue
}: {
  names: string[]
  selected: string | null
  busy: boolean
  onContinue(): void
}) {
  const { t } = useLocale()
  return (
    <section className="space-y-4" data-testid="setup-step-existing">
      <p className="text-sm text-muted-foreground">{t('setupUseExistingBody')}</p>
      <ul className="space-y-1 text-sm">
        {names.map((name) => (
          <li key={name} className={name === selected ? 'font-medium' : 'text-muted-foreground'}>{name}</li>
        ))}
      </ul>
      <Button data-testid="setup-continue-existing" disabled={busy} onClick={onContinue}>
        {busy ? t('setupBusy') : t('setupContinueExisting')}
      </Button>
    </section>
  )
}

function InitStep({
  subject,
  busy,
  onInit
}: {
  subject: string | null
  busy: boolean
  onInit(): void
}) {
  const { t } = useLocale()
  return (
    <section className="space-y-4" data-testid="setup-step-init">
      <p className="text-sm text-muted-foreground">{t('setupInitBody')}</p>
      {subject ? <p className="text-sm font-medium">{subject}</p> : null}
      <Button data-testid="setup-init-data" disabled={busy || !subject} onClick={onInit}>
        {busy ? t('setupBusy') : t('setupInitAction')}
      </Button>
    </section>
  )
}

function ChannelStep({
  subject,
  busy,
  onEnable
}: {
  subject: string | null
  busy: boolean
  onEnable(): void
}) {
  const { t } = useLocale()
  return (
    <section className="space-y-4" data-testid="setup-step-channel">
      <p className="text-sm text-muted-foreground">{t('setupChannelBody')}</p>
      <p className="rounded-md border border-border bg-surface-sunken p-3 text-sm" data-testid="setup-channel-impact">
        {t('setupChannelImpact')}
      </p>
      {subject ? <p className="text-sm font-medium">{subject}</p> : null}
      <Button data-testid="setup-enable-channel" disabled={busy || !subject} onClick={onEnable}>
        {busy ? t('setupBusy') : t('setupEnableChannel')}
      </Button>
    </section>
  )
}

