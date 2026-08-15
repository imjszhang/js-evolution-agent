import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AcpWorkspace } from '../src/renderer/src/components/AcpWorkspace'
import { DaemonPanel } from '../src/renderer/src/components/DaemonPanel'
import {
  ChannelChatView,
  mergeRecords
} from '../src/renderer/src/components/ChannelChatView'
import { Navigation } from '../src/renderer/src/components/Navigation'
import { OpsView } from '../src/renderer/src/components/OpsView'
import { PermissionCard } from '../src/renderer/src/components/PermissionCard'
import { TodoCenter } from '../src/renderer/src/components/TodoCenter'

describe('desktop renderer components', () => {
  it('merges incremental Channel pages by stable id and offset', () => {
    const records = mergeRecords([
      {
        id: 'a',
        session_id: 'main',
        role: 'user',
        direction: 'inbound',
        content: 'old',
        created_at: '2026-08-15T00:00:00Z',
        offset: 0
      }
    ], [
      {
        id: 'a',
        session_id: 'main',
        role: 'user',
        direction: 'inbound',
        content: 'updated',
        created_at: '2026-08-15T00:00:00Z',
        offset: 0
      },
      {
        id: 'b',
        session_id: 'main',
        role: 'assistant',
        direction: 'outbound',
        content: 'reply',
        created_at: '2026-08-15T00:00:01Z',
        offset: 1
      }
    ])
    expect(records.map((record) => [record.id, record.content])).toEqual([
      ['a', 'updated'],
      ['b', 'reply']
    ])
  })

  it('renders safe empty states without a browser bridge', () => {
    const channel = renderToStaticMarkup(<ChannelChatView subject={null} />)
    expect(channel).toContain('Select a subject')
    const acp = renderToStaticMarkup(<AcpWorkspace />)
    expect(acp).toContain('ACP')
  })

  it('renders Channel navigation and notification preference controls', () => {
    const html = renderToStaticMarkup(
      <Navigation
        page="channel"
        subjects={[{ name: 'alpha', namespace: 'alpha-data', isDefault: true }]}
        subject="alpha"
        onPageChange={() => undefined}
        onSubjectChange={() => undefined}
      />
    )
    expect(html).toContain('Channel')
    expect(html).toContain('System alerts')
    expect(html).toContain('alpha-data')
  })

  it('renders the remaining operational empty and controlled states', () => {
    expect(renderToStaticMarkup(
      <OpsView
        snapshot={undefined}
        loading={false}
        error={null}
        refreshedAt={null}
        onRefresh={async () => undefined}
      />
    )).toContain('No subject selected')
    expect(renderToStaticMarkup(<TodoCenter subject={null} />)).toContain('Select a subject')
    expect(renderToStaticMarkup(
      <DaemonPanel
        subject="alpha"
        initial={{
          subject: 'alpha',
          mode: 'none',
          pid: null,
          domain: null,
          heartbeat_at: null,
          started_at: null
        }}
      />
    )).toContain('No daemon process')
    expect(renderToStaticMarkup(
      <PermissionCard
        request={{
          requestId: 'p1',
          title: 'Read file',
          toolKind: 'read',
          inputSummary: 'README.md',
          paths: ['README.md'],
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }],
          reason: null
        }}
        busy={false}
        onRespond={async () => undefined}
      />
    )).toContain('Allow once')
  })
})
