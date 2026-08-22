import {
  listDesktopSessions,
  readDesktopSession,
  sendDesktopInboundMessage
} from '../../../../src/channel/adapters/desktop/index.mjs'
import {
  channelInboundPendingDir,
  channelInboundProcessedDir
} from '../../../../src/channel/paths.mjs'
import { buildChannelProjection } from '../../../../src/channel/projection.mjs'
import { listJsonFiles, readJsonFile } from '../../../../src/channel/state.mjs'
import {
  summarizeChannelDir,
  summarizeInboundFile
} from '../../../../src/intelligence/evolution-viewer/runtime-watch.mjs'
import { listRegisteredSubjects } from '../../../../src/infra/subjects.mjs'
import { channelProjectionHealth } from '../client-api/owners/conversation'
import { redactPublicValue } from '../client-api/redact'
import type {
  ChannelSnapshot,
  DesktopSessionPage,
  DesktopSessionSummary
} from '../shared/contract'
import type { ChannelProjectionHealth } from '../client-api/types'
import { PublicCommandError } from './command-registry'
import { createDesktopServiceRuntimeContext } from './runtime-context'

export class ChannelService {
  private readonly runtimeContext: any

  constructor(
    readonly projectRoot: string,
    jeaHome: string | undefined = process.env.JEA_HOME
  ) {
    this.runtimeContext = createDesktopServiceRuntimeContext(projectRoot, jeaHome)
  }

  get(subject: string): ChannelSnapshot {
    this.assertSubject(subject)
    return redactPublicValue({
      subject,
      projection: buildChannelProjection(this.runtimeContext, subject, { eventLimit: 30 }),
      sessions: listDesktopSessions(this.runtimeContext, subject),
      inbound: {
        pending: this.listInbound(subject, 'pending', 30),
        processed: this.listInbound(subject, 'processed', 50)
      }
    }) as ChannelSnapshot
  }

  getProjectionHealth(subject: string): ChannelProjectionHealth {
    this.assertSubject(subject)
    return channelProjectionHealth(this.runtimeContext, subject)
  }

  listSessions(subject: string): DesktopSessionSummary[] {
    this.assertSubject(subject)
    return listDesktopSessions(this.runtimeContext, subject)
  }

  readSession(
    subject: string,
    sessionId: string,
    options: { offset?: number; limit?: number; tail?: number | null } = {}
  ): DesktopSessionPage {
    this.assertSubject(subject)
    return redactPublicValue((readDesktopSession as any)(
      this.runtimeContext,
      subject,
      sessionId,
      options
    )) as DesktopSessionPage
  }

  sendMessage(
    subject: string,
    sessionId: string | undefined,
    text: string,
    messageId?: string
  ): Record<string, unknown> {
    this.assertSubject(subject)
    try {
      return redactPublicValue((sendDesktopInboundMessage as any)(this.runtimeContext, subject, {
        session_id: sessionId,
        text,
        message_id: messageId,
        metadata: { source: 'desktop_ui' }
      })) as Record<string, unknown>
    } catch (error) {
      if (String(error).includes('disabled')) {
        throw new PublicCommandError(
          'CONFLICT',
          'Desktop Channel is disabled for this subject.'
        )
      }
      if (String(error).includes('already belongs to session')) {
        throw new PublicCommandError(
          'CONFLICT',
          'This message already belongs to another desktop session.'
        )
      }
      throw error
    }
  }

  listInbound(
    subject: string,
    status: 'pending' | 'processed' = 'processed',
    limit = 50
  ): Record<string, unknown>[] {
    this.assertSubject(subject)
    const dir = status === 'processed'
      ? channelInboundProcessedDir(this.runtimeContext, subject)
      : channelInboundPendingDir(this.runtimeContext, subject)
    return redactPublicValue(
      summarizeChannelDir(dir, summarizeInboundFile, Math.max(0, Math.min(200, limit)))
    ) as Record<string, unknown>[]
  }

  getInboundRecord(subject: string, file: string): Record<string, unknown> | null {
    this.assertSubject(subject)
    const safeName = file.replace(/[^a-zA-Z0-9._-]/g, '')
    const match = listJsonFiles(channelInboundProcessedDir(this.runtimeContext, subject))
      .find((candidate) => candidate.endsWith(safeName))
    if (!match) return null
    return redactPublicValue(readJsonFile(match, null)) as Record<string, unknown> | null
  }

  private assertSubject(subject: string): void {
    if (!subject || !listRegisteredSubjects(this.runtimeContext).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
  }
}
