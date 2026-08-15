import { randomUUID } from 'node:crypto'
import { decideHeadlessPermission } from '../../../../src/actions/agent-adapter/acp/permission-router.mjs'
import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'
import type { AcpPermissionView } from '../shared/contract'
import { PublicCommandError } from './command-registry'
import type { DesktopEventBus } from './event-bus'

interface PendingPermission {
  sessionId: string
  requestId: string
  options: Array<{ optionId: string; kind: string; name?: string }>
  view: AcpPermissionView
  resolve(response: { outcome: Record<string, unknown> }): void
  timer: NodeJS.Timeout
}

function publicPermission(value: AcpPermissionView): AcpPermissionView {
  return redactSecrets(value) as AcpPermissionView
}

function rejectResponse(options: PendingPermission['options']): Record<string, unknown> {
  const option = options.find((item) => item.kind === 'reject_once')
    ?? options.find((item) => item.kind === 'reject_always')
  return option
    ? { outcome: 'selected', optionId: option.optionId }
    : { outcome: 'cancelled' }
}

export class AcpPermissionBroker {
  private readonly pending = new Map<string, PendingPermission>()

  constructor(
    private readonly events: DesktopEventBus,
    private readonly timeoutMs = 5 * 60 * 1000
  ) {}

  handler(
    desktopSessionId: string,
    {
      permissionProfile,
      roots,
      onPendingChange
    }: {
      permissionProfile: string
      roots: string[]
      onPendingChange?: (pending: boolean) => void
    }
  ): ({ params }: { params: any }) => Promise<{ outcome: Record<string, unknown> }> {
    return async ({ params }) => {
      const advisory = decideHeadlessPermission({
        request: params,
        permissionProfile,
        roots
      })
      const options = (Array.isArray(params?.options) ? params.options : [])
        .filter((option: any) => option && typeof option.optionId === 'string')
        .map((option: any) => ({
          optionId: option.optionId,
          kind: String(option.kind ?? ''),
          name: typeof option.name === 'string' ? option.name : undefined
        }))
      const requestId = randomUUID()
      const view = publicPermission({
        session_id: desktopSessionId,
        request_id: requestId,
        tool_call_id: params?.toolCall?.toolCallId ?? null,
        title: params?.toolCall?.title ?? params?.toolCall?.name ?? 'Tool permission',
        tool_kind: advisory.kind,
        input_summary: advisory.inputSummary ?? '',
        paths: advisory.paths,
        options,
        reason: advisory.reason ?? null
      })
      const reviewable = advisory.allowed
        || advisory.reason === 'remote_write_requires_interactive_review'
      if (!reviewable) {
        const response = rejectResponse(options)
        this.events.publish({
          type: 'acp_permission_resolved',
          session_id: desktopSessionId,
          payload: redactSecrets({
            request_id: requestId,
            automatic: true,
            allowed: false,
            reason: advisory.reason,
            tool_kind: advisory.kind,
            paths: advisory.paths
          }) as Record<string, unknown>
        })
        return { outcome: response }
      }

      onPendingChange?.(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const current = this.pending.get(requestId)
          if (!current) return
          this.pending.delete(requestId)
          onPendingChange?.(this.hasPending(desktopSessionId))
          resolve({ outcome: rejectResponse(options) })
          this.events.publish({
            type: 'acp_permission_resolved',
            session_id: desktopSessionId,
            payload: { request_id: requestId, automatic: true, allowed: false, reason: 'timeout' }
          })
        }, this.timeoutMs)
        this.pending.set(requestId, {
          sessionId: desktopSessionId,
          requestId,
          options,
          view,
          resolve,
          timer
        })
        this.events.publish({
          type: 'acp_permission_requested',
          session_id: desktopSessionId,
          payload: {
            request_id: view.request_id,
            tool_call_id: view.tool_call_id,
            title: view.title,
            tool_kind: view.tool_kind,
            input_summary: view.input_summary,
            paths: view.paths,
            options: view.options,
            advisory: {
              reason: view.reason,
              remote: advisory.remote
            }
          }
        })
      })
    }
  }

  respond(sessionId: string, requestId: string, optionId?: string): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.sessionId !== sessionId) {
      throw new PublicCommandError('NOT_FOUND', 'Permission request is no longer pending.')
    }
    let outcome: Record<string, unknown>
    let allowed = false
    if (optionId) {
      const option = pending.options.find((item) => item.optionId === optionId)
      if (!option) throw new PublicCommandError('INVALID_REQUEST', 'Permission option is invalid.')
      outcome = { outcome: 'selected', optionId }
      allowed = option.kind === 'allow_once' || option.kind === 'allow_always'
    } else {
      outcome = { outcome: 'cancelled' }
    }
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.resolve({ outcome })
    this.events.publish({
      type: 'acp_permission_resolved',
      session_id: sessionId,
      payload: { request_id: requestId, automatic: false, allowed }
    })
  }

  cancelSession(sessionId: string, reason = 'session_cancelled'): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.events.publish({
        type: 'acp_permission_resolved',
        session_id: sessionId,
        payload: { request_id: requestId, automatic: true, allowed: false, reason }
      })
    }
  }

  hasPending(sessionId: string): boolean {
    return [...this.pending.values()].some((item) => item.sessionId === sessionId)
  }

  list(sessionId?: string): AcpPermissionView[] {
    return [...this.pending.values()]
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .map((item) => publicPermission(item.view))
  }
}
