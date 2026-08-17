import type { SubjectReadiness } from '../../../client-api/types'

export type ChannelServiceStartState = 'idle' | 'pending' | 'started' | 'failed'

export type ConversationRecoveryKind =
  | 'ready'
  | 'stopped'
  | 'blocked'
  | 'starting'
  | 'attached'
  | 'stale'
  | 'zombie'
  | 'desktop_disabled'
  | 'model_blocked'
  | 'web_native'

export interface ConversationRecoveryView {
  kind: ConversationRecoveryKind
  canSend: boolean
  showStartChannel: boolean
  showNativeOnly: boolean
  blockedReasons: string[]
  cycleStalled: boolean
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function deriveConversationRecovery(input: {
  subjectReadiness: SubjectReadiness | null
  desktopChannelEnabled: boolean
  serviceStartState: ChannelServiceStartState
  channelReasons?: readonly string[]
}): ConversationRecoveryView {
  const readiness = input.subjectReadiness
  const conversationReasons = readiness?.conversation.reasons ?? []
  const channelState = readiness?.channel.state ?? null
  const allowed = new Set(readiness?.allowed_actions ?? [])
  const cycleStalled = Boolean(
    readiness?.cycle.state === 'stalled'
    || readiness?.cycle.reasons.includes('reactor_backlog_stalled')
  )
  const blockedReasons = uniqueStrings(input.channelReasons ?? [])
  const startAllowed = allowed.has('start_channel')
  const nativeOnly = allowed.has('open_desktop') && !startAllowed
  const desktopDisabled = !input.desktopChannelEnabled
    || conversationReasons.includes('desktop_channel_disabled')
  const modelBlocked = conversationReasons.includes('conversation_blocked_model')

  if (desktopDisabled) {
    return {
      kind: 'desktop_disabled',
      canSend: false,
      showStartChannel: false,
      showNativeOnly: false,
      blockedReasons,
      cycleStalled
    }
  }

  if (input.serviceStartState === 'pending' || channelState === 'starting') {
    return {
      kind: 'starting',
      canSend: false,
      showStartChannel: false,
      showNativeOnly: false,
      blockedReasons,
      cycleStalled
    }
  }

  if (channelState === 'stale') {
    return {
      kind: 'stale',
      canSend: false,
      showStartChannel: false,
      showNativeOnly: nativeOnly,
      blockedReasons,
      cycleStalled
    }
  }

  if (channelState === 'zombie') {
    return {
      kind: 'zombie',
      canSend: false,
      showStartChannel: false,
      showNativeOnly: nativeOnly,
      blockedReasons,
      cycleStalled
    }
  }

  if (channelState === 'attached') {
    return {
      kind: 'attached',
      canSend: !modelBlocked && readiness?.conversation.state === 'running',
      showStartChannel: false,
      showNativeOnly: false,
      blockedReasons,
      cycleStalled
    }
  }

  if (channelState === 'blocked') {
    return {
      kind: 'blocked',
      canSend: false,
      showStartChannel: startAllowed,
      showNativeOnly: nativeOnly,
      blockedReasons: blockedReasons.length > 0 ? blockedReasons : [],
      cycleStalled
    }
  }

  if (channelState === 'stopped' || conversationReasons.includes('conversation_blocked_channel')) {
    return {
      kind: nativeOnly ? 'web_native' : 'stopped',
      canSend: false,
      showStartChannel: startAllowed,
      showNativeOnly: nativeOnly,
      blockedReasons,
      cycleStalled
    }
  }

  if (modelBlocked) {
    return {
      kind: 'model_blocked',
      canSend: false,
      showStartChannel: false,
      showNativeOnly: false,
      blockedReasons,
      cycleStalled
    }
  }

  return {
    kind: 'ready',
    canSend: Boolean(!readiness || readiness.conversation.state === 'running'),
    showStartChannel: false,
    showNativeOnly: false,
    blockedReasons,
    cycleStalled
  }
}

export function conversationCanCompose(
  recovery: ConversationRecoveryView,
  input: { sessionId: string | null; draft: string; sendState: string }
): boolean {
  return recovery.canSend
    && Boolean(input.sessionId)
    && Boolean(input.draft.trim())
    && input.sendState !== 'pending'
}
