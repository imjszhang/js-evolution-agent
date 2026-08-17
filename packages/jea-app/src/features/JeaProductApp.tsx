import { useEffect, useMemo, useState } from 'react'
import { JeaApp, type JeaAppProps } from '../JeaApp'
import { LocaleProvider } from '../i18n/LocaleProvider'
import type { ShellAdapters } from '../slots/types'
import { ThemeProvider } from '../theme/ThemeProvider'
import { JeaClientProvider } from './client-context'
import type { ProductHostKind, SetupReadiness, SetupSettingsClient, SubjectSummary } from './client-types'
import { withDefaultProductFeatures } from './product-features'
import { isConversationReady } from './readiness'
import { deriveServiceStatusKind } from './service-status/derive'
import { SetupFlow } from './setup/SetupFlow'
import { useLiveSubjectReadiness } from './useLiveSubjectReadiness'

export interface JeaProductAppProps extends Omit<JeaAppProps, 'features' | 'viewState'> {
  client?: SetupSettingsClient | null
  host?: ProductHostKind
  initialReadiness?: SetupReadiness | null
  features?: JeaAppProps['features']
  viewState?: JeaAppProps['viewState']
}

export function JeaProductApp({
  client = null,
  host = 'web',
  initialReadiness = null,
  features = [],
  adapters,
  viewState,
  ...appProps
}: JeaProductAppProps) {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(initialReadiness)
  const [subjects, setSubjects] = useState<SubjectSummary[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    initialReadiness || !client ? 'ready' : 'loading'
  )
  const [setupComplete, setSetupComplete] = useState(isConversationReady(initialReadiness))

  useEffect(() => {
    if (!client) return
    let cancelled = false
    setLoadState('loading')
    void Promise.all([client.getReadiness(), client.listSubjects()])
      .then(([nextReadiness, nextSubjects]) => {
        if (cancelled) return
        setReadiness(nextReadiness)
        setSubjects(nextSubjects)
        setSetupComplete(isConversationReady(nextReadiness))
        setLoadState('ready')
      })
      .catch(() => {
        if (!cancelled) setLoadState('error')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  const selectedSubject = adapters?.selectedSubjectId
    ?? readiness?.conversation.subject
    ?? readiness?.subjects.defaultSubject
    ?? null

  const serviceReadiness = useLiveSubjectReadiness(
    client,
    selectedSubject,
    adapters?.subjectReadiness
  )

  const resolvedFeatures = useMemo(
    () => withDefaultProductFeatures(features),
    [features]
  )

  const workspaceAdapters = useMemo<ShellAdapters>(() => ({
    ...adapters,
    subjects: subjects.length > 0
      ? subjects.map((subject) => ({
        id: subject.name,
        name: subject.name,
        namespace: subject.namespace,
        isDefault: subject.isDefault
      }))
      : adapters?.subjects,
    selectedSubjectId: adapters?.selectedSubjectId
      ?? readiness?.conversation.subject
      ?? readiness?.subjects.defaultSubject
      ?? adapters?.selectedSubjectId,
    hostKind: host,
    subjectReadiness: serviceReadiness ?? adapters?.subjectReadiness ?? null,
    serviceStatus: adapters?.serviceStatus === 'offline'
      ? 'offline'
      : deriveServiceStatusKind(serviceReadiness ?? adapters?.subjectReadiness ?? null, { host }),
    onRetry: adapters?.onRetry ?? (() => {
      if (!client) return
      setLoadState('loading')
      void Promise.all([client.getReadiness(), client.listSubjects()])
        .then(([nextReadiness, nextSubjects]) => {
          setReadiness(nextReadiness)
          setSubjects(nextSubjects)
          setSetupComplete(isConversationReady(nextReadiness))
          setLoadState('ready')
        })
        .catch(() => setLoadState('error'))
    })
  }), [adapters, client, host, readiness, serviceReadiness, subjects])

  const shell = (
    loadState === 'loading' && !initialReadiness ? (
      <JeaApp {...appProps} adapters={workspaceAdapters} features={resolvedFeatures} viewState="loading" />
    ) : loadState === 'error' ? (
      <JeaApp {...appProps} adapters={workspaceAdapters} features={resolvedFeatures} viewState="error" />
    ) : client && readiness && !setupComplete && !isConversationReady(readiness) ? (
      <SetupFlow
        client={client}
        readiness={readiness}
        onReadinessChange={(next) => {
          setReadiness(next)
          if (isConversationReady(next)) setSetupComplete(true)
        }}
        onComplete={() => setSetupComplete(true)}
      />
    ) : (
      <JeaApp
        {...appProps}
        adapters={workspaceAdapters}
        features={resolvedFeatures}
        viewState={viewState ?? 'ready'}
      />
    )
  )

  return (
    <ThemeProvider initialPreference={appProps.theme}>
      <LocaleProvider initialLocale={appProps.locale}>
        <JeaClientProvider client={client} host={host}>
          {shell}
        </JeaClientProvider>
      </LocaleProvider>
    </ThemeProvider>
  )
}
