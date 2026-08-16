import { useMemo } from 'react'
import { createEvolutionInspectorFeature, JeaApp, type JeaAppProps } from '@jea/app'
import type { JeaClient } from '../../client-api/jea-client'
import { createConversationFeature } from './conversation/feature'
import { createRendererJeaClient } from './conversation/host-client'

export function DesktopRoot({
  client,
  ...props
}: JeaAppProps & { client?: JeaClient }) {
  const resolved = client ?? createRendererJeaClient()
  const features = useMemo(
    () => [
      createConversationFeature(resolved),
      createEvolutionInspectorFeature({ client: resolved }),
      ...(props.features ?? [])
    ],
    [props.features, resolved]
  )
  return <JeaApp {...props} features={features} />
}
