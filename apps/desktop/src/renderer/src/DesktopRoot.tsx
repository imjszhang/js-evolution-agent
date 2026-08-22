import { useMemo } from 'react'
import {
  JeaApp,
  JeaProductApp,
  withDefaultProductFeatures,
  type JeaAppProps,
  type SetupSettingsClient
} from '@jea/app'
import type { JeaClient } from '../../client-api/jea-client'
import { createDesktopProjectionWatchPort, createRendererJeaClient } from './conversation/host-client'
import { createClientProductFeatures } from './product-features'

export function DesktopRoot({
  client,
  ...props
}: JeaAppProps & { client?: JeaClient }) {
  const resolved = client ?? createRendererJeaClient()
  const features = useMemo(
    () => [
      ...createClientProductFeatures(resolved, {
        projectionWatch: createDesktopProjectionWatchPort()
      }),
      ...(props.features ?? [])
    ],
    [props.features, resolved]
  )

  if (client) {
    return <JeaApp {...props} features={withDefaultProductFeatures(features)} />
  }

  return (
    <JeaProductApp
      {...props}
      client={resolved as SetupSettingsClient}
      host="electron"
      features={features}
    />
  )
}
