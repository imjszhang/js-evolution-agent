import type { SetupReadiness } from './client-types'

export type SetupStep = 'home' | 'subject' | 'init' | 'channel' | 'ready'

export function isConversationReady(readiness: SetupReadiness | null | undefined): boolean {
  if (!readiness) return false
  if (readiness.conversationReady) return true
  return Boolean(
    readiness.jeaHome.writable
    && readiness.subjects.count > 0
    && readiness.subjects.defaultSubject
    && readiness.subjects.names.includes(readiness.subjects.defaultSubject)
    && readiness.data.initialized
    && readiness.conversation.desktopChannelEnabled
  )
}

export function resolveSetupStep(
  readiness: SetupReadiness,
  { homeConfirmed = false }: { homeConfirmed?: boolean } = {}
): SetupStep {
  if (isConversationReady(readiness)) return 'ready'
  if (!readiness.jeaHome.writable) return 'home'
  if (readiness.subjects.count === 0 && !homeConfirmed) return 'home'
  if (readiness.subjects.count === 0) return 'subject'
  if (!readiness.data.initialized) return 'init'
  if (!readiness.conversation.desktopChannelEnabled) return 'channel'
  return 'ready'
}

export function allowsMockCompletion(readiness: SetupReadiness): boolean {
  return readiness.model.mode !== 'deepseek'
}
