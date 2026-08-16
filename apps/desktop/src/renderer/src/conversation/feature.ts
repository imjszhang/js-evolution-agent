import type { FeatureModule } from '@jea/app'
import type { JeaClient } from '../../../client-api/jea-client'
import { ConversationWorkspaceModel } from './model'
import { createConversationSlot, createServiceStatusSlot, createSubjectListSlot } from './slots'

export const CONVERSATION_FEATURE_ID = 'conversation-119'

export function createConversationFeature(client: JeaClient): FeatureModule {
  const model = new ConversationWorkspaceModel(client)
  return {
    id: CONVERSATION_FEATURE_ID,
    slots: {
      subjectList: createSubjectListSlot(model),
      conversation: createConversationSlot(model),
      serviceStatus: createServiceStatusSlot(model)
    }
  }
}
