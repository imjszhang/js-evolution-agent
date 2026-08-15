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
import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'
import type {
  ChannelSnapshot,
  DesktopSessionPage,
  DesktopSessionSummary
} from '../shared/contract'
import { PublicCommandError } from './command-registry'

export class ChannelService {
  constructor(readonly projectRoot: string) {}

  get(subject: string): ChannelSnapshot {
    this.assertSubject(subject)
    return redactSecrets({
      subject,
      projection: buildChannelProjection(this.projectRoot, subject, { eventLimit: 30 }),
      sessions: listDesktopSessions(this.projectRoot, subject),
      inbound: {
        pending: this.listInbound(subject, 'pending', 30),
        processed: this.listInbound(subject, 'processed', 50)
      }
    }) as ChannelSnapshot
  }

  listSessions(subject: string): DesktopSessionSummary[] {
    this.assertSubject(subject)
    return listDesktopSessions(this.projectRoot, subject)
  }

  readSession(
    subject: string,
    sessionId: string,
    options: { offset?: number; limit?: number; tail?: number | null } = {}
  ): DesktopSessionPage {
    this.assertSubject(subject)
    return redactSecrets((readDesktopSession as any)(
      this.projectRoot,
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
      return redactSecrets((sendDesktopInboundMessage as any)(this.projectRoot, subject, {
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
      ? channelInboundProcessedDir(this.projectRoot, subject)
      : channelInboundPendingDir(this.projectRoot, subject)
    return redactSecrets(
      summarizeChannelDir(dir, summarizeInboundFile, Math.max(0, Math.min(200, limit)))
    ) as Record<string, unknown>[]
  }

  getInboundRecord(subject: string, file: string): Record<string, unknown> | null {
    this.assertSubject(subject)
    const safeName = file.replace(/[^a-zA-Z0-9._-]/g, '')
    const match = listJsonFiles(channelInboundProcessedDir(this.projectRoot, subject))
      .find((candidate) => candidate.endsWith(safeName))
    if (!match) return null
    return redactSecrets(readJsonFile(match, null)) as Record<string, unknown> | null
  }

  private assertSubject(subject: string): void {
    if (!subject || !listRegisteredSubjects(this.projectRoot).includes(subject)) {
      throw new PublicCommandError('NOT_FOUND', 'Requested subject is unavailable.')
    }
  }
}
