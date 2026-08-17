import { useEffect, useState } from 'react'
import type { SetupSettingsClient, SubjectReadiness } from './client-types'
import { shouldRefreshServiceReadiness } from './service-status/derive'

function matchingSeed(
  seed: SubjectReadiness | null | undefined,
  subject: string | null
): SubjectReadiness | null {
  if (!seed || !subject || seed.subject !== subject) return null
  return seed
}

export function useLiveSubjectReadiness(
  client: SetupSettingsClient | null | undefined,
  subject: string | null | undefined,
  seed: SubjectReadiness | null | undefined = null
): SubjectReadiness | null {
  const name = subject?.trim() || null
  const [readiness, setReadiness] = useState<SubjectReadiness | null>(() => matchingSeed(seed, name))
  const visible = matchingSeed(readiness, name) ?? matchingSeed(seed, name)

  useEffect(() => {
    const nextSeed = matchingSeed(seed, name)
    setReadiness(nextSeed)
    if (!client?.getServiceReadiness || !name) return
    let cancelled = false
    const load = () => {
      void client.getServiceReadiness!(name).then((next) => {
        if (!cancelled) setReadiness(next)
      }).catch(() => {
        if (!cancelled) setReadiness(matchingSeed(seed, name))
      })
    }
    load()
    const stop = client.subscribe?.((event) => {
      if (shouldRefreshServiceReadiness(event, name)) load()
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [client, name, seed, seed?.generated_at, seed?.subject])

  return visible
}
