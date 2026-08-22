import { describe, expect, it } from 'vitest'
import { PublicClientError } from '../../src/client-api/errors'
import { ConversationWorkspaceModel } from '../../src/renderer/src/conversation/model'
import { createConversationHarness, fixtureSubjectReadiness } from '../../src/renderer/src/conversation/harness'
import { deriveConversationRecovery } from '../../src/renderer/src/conversation/recovery'
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
          items: [{
            severity: 'critical',
            kind: 'cycle_progress_stalled',
            status: 'active',
            category: 'current',
            blocking: true,
            title: 'Cycle failed',
            summary: 'cycle exploded'
          }],
          summary: { count: 1 }
        },
        open_cycles: 1,
        evidence_pending_count: 1,
        daemon_task_pending_count: 0
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
      'model_unavailable',
      'operator_question'
    ]))
    expect(cards.some((card) => card.source === 'observability')).toBe(false)
    expect(cards.some((card) => card.kind === 'offline')).toBe(false)

    const blocked = deriveInlineCards({
      subject: {
        name: 'alpha',
        namespace: 'alpha-data',
        isDefault: true,
        selected: true,
        desktopChannelEnabled: true
      },
      service: {
        subject: 'alpha',
        mode: 'none',
        pid: null,
        domain: null,
        heartbeat_at: null,
        started_at: null,
        health: 'reactor_backlog_stalled',
        detail: 'Service is unhealthy.'
      },
      readiness: null,
      subjectReadiness: fixtureSubjectReadiness('alpha', {
        channel: { state: 'blocked', reasons: ['channel_blocked'] },
        conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
      }),
      channelReasons: ['Channel tasks are pending without a fresh worker'],
      observability: { subject: 'alpha', attention: {}, open_cycles: 0 },
      records: [],
      error: null
    })
    expect(blocked.find((card) => card.id === 'status:channel_blocked')?.body)
      .toBe('Channel tasks are pending without a fresh worker')
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

  it('incrementally reads an asynchronously appended assistant reply and clears waiting only for the active scope', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    model.setDraft('start async work')
    await model.send()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(model.getSnapshot().waiting).toBe(true)
    const reads = harness.commandCount('conversation.readMessages')

    harness.appendAssistant('beta', 'main', 'wrong subject')
    harness.appendAssistant('alpha', 'other', 'wrong session')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.commandCount('conversation.readMessages')).toBe(reads)
    expect(model.getSnapshot().waiting).toBe(true)

    setTimeout(() => {
      harness.appendAssistant('alpha', 'main', 'async reply')
    }, 0)
    await waitFor(model, () => (
      model.getSnapshot().records.some((record) => record.content === 'async reply')
      && model.getSnapshot().waiting === false
    ))

    expect(harness.commandCount('conversation.readMessages')).toBe(reads + 1)
    expect(model.getSnapshot().records.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'async reply'
    })
  })

  it('refreshes inactive session deletion without reading or disturbing active messages', async () => {
    const harness = createConversationHarness({
      subjects: [{
        name: 'alpha',
        namespace: 'alpha-data',
        isDefault: true,
        selected: true,
        desktopChannelEnabled: true,
        sessions: [
          { session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' },
          { session_id: 'inactive', target: 'desktop:inactive', message_count: 0, last_message_at: null }
        ],
        records: [{
          id: 'main-1',
          session_id: 'main',
          role: 'user',
          direction: 'inbound',
          content: 'keep active',
          created_at: '2026-08-16T00:00:00.000Z',
          offset: 0
        }]
      }]
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    const reads = harness.commandCount('conversation.readMessages')

    harness.setSessions('alpha', [
      { session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' }
    ])
    harness.emit('conversation.updated', 'alpha', 'inactive', {
      subject: 'alpha',
      session_id: 'inactive',
      removed: true
    })
    await waitFor(model, () => model.getSnapshot().sessions.length === 1)

    expect(model.getSnapshot().sessionId).toBe('main')
    expect(model.getSnapshot().records.map((record) => record.content)).toEqual(['keep active'])
    expect(harness.commandCount('conversation.readMessages')).toBe(reads)
  })

  it('selects a rename-like replacement and clears deleted-session messages before reloading', async () => {
    const harness = createConversationHarness({
      subjects: [{
        name: 'alpha',
        namespace: 'alpha-data',
        isDefault: true,
        selected: true,
        desktopChannelEnabled: true,
        sessions: [
          { session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' }
        ],
        records: [{
          id: 'old-1',
          session_id: 'main',
          role: 'user',
          direction: 'inbound',
          content: 'stale main message',
          created_at: '2026-08-16T00:00:00.000Z',
          offset: 0
        }]
      }]
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    harness.records.set('alpha:renamed', [{
      id: 'new-1',
      session_id: 'renamed',
      role: 'user',
      direction: 'inbound',
      content: 'renamed session message',
      created_at: '2026-08-16T00:00:01.000Z',
      offset: 0
    }])
    harness.setSessions('alpha', [
      { session_id: 'renamed', target: 'desktop:renamed', message_count: 1, last_message_at: '2026-08-16T00:00:01.000Z' }
    ])

    harness.emit('conversation.updated', 'alpha', 'main', {
      subject: 'alpha',
      session_id: 'main',
      removed: true
    })
    await waitFor(model, () => model.getSnapshot().records.some((record) => record.content === 'renamed session message'))

    expect(model.getSnapshot().sessionId).toBe('renamed')
    expect(model.getSnapshot().sessions.map((session) => session.session_id)).toEqual(['renamed'])
    expect(model.getSnapshot().records.map((record) => record.content)).toEqual(['renamed session message'])
  })

  it('clears selection and records when the active session is deleted without replacement', async () => {
    const harness = createConversationHarness({
      subjects: [{
        name: 'alpha',
        namespace: 'alpha-data',
        isDefault: true,
        selected: true,
        desktopChannelEnabled: true,
        sessions: [
          { session_id: 'main', target: 'desktop:main', message_count: 1, last_message_at: '2026-08-16T00:00:00.000Z' }
        ],
        records: [{
          id: 'old-1',
          session_id: 'main',
          role: 'user',
          direction: 'inbound',
          content: 'remove me',
          created_at: '2026-08-16T00:00:00.000Z',
          offset: 0
        }]
      }]
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    harness.setSessions('alpha', [])

    harness.emit('conversation.updated', 'alpha', 'main', {
      subject: 'alpha',
      session_id: 'main',
      removed: true
    })
    await waitFor(model, () => model.getSnapshot().sessionId === null)

    expect(model.getSnapshot().sessions).toEqual([])
    expect(model.getSnapshot().records).toEqual([])
  })

  it('uses bounded polling only as a lost conversation-event fallback', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    model.setDraft('fallback please')
    await model.send()
    expect(model.getSnapshot().pipelineState?.status).toBe('pending')
    const reads = harness.commandCount('conversation.readMessages')

    harness.appendAssistant('alpha', 'main', 'reply without event', {}, false)
    await waitFor(model, () => (
      model.getSnapshot().records.some((record) => record.content === 'reply without event')
      && model.getSnapshot().waiting === false
    ), 1_000)

    expect(harness.commandCount('conversation.readMessages')).toBeGreaterThan(reads)
    expect(model.getSnapshot().pipelineState?.status).toBe('delivered')
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
      service: { mode: 'none', pid: null, domain: null, health: 'idle', detail: 'Channel worker is not running.' }
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    expect(model.getSnapshot().subjectReadiness?.channel.state).toBe('stopped')
    expect(model.getSnapshot().subjectReadiness?.allowed_actions).toContain('start_channel')
    expect(model.getSnapshot().cards.some((card) => card.kind === 'offline')).toBe(true)
    const start = model.startChannelService()
    expect(model.getSnapshot().serviceStartState).toBe('pending')
    await start
    expect(harness.started).toEqual(['alpha'])
    expect(harness.startedDomains).toEqual(['channel'])
    expect(model.getSnapshot().service?.domain).toBe('channel')
    expect(model.getSnapshot().serviceStartState).toBe('started')
    expect(model.getSnapshot().subjectReadiness?.channel.state).toBe('running')
    expect(model.getSnapshot().cards.some((card) => card.kind === 'offline')).toBe(false)
  })

  it('does not disable sending or suggest Channel restart when only Cycle is stalled', async () => {
    const harness = createConversationHarness({
      subjectReadiness: {
        channel: { state: 'attached', reasons: ['channel_attached'] },
        cycle: { state: 'stalled', reasons: ['reactor_backlog_stalled', 'cycle_running'] },
        conversation: { state: 'running', reasons: ['conversation_ready'] }
      }
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    const snapshot = model.getSnapshot()
    const recovery = deriveConversationRecovery({
      subjectReadiness: snapshot.subjectReadiness,
      desktopChannelEnabled: true,
      serviceStartState: snapshot.serviceStartState,
      channelReasons: snapshot.channelReasons
    })
    expect(snapshot.subjectReadiness?.cycle.reasons).toContain('reactor_backlog_stalled')
    expect(snapshot.subjectReadiness?.conversation.state).toBe('running')
    expect(recovery.canSend).toBe(true)
    expect(recovery.showStartChannel).toBe(false)
    expect(snapshot.cards.some((card) => card.kind === 'offline')).toBe(false)
    model.setDraft('hello while cycle is stalled')
    await model.send()
    expect(harness.sent).toHaveLength(1)
    expect(harness.startedDomains).toEqual([])
  })

  it('surfaces Web COMMAND_NOT_ALLOWED for Channel lifecycle mutation', async () => {
    const harness = createConversationHarness({
      hostKind: 'web',
      service: { mode: 'none', pid: null, domain: null, health: 'idle' },
      rejectStart: new PublicClientError('COMMAND_NOT_ALLOWED', 'Command is not available on the Web host.')
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()
    expect(model.getSnapshot().subjectReadiness?.allowed_actions).toEqual(['open_desktop'])
    expect(model.getSnapshot().subjectReadiness?.allowed_actions).not.toContain('start_channel')
    await model.startChannelService()
    expect(harness.started).toEqual([])
    expect(model.getSnapshot().serviceStartState).toBe('failed')
    expect(model.getSnapshot().error?.kind).toBe('web_rejected')
    expect(model.getSnapshot().error?.code).toBe('COMMAND_NOT_ALLOWED')
  })

  it('distinguishes attached, stale, early-exit, and startup-timeout lifecycle failures', async () => {
    const cases = [
      {
        message: 'An external daemon is already running.',
        kind: 'channel_attached' as const
      },
      {
        message: 'A live worker is still present and cannot be replaced safely.',
        kind: 'channel_stale' as const
      },
      {
        message: 'The JEA daemon exited before becoming ready. See <JEA_HOME>/logs/daemon.log.',
        kind: 'early_exit' as const
      },
      {
        message: 'The JEA daemon did not become ready before the startup timeout. See <JEA_HOME>/logs/daemon.log.',
        kind: 'startup_timeout' as const
      }
    ]
    for (const item of cases) {
      expect(classifyClientError(new PublicClientError('OPERATION_FAILED', item.message)).kind).toBe(item.kind)
    }
  })

  it('starts a product projection watch for the selected Subject and releases it on dispose', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client, harness.projectionWatch)
    await model.bootstrap()
    expect(harness.watched).toEqual(['alpha'])
    await model.selectSubject('beta')
    expect(harness.watched).toEqual(['alpha', 'beta'])
    model.dispose()
    expect(harness.watchStops).toBe(1)
  })

  it('does not let a late previous-Subject event overwrite readiness or messages', async () => {
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
      ]
    })
    harness.setSupport('alpha', {
      readiness: { model: { configured: true, mode: 'deepseek' } },
      observability: { attention: { cycle_status: 'failed', tldr: 'alpha failed' }, open_cycles: 1 }
    })
    harness.setSupport('beta', {
      readiness: { model: { configured: false, mode: 'mock' } },
      observability: { attention: { cycle_status: 'completed', tldr: 'beta done' }, open_cycles: 0 }
    })
    const model = new ConversationWorkspaceModel(harness.client, harness.projectionWatch)
    await model.bootstrap()
    harness.setSupportDelay(40)
    harness.emit('projection.ops_updated', 'alpha', undefined, { reason: 'late-start' })
    await model.selectSubject('beta')
    harness.emit('projection.ops_updated', 'alpha', undefined, {
      snapshot: { daemon: { health: { status: 'healthy' } } },
      reason: 'late'
    })
    harness.emit('conversation.updated', 'alpha', 'main', { subject: 'alpha', session_id: 'main' })
    await waitFor(model, () => model.getSnapshot().subject?.name === 'beta' && model.getSnapshot().records.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const snapshot = model.getSnapshot()
    expect(snapshot.subject?.name).toBe('beta')
    expect(snapshot.records.map((record) => record.content)).toEqual(['beta only'])
    expect(snapshot.readiness?.model.mode).toBe('mock')
    expect(snapshot.observability?.attention?.cycle_status).toBe('completed')
    expect(snapshot.observability?.attention?.tldr).not.toBe('alpha failed')
  })

  it('surfaces watcher failure as a visible stale state instead of keeping a green status', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client, harness.projectionWatch)
    await model.bootstrap()
    expect(model.getSnapshot().stale).toBe(false)
    harness.emit('projection.refresh_failed', 'alpha', undefined, { stale: true, reason: 'watch' })
    await waitFor(model, () => model.getSnapshot().stale === true)
    const snapshot = model.getSnapshot()
    expect(snapshot.cards.some((card) => card.kind === 'stale')).toBe(true)
    expect(snapshot.stale).toBe(true)
  })

  it('keeps channel startup failures visible and retryable', async () => {
    const harness = createConversationHarness({
      service: { mode: 'none', pid: null, health: 'idle', detail: 'Channel worker is not running.' },
      rejectStart: new PublicClientError('OPERATION_FAILED', 'The packaged daemon exited before startup.')
    })
    const model = new ConversationWorkspaceModel(harness.client)
    await model.bootstrap()

    await model.startChannelService()

    expect(model.getSnapshot().serviceStartState).toBe('failed')
    expect(model.getSnapshot().error).toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'The packaged daemon exited before startup.'
    })
    expect(model.getSnapshot().cards.some((card) => card.kind === 'offline')).toBe(true)
  })

  it('coalesces one revision of support events into a single readiness/status/observability read', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client, harness.projectionWatch)
    await model.bootstrap()
    const before = {
      status: harness.commandCount('service.getStatus'),
      readiness: harness.commandCount('service.getReadiness'),
      setup: harness.commandCount('setup.getReadiness'),
      observability: harness.commandCount('evolution.getObservability'),
      messages: harness.commandCount('conversation.readMessages'),
      select: harness.commandCount('subject.select')
    }
    harness.emit('projection.ops_updated', 'alpha', undefined, { revision: 7 })
    harness.emit('service.status', 'alpha', undefined, { revision: 7 })
    harness.emit('projection.todo_updated', 'alpha', undefined, { revision: 7 })
    harness.emit('evolution.updated', 'alpha', undefined, { revision: 7 })
    harness.emit('projection.channel_updated', 'alpha', undefined, {
      revision: 7,
      channel: { reasons: ['channel_running'] }
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(harness.commandCount('service.getStatus') - before.status).toBeLessThanOrEqual(1)
    expect(harness.commandCount('service.getReadiness') - before.readiness).toBeLessThanOrEqual(1)
    expect(harness.commandCount('setup.getReadiness') - before.setup).toBeLessThanOrEqual(1)
    expect(harness.commandCount('evolution.getObservability') - before.observability).toBeLessThanOrEqual(1)
    expect(harness.commandCount('conversation.readMessages')).toBe(before.messages)
    expect(harness.commandCount('subject.select')).toBe(before.select)
    expect(model.getSnapshot().channelReasons).toEqual(['channel_running'])
  })

  it('does not treat same-subject.changed as a full selectSubject', async () => {
    const harness = createConversationHarness()
    const model = new ConversationWorkspaceModel(harness.client, harness.projectionWatch)
    await model.bootstrap()
    const selects = harness.commandCount('subject.select')
    const messages = harness.commandCount('conversation.readMessages')
    harness.emit('subject.changed', 'alpha', undefined, { subject: 'alpha', reason: 'same' })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(harness.commandCount('subject.select')).toBe(selects)
    expect(harness.commandCount('conversation.readMessages')).toBe(messages)
  })
})
