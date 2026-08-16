import { describe, expect, it } from 'vitest'
import { PublicClientError } from '../../src/client-api/errors'
import { ConversationWorkspaceModel } from '../../src/renderer/src/conversation/model'
import { createConversationHarness } from '../../src/renderer/src/conversation/harness'
import { deriveInlineCards } from '../../src/renderer/src/conversation/cards'
import { classifyClientError } from '../../src/renderer/src/conversation/errors'
import { resolveDraftAttempt } from '../../src/renderer/src/conversation/draft'
import { MAX_CHANNEL_RECORDS, mergeRecords } from '../../src/renderer/src/conversation/history'

function waitFor(model: ConversationWorkspaceModel, predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for conversation model state.'))
    }, timeoutMs)
    const unsubscribe = model.subscribe(() => {
      if (!predicate()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

describe('conversation workspace helpers', () => {
  it('reuses a draft id only when subject, session, and content match', () => {
    const first = resolveDraftAttempt(null, {
      subject: 'alpha',
      sessionId: 'main',
      content: 'hello'
    }, () => 'id-1')
    expect(first.id).toBe('id-1')
    expect(resolveDraftAttempt(first, {
      subject: 'alpha',
      sessionId: 'main',
      content: 'hello'
    }, () => 'id-2').id).toBe('id-1')
    expect(resolveDraftAttempt(first, {
      subject: 'alpha',
      sessionId: 'main',
      content: 'hello edited'
    }, () => 'id-3').id).toBe('id-3')
    expect(resolveDraftAttempt(first, {
      subject: 'alpha',
      sessionId: 'other',
      content: 'hello'
    }, () => 'id-4').id).toBe('id-4')
    expect(resolveDraftAttempt(first, {
      subject: 'beta',
      sessionId: 'main',
      content: 'hello'
    }, () => 'id-5').id).toBe('id-5')
  })

  it('merges incremental pages by stable id and bounds renderer memory', () => {
    const incoming = Array.from({ length: MAX_CHANNEL_RECORDS + 20 }, (_, offset) => ({
      id: `id-${offset}`,
      session_id: 'main',
      role: 'user' as const,
      direction: 'inbound' as const,
      content: String(offset),
      created_at: '2026-08-15T00:00:00Z',
      offset
    }))
    const bounded = mergeRecords([{
      id: 'id-0',
      session_id: 'main',
      role: 'user',
      direction: 'inbound',
      content: 'old',
      created_at: '2026-08-15T00:00:00Z',
      offset: 0
    }], incoming)
    expect(bounded).toHaveLength(MAX_CHANNEL_RECORDS)
    expect(bounded[0].id).toBe('id-20')
    expect(bounded.at(-1)?.id).toBe('id-419')
    expect(bounded[0].content).toBe('20')
  })

  it('classifies web capability rejection and disabled desktop Channel', () => {
    expect(classifyClientError(new PublicClientError('COMMAND_NOT_ALLOWED', 'not available on web')).kind)
      .toBe('web_rejected')
    expect(classifyClientError(new PublicClientError('CONFLICT', 'Desktop Channel is disabled for this subject.')).kind)
      .toBe('desktop_disabled')
    expect(classifyClientError(new PublicClientError('UNAVAILABLE', 'Service process control is not available in this host.')).kind)
      .toBe('unavailable')
  })

  it('derives deterministic inline cards without fabricating assistant replies', () => {
    const cards = deriveInlineCards({
      subject: {
        name: 'beta',
        namespace: 'beta-data',
        isDefault: false,
        selected: true,
        desktopChannelEnabled: false
      },
      service: {
        subject: 'beta',
        mode: 'none',
        pid: null,
        domain: null,
        heartbeat_at: null,
        started_at: null,
        health: 'idle',
        detail: null
      },
      readiness: {
        jeaHome: { path: '/tmp/jea', source: 'fixture', writable: true },
        subjects: { count: 1, defaultSubject: 'beta', names: ['beta'] },
        model: { configured: false, mode: 'unset' },
        data: { initialized: true },
        conversation: { desktopChannelEnabled: false, subject: 'beta' },
        conversationReady: false,
        cli: {
          installed: false,
          onPath: false,
          pathHint: '',
          supported: false,
          detail: null
        }
      },
      observability: {
        subject: 'beta',
        attention: {
          cycle_status: 'failed',
          tldr: 'cycle exploded',
          blockers: ['lane locked']
        },
        open_cycles: 1
      },
      records: [{
        id: 'q-1',
        session_id: 'main',
        role: 'assistant',
        direction: 'outbound',
        content: 'What should the next cycle verify?',
        created_at: '2026-08-16T00:00:00.000Z',
        offset: 0,
        metadata: { kind: 'operator_question', title: 'Operator question' }
      }],
      error: classifyClientError(new PublicClientError('COMMAND_NOT_ALLOWED', 'rejected by web host'))
    })
    expect(cards.map((card) => card.kind)).toEqual(expect.arrayContaining([
      'desktop_disabled',
      'web_rejected',
      'offline',
      'model_unavailable',
      'blocked',
      'cycle_failed',
      'operator_question'
    ]))
  })
})

describe('conversation workspace model', () => {
  it('sends only through JeaClient.sendMessage and never fabricates an assistant reply', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    model.setDraft('approve publish')
    await model.send()
    expect(harness.sent).toEqual([expect.objectContaining({
      subject: 'alpha',
      text: 'approve publish',
      sessionId: 'main'
    })])
    expect(model.getSnapshot().records.every((record) => record.role === 'user')).toBe(true)
    expect(model.getSnapshot().waiting).toBe(true)
    expect(model.getSnapshot().sendState).toBe('sent')
    model.stopWaiting()
    expect(model.getSnapshot().waiting).toBe(false)
    expect(model.getSnapshot().records.some((record) => record.role === 'assistant')).toBe(false)
  })

  it('reuses the message id on retry and allocates a new id after edit or context switch', async () => {
    const harness = createConversationHarness()
    harness.setRejectSend(new PublicClientError('OPERATION_FAILED', 'transient send failure'))
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    model.setDraft('same draft')
    await model.send()
    const firstId = model.getSnapshot().lastDraftId
    expect(model.getSnapshot().sendState).toBe('failed')
    expect(firstId).toBeTruthy()

    harness.setRejectSend(null)
    await model.retry()
    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]?.messageId).toBe(firstId)
    expect(model.getSnapshot().sendState).toBe('sent')

    model.setDraft('same draft')
    await model.send()
    const secondId = model.getSnapshot().lastDraftId
    expect(secondId).not.toBe(firstId)
    expect(harness.sent.at(-1)?.sessionId).toBe('main')
  })

  it('cancels stale reads when switching subject and never mixes messages', async () => {
    const harness = createConversationHarness({
      subjects: [
        {
          name: 'alpha',
          namespace: 'alpha-data',
          isDefault: true,
          selected: true,
          desktopChannelEnabled: true,
          sessions: [{ session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' }],
          records: [{
            id: 'alpha-1',
            session_id: 'main',
            role: 'user',
            direction: 'inbound',
            content: 'alpha only',
            created_at: '2026-08-16T00:00:00.000Z',
            offset: 0,
            message_id: 'alpha-1'
          }]
        },
        {
          name: 'beta',
          namespace: 'beta-data',
          isDefault: false,
          selected: false,
          desktopChannelEnabled: true,
          sessions: [{ session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:01.000Z' }],
          records: [{
            id: 'beta-1',
            session_id: 'main',
            role: 'user',
            direction: 'inbound',
            content: 'beta only',
            created_at: '2026-08-16T00:00:01.000Z',
            offset: 0,
            message_id: 'beta-1'
          }]
        }
      ],
      readDelayMs: 40
    })
    const model = new ConversationWorkspaceModel(harness.client)
    const first = model.bootstrap()
    const second = model.selectSubject('beta')
    await Promise.all([first, second])
    await waitFor(model, () => model.getSnapshot().subject?.name === 'beta' && model.getSnapshot().records.length > 0)
    const snapshot = model.getSnapshot()
    expect(snapshot.subject?.name).toBe('beta')
    expect(snapshot.sessionId).toBe('main')
    expect(snapshot.records.map((record) => record.content)).toEqual(['beta only'])
    expect(snapshot.records.some((record) => record.content.includes('alpha'))).toBe(false)
  })

  it('enables desktop Channel only after an explicit user action', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    await model.selectSubject('beta')
    expect(model.getSnapshot().subject?.desktopChannelEnabled).toBe(false)
    expect(model.getSnapshot().cards.some((card) => card.kind === 'desktop_disabled')).toBe(true)
    expect(harness.enabled).toEqual([])
    await model.enableDesktopChannel()
    expect(harness.enabled).toEqual(['beta'])
    expect(model.getSnapshot().subject?.desktopChannelEnabled).toBe(true)
  })

  it('surfaces web capability rejection without a successful send', async () => {
    const harness = createConversationHarness({
      rejectSend: new PublicClientError('COMMAND_NOT_ALLOWED', 'Conversation write is not available on this host.')
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    model.setDraft('hello from web')
    await model.send()
    const snapshot = model.getSnapshot()
    expect(snapshot.sendState).toBe('failed')
    expect(snapshot.error?.kind).toBe('web_rejected')
    expect(snapshot.cards.some((card) => card.kind === 'web_rejected')).toBe(true)
    expect(harness.sent).toEqual([])
    expect(snapshot.records).toEqual([])
  })

  it('exposes a recoverable start path for a stopped channel daemon', async () => {
    const harness = createConversationHarness({
      service: { mode: 'none', pid: null, health: 'idle', detail: 'Channel worker is not running.' }
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    expect(model.getSnapshot().cards.some((card) => card.kind === 'offline')).toBe(true)
    await model.startChannelService()
    expect(harness.started).toEqual(['alpha'])
    expect(model.getSnapshot().service?.mode).toBe('attached')
  })
})
