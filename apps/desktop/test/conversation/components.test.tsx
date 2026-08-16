import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaApp, LocaleProvider } from '@jea/app'
import { PublicClientError } from '../../src/client-api/errors'
import { createConversationFeature } from '../../src/renderer/src/conversation/feature'
import { createConversationHarness } from '../../src/renderer/src/conversation/harness'
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

    const offline = renderPane(
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
            id: 'status:daemon',
            kind: 'offline',
            title: 'Channel daemon is stopped',
            body: 'Start the service.',
            tone: 'warn',
            source: 'service'
          }]
        }}
      />
    )
    expect(offline).toContain('data-testid="conversation-state-offline"')
    expect(offline).toContain('data-testid="conversation-start-service"')

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

  it('lists subjects and local sessions in the left column', () => {
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
          sessions: [{
            session_id: 'main',
            target: 'desktop:main',
            message_count: 2,
            last_message_at: '2026-08-16T00:00:00.000Z'
          }],
          sessionId: 'main'
        }}
      />
    )
    expect(html).toContain('data-testid="subject-alpha"')
    expect(html).toContain('data-testid="session-main"')
    expect(html).toContain('data-testid="session-create"')
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
