import { randomUUID } from 'node:crypto'
import { decideHeadlessPermission } from '../../../../src/actions/agent-adapter/acp/permission-router.mjs'
import { PublicCommandError } from './command-registry'
import type { DesktopEventBus } from './event-bus'

interface PendingPermission {
  sessionId: string
  requestId: string
  options: Array<{ optionId: string; kind: string; name?: string }>
  resolve(response: { outcome: Record<string, unknown> }): void
  timer: NodeJS.Timeout
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
      const unsafe = advisory.remote
        || advisory.reason === 'unknown_request_default_deny'
        || advisory.reason === 'unknown_profile_default_deny'
        || advisory.reason === 'workspace_write_outside_or_unknown_path'
        || advisory.reason === 'read_only_write_denied'
      if (unsafe) {
        const response = rejectResponse(options)
        this.events.publish({
          type: 'acp_permission_resolved',
          session_id: desktopSessionId,
          payload: {
            automatic: true,
            allowed: false,
            reason: advisory.reason,
            tool_kind: advisory.kind,
            paths: advisory.paths
          }
        })
        return { outcome: response }
      }

      const requestId = randomUUID()
      onPendingChange?.(true)
      this.events.publish({
        type: 'acp_permission_requested',
        session_id: desktopSessionId,
        payload: {
          request_id: requestId,
          tool_call_id: params?.toolCall?.toolCallId ?? null,
          title: params?.toolCall?.title ?? params?.toolCall?.name ?? 'Tool permission',
          tool_kind: advisory.kind,
          paths: advisory.paths,
          options,
          advisory: {
            reason: advisory.reason,
            remote: advisory.remote
          }
        }
      })

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
          resolve,
          timer
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
}
