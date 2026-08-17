import { describe, expect, it } from 'vitest'
import { fixtureSubjectReadiness } from '../../src/renderer/src/conversation/harness'
import { conversationCanCompose, deriveConversationRecovery } from '../../src/renderer/src/conversation/recovery'

describe('conversation recovery derivation', () => {
  it('offers Start Channel only for stopped or blocked Channel on Electron', () => {
    const stopped = deriveConversationRecovery({
      subjectReadiness: fixtureSubjectReadiness('alpha', {
        channel: { state: 'stopped', reasons: ['channel_stopped'] },
        conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
      }),
      desktopChannelEnabled: true,
      serviceStartState: 'idle'
    })
    expect(stopped).toMatchObject({ kind: 'stopped', canSend: false, showStartChannel: true, showNativeOnly: false })

    const blocked = deriveConversationRecovery({
      subjectReadiness: fixtureSubjectReadiness('alpha', {
        channel: { state: 'blocked', reasons: ['channel_blocked'] },
        conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
      }),
      desktopChannelEnabled: true,
      serviceStartState: 'idle',
      channelReasons: ['Channel tasks are pending without a fresh worker']
    })
    expect(blocked.kind).toBe('blocked')
    expect(blocked.blockedReasons).toEqual(['Channel tasks are pending without a fresh worker'])
    expect(blocked.showStartChannel).toBe(true)
  })

  it('does not recommend start_channel for attached, stale, zombie, or already-running Channel', () => {
    for (const state of ['attached', 'stale', 'zombie', 'running'] as const) {
      const recovery = deriveConversationRecovery({
        subjectReadiness: fixtureSubjectReadiness('alpha', {
          channel: { state, reasons: [`channel_${state === 'running' ? 'running' : state}`] },
          conversation: {
            state: state === 'attached' || state === 'running' ? 'running' : 'blocked',
            reasons: state === 'attached' || state === 'running'
              ? ['conversation_ready']
              : ['conversation_blocked_channel']
          }
        }),
        desktopChannelEnabled: true,
        serviceStartState: 'idle'
      })
      expect(recovery.showStartChannel, state).toBe(false)
    }
  })

  it('keeps sending enabled when Cycle is stalled and Channel is ready', () => {
    const recovery = deriveConversationRecovery({
      subjectReadiness: fixtureSubjectReadiness('alpha', {
        channel: { state: 'running', reasons: ['channel_running'] },
        cycle: { state: 'stalled', reasons: ['reactor_backlog_stalled', 'cycle_running'] },
        conversation: { state: 'running', reasons: ['conversation_ready'] }
      }),
      desktopChannelEnabled: true,
      serviceStartState: 'idle'
    })
    expect(recovery.kind).toBe('ready')
    expect(recovery.canSend).toBe(true)
    expect(recovery.showStartChannel).toBe(false)
    expect(recovery.cycleStalled).toBe(true)
    expect(conversationCanCompose(recovery, { sessionId: 'main', draft: 'hello', sendState: 'idle' })).toBe(true)
  })

  it('reports native-only recovery on Web when Channel is stopped', () => {
    const recovery = deriveConversationRecovery({
      subjectReadiness: fixtureSubjectReadiness('alpha', {
        channel: { state: 'stopped', reasons: ['channel_stopped'] },
        conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
      }, 'web'),
      desktopChannelEnabled: true,
      serviceStartState: 'idle'
    })
    expect(recovery.kind).toBe('web_native')
    expect(recovery.showStartChannel).toBe(false)
    expect(recovery.showNativeOnly).toBe(true)
    expect(recovery.canSend).toBe(false)
  })
})
