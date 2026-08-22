import { createEvolutionInspectorFeature, type FeatureModule } from '@jea/app'
import type { JeaClient } from '../../client-api/jea-client'
import { createConversationFeature } from './conversation/feature'
import type { ProjectionWatchPort } from './conversation/watch'

export function createClientProductFeatures(
  client: JeaClient,
  options: { projectionWatch?: ProjectionWatchPort | null } = {}
): FeatureModule[] {
  return [
    createConversationFeature(client, {
      projectionWatch: options.projectionWatch ?? null
    }),
    createEvolutionInspectorFeature({ client })
  ]
}
