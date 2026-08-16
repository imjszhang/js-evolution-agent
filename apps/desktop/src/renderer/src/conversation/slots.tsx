import { useEffect, useSyncExternalStore } from 'react'
import type { FeatureSlotProps } from '@jea/app'
import type { ConversationWorkspaceModel } from './model'
import { ConversationPane, ServiceStatusPane, SubjectListPane } from './panes'

function useSharedModel(model: ConversationWorkspaceModel) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
  useEffect(() => {
    model.retain()
    return () => model.release()
  }, [model])
  return snapshot
}

export function createSubjectListSlot(model: ConversationWorkspaceModel) {
  return function SubjectListSlot(_props: FeatureSlotProps) {
    const snapshot = useSharedModel(model)
    return <SubjectListPane snapshot={snapshot} model={model} />
  }
}

export function createConversationSlot(model: ConversationWorkspaceModel) {
  return function ConversationSlot(_props: FeatureSlotProps) {
    const snapshot = useSharedModel(model)
    return <ConversationPane snapshot={snapshot} model={model} />
  }
}

export function createServiceStatusSlot(model: ConversationWorkspaceModel) {
  return function ServiceStatusSlot(_props: FeatureSlotProps) {
    const snapshot = useSharedModel(model)
    return <ServiceStatusPane snapshot={snapshot} model={model} />
  }
}
