import type { FeatureModule } from '@jea/app'
import type { JeaClient } from '../../../client-api/jea-client'
import { ConversationWorkspaceModel } from './model'
import { createConversationSlot, createServiceStatusSlot, createSubjectListSlot } from './slots'
import type { ProjectionWatchPort } from './watch'

export const CONVERSATION_FEATURE_ID = 'conversation-119'

export function createConversationFeature(
  client: JeaClient,
  options: { projectionWatch?: ProjectionWatchPort | null } = {}
): FeatureModule {
  const model = new ConversationWorkspaceModel(client, options.projectionWatch ?? null)
  return {
    id: CONVERSATION_FEATURE_ID,
    slots: {
      subjectList: createSubjectListSlot(model),
      conversation: createConversationSlot(model),
      serviceStatus: createServiceStatusSlot(model)
    }
  }
}
