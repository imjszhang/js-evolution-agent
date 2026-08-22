import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaApp, LocaleProvider } from '@jea/app'
import { PublicClientError } from '../../src/client-api/errors'
import { createConversationFeature } from '../../src/renderer/src/conversation/feature'
import { createConversationHarness } from '../../src/renderer/src/conversation/harness'
import { fixtureSubjectReadiness } from '../../src/renderer/src/conversation/harness'
import { ConversationWorkspaceModel } from '../../src/renderer/src/conversation/model'
import { ConversationPane, SubjectListPane } from '../../src/renderer/src/conversation/panes'
import { DesktopRoot } from '../../src/renderer/src/DesktopRoot'

function renderPane(node: React.ReactNode): string {
  return renderToStaticMarkup(<LocaleProvider initialLocale="en">{node}</LocaleProvider>)
}

describe('conversation workspace components', () => {
  it('registers conversation and subject list slots on the shared shell', () => {
    const { client } = createConversationHarness()
    const html = renderToStaticMarkup(
      <JeaApp locale="en" features={[createConversationFeature(client)]} />
    )
    expect(html).toContain('data-testid="conversation-workspace"')
    expect(html).toContain('data-testid="subject-list"')
    expect(html).toContain('data-testid="conversation-draft"')
    expect(html).not.toContain('primary-nav')
    expect(html).not.toContain('Todo Center')
  })

  it('renders disabled, pending, failed, offline, and question-card states', () => {
    const { client } = createConversationHarness()
    const model = new ConversationWorkspaceModel(client)
    const base = model.getSnapshot()

    const disabled = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'beta',
            namespace: 'beta-data',
            isDefault: false,
            selected: true,
            desktopChannelEnabled: false
          },
          sessionId: 'main',
          cards: [{
            id: 'status:desktop_disabled',
            kind: 'desktop_disabled',
            title: 'Desktop Channel is disabled',
            body: 'Enable explicitly.',
            tone: 'warn',
            source: 'service'
          }]
        }}
      />
    )
    expect(disabled).toContain('data-testid="conversation-state-disabled"')
    expect(disabled).toContain('data-testid="conversation-enable-desktop"')

    const pending = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main',
          sendState: 'pending',
          draft: 'hello'
        }}
      />
    )
    expect(pending).toContain('data-testid="conversation-state-pending"')

    const failed = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main',
          sendState: 'failed',
          draft: 'hello',
          error: {
            kind: 'failed',
            code: 'OPERATION_FAILED',
            message: 'Unable to send the desktop message.'
          }
        }}
      />
    )
    expect(failed).toContain('data-testid="conversation-state-failed"')
    expect(failed).toContain('data-testid="conversation-retry"')

    const enabledSubject = {
      name: 'alpha',
      namespace: 'alpha-data',
      isDefault: true,
      selected: true,
      desktopChannelEnabled: true
    }
    const offline = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: enabledSubject,
          sessionId: 'main',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'stopped', reasons: ['channel_stopped'] },
            conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
          })
        }}
      />
    )
    expect(offline).toContain('data-testid="conversation-state-stopped"')
    expect(offline).toContain('data-testid="conversation-start-channel"')
    expect(offline).toContain('Start Channel')

    const startFailed = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main',
          serviceStartState: 'failed',
          error: {
            kind: 'failed',
            code: 'OPERATION_FAILED',
            message: 'The packaged daemon exited before startup.'
          }
        }}
      />
    )
    expect(startFailed).toContain('data-testid="conversation-state-start-failed"')
    expect(startFailed).toContain('The packaged daemon exited before startup.')

    const question = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main',
          cards: [{
            id: 'message:q-1',
            kind: 'operator_question',
            title: 'Operator question',
            body: 'What should the next cycle verify?',
            tone: 'info',
            source: 'message'
          }],
          records: [{
            id: 'q-1',
            session_id: 'main',
            role: 'assistant',
            direction: 'outbound',
            content: 'What should the next cycle verify?',
            created_at: '2026-08-16T00:00:00.000Z',
            offset: 0
          }]
        }}
      />
    )
    expect(question).toContain('data-testid="conversation-card-operator_question"')
    expect(question).toContain('What should the next cycle verify?')

    const web = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main',
          sendState: 'failed',
          error: classifyError()
        }}
      />
    )
    expect(web).toContain('data-testid="conversation-state-web-rejected"')
  })

  it('renders stopped, blocked, starting, ready, failed, attached, and Web-rejected recovery states', () => {
    const { client } = createConversationHarness()
    const model = new ConversationWorkspaceModel(client)
    const base = model.getSnapshot()
    const subject = {
      name: 'alpha',
      namespace: 'alpha-data',
      isDefault: true,
      selected: true,
      desktopChannelEnabled: true
    }

    const stopped = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'stopped', reasons: ['channel_stopped'] },
            conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
          })
        }}
      />
    )
    expect(stopped).toContain('data-recovery="stopped"')
    expect(stopped).toContain('data-testid="conversation-start-channel"')

    const blocked = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          channelReasons: ['Channel tasks are pending without a fresh worker'],
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'blocked', reasons: ['channel_blocked'] },
            conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
          })
        }}
      />
    )
    expect(blocked).toContain('data-testid="conversation-state-blocked"')
    expect(blocked).toContain('Channel tasks are pending without a fresh worker')
    expect(blocked).not.toContain('Channel service offline')

    const starting = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          serviceStartState: 'pending',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'starting', reasons: ['channel_starting'] },
            conversation: { state: 'running', reasons: ['conversation_ready'] }
          })
        }}
      />
    )
    expect(starting).toContain('data-testid="conversation-state-starting"')

    const ready = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'running', reasons: ['channel_running'] },
            cycle: { state: 'stalled', reasons: ['reactor_backlog_stalled', 'cycle_running'] },
            conversation: { state: 'running', reasons: ['conversation_ready'] }
          })
        }}
      />
    )
    expect(ready).toContain('data-testid="conversation-state-ready"')
    expect(ready).toContain('data-recovery="ready"')
    expect(ready).not.toContain('data-testid="conversation-start-channel"')
    expect(ready).not.toContain('data-testid="conversation-process-cycle-once"')
    expect(ready).not.toContain('data-testid="conversation-start-cycle"')

    const failed = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          serviceStartState: 'failed',
          error: {
            kind: 'startup_timeout',
            code: 'OPERATION_FAILED',
            message: 'The JEA daemon did not become ready before the startup timeout.'
          },
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'stopped', reasons: ['channel_stopped'] },
            conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
          })
        }}
      />
    )
    expect(failed).toContain('data-testid="conversation-state-timeout"')

    const attached = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'attached', reasons: ['channel_attached'] },
            conversation: { state: 'running', reasons: ['conversation_ready'] }
          })
        }}
      />
    )
    expect(attached).toContain('data-testid="conversation-state-attached"')
    expect(attached).not.toContain('data-testid="conversation-start-channel"')

    const webRejected = renderPane(
      <ConversationPane
        model={model}
        snapshot={{
          ...base,
          loading: false,
          subject,
          sessionId: 'main',
          subjectReadiness: fixtureSubjectReadiness('alpha', {
            channel: { state: 'stopped', reasons: ['channel_stopped'] },
            conversation: { state: 'blocked', reasons: ['conversation_blocked_channel'] }
          }, 'web')
        }}
      />
    )
    expect(webRejected).toContain('data-testid="conversation-state-native-only"')
    expect(webRejected).not.toContain('data-testid="conversation-start-channel"')
    expect(webRejected).toContain('Start Channel is available only in the Desktop app.')
  })

  it('lists subjects in the left column without a session picker', () => {
    const { client } = createConversationHarness()
    const model = new ConversationWorkspaceModel(client)
    const html = renderPane(
      <SubjectListPane
        model={model}
        snapshot={{
          ...model.getSnapshot(),
          loading: false,
          subjects: [
            { name: 'alpha', namespace: 'alpha-data', isDefault: true },
            { name: 'beta', namespace: 'beta-data', isDefault: false }
          ],
          subject: {
            name: 'alpha',
            namespace: 'alpha-data',
            isDefault: true,
            selected: true,
            desktopChannelEnabled: true
          },
          sessionId: 'main'
        }}
      />
    )
    expect(html).toContain('data-testid="subject-alpha"')
    expect(html).toContain('data-testid="subject-beta"')
    expect(html).not.toContain('data-testid="session-main"')
    expect(html).not.toContain('data-testid="session-create"')
    expect(html).not.toContain('data-testid="session-list"')
  })

  it('wires the desktop host through JeaClient rather than a page navigator', () => {
    const { client } = createConversationHarness()
    const html = renderToStaticMarkup(<DesktopRoot locale="en" client={client} />)
    expect(html).toContain('data-testid="workspace"')
    expect(html).toContain('data-testid="conversation-workspace"')
    expect(html).not.toContain('window.jea.invoke')
  })
})

function classifyError() {
  return {
    kind: 'web_rejected' as const,
    code: 'COMMAND_NOT_ALLOWED',
    message: new PublicClientError('COMMAND_NOT_ALLOWED', 'rejected').message
  }
}
