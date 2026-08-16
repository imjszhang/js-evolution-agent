import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AcpWorkspace } from '../src/renderer/src/components/AcpWorkspace'
import { DaemonPanel } from '../src/renderer/src/components/DaemonPanel'
import {
  ChannelChatView,
  MAX_CHANNEL_RECORDS,
  mergeRecords,
  resolveDraftAttempt
} from '../src/renderer/src/components/ChannelChatView'
import { JeaApp } from '@jea/app'
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

  it('bounds visible Channel records to the latest 400', () => {
    const incoming = Array.from({ length: MAX_CHANNEL_RECORDS + 20 }, (_, offset) => ({
      id: `id-${offset}`,
      session_id: 'main',
      role: 'user' as const,
      direction: 'inbound' as const,
      content: String(offset),
      created_at: '2026-08-15T00:00:00Z',
      offset
    }))
    const bounded = mergeRecords([], incoming)
    expect(bounded).toHaveLength(MAX_CHANNEL_RECORDS)
    expect(bounded[0].id).toBe('id-20')
    expect(bounded.at(-1)?.id).toBe('id-419')
  })

  it('renders safe empty states without a browser bridge', () => {
    const channel = renderToStaticMarkup(<ChannelChatView subject={null} />)
    expect(channel).toContain('Select a subject')
    const acp = renderToStaticMarkup(<AcpWorkspace />)
    expect(acp).toContain('ACP')
  })

  it('renders the shared three-column workspace instead of page navigation', () => {
    const html = renderToStaticMarkup(<JeaApp locale="en" />)
    expect(html).toContain('data-testid="workspace"')
    expect(html).toContain('data-testid="column-subject"')
    expect(html).toContain('data-testid="column-conversation"')
    expect(html).toContain('data-testid="column-evolution"')
    expect(html).not.toContain('Channel')
    expect(html).not.toContain('System alerts')
    expect(html).not.toContain('Todo Center')
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
