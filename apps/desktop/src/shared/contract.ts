export const JEA_INVOKE_CHANNEL = 'jea:invoke'
export const JEA_EVENT_CHANNEL = 'jea:event'

export const OPS_COMMANDS = [
  'ops.listSubjects',
  'ops.getDaemon',
  'ops.getObservability',
  'ops.refresh'
] as const

export const TODO_COMMANDS = [
  'todo.get',
  'todo.putBrief',
  'todo.putFact',
  'todo.resolveQuestion',
  'todo.requestCycle',
  'todo.updateGoals'
] as const

export const DAEMON_COMMANDS = [
  'daemon.getSupervisor',
  'daemon.startManaged',
  'daemon.stopManaged'
] as const

export const PROJECTION_COMMANDS = [
  'projection.watch',
  'projection.refresh',
  'projection.stop'
] as const

export const CHANNEL_COMMANDS = [
  'channel.get',
  'channel.listSessions',
  'channel.readSession',
  'channel.listInbound',
  'channel.sendMessage'
] as const

export const NOTIFICATION_COMMANDS = [
  'notifications.get',
  'notifications.set'
] as const

export const ACP_COMMANDS = [
  'acp.listFrameworks',
  'acp.chooseExecutionRoot',
  'acp.listSessions',
  'acp.listPermissions',
  'acp.startSession',
  'acp.prompt',
  'acp.cancelSession',
  'acp.closeSession',
  'acp.respondPermission',
  'acp.setConfigOption'
] as const

export const DESKTOP_COMMANDS = [
  ...OPS_COMMANDS,
  ...TODO_COMMANDS,
  ...DAEMON_COMMANDS,
  ...PROJECTION_COMMANDS,
  ...CHANNEL_COMMANDS,
  ...NOTIFICATION_COMMANDS,
  ...ACP_COMMANDS
] as const

export type OpsCommand = (typeof OPS_COMMANDS)[number]
export type TodoCommand = (typeof TODO_COMMANDS)[number]
export type DaemonCommand = (typeof DAEMON_COMMANDS)[number]
export type ProjectionCommand = (typeof PROJECTION_COMMANDS)[number]
export type ChannelCommand = (typeof CHANNEL_COMMANDS)[number]
export type NotificationCommand = (typeof NOTIFICATION_COMMANDS)[number]
export type AcpCommand = (typeof ACP_COMMANDS)[number]
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number]

export type PublicErrorCode =
  | 'COMMAND_NOT_ALLOWED'
  | 'INVALID_REQUEST'
  | 'OPERATION_FAILED'
  | 'CONFLICT'
  | 'NOT_FOUND'

export interface InvokeRequest {
  command: string
  payload?: unknown
}

export type InvokeResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: PublicErrorCode; message: string } }

export interface JeaEventEnvelope {
  type: string
  ts: string
  subject?: string
  session_id?: string
  payload: Record<string, unknown>
}

export interface SubjectSummary {
  name: string
  namespace: string
  isDefault: boolean
}

export interface SubjectSnapshot {
  subject: SubjectSummary
  daemon: Record<string, any>
  observability: Record<string, any>
  supervisor?: DaemonSupervisorView
}

export type DaemonSupervisorMode =
  | 'none'
  | 'attached'
  | 'managed'
  | 'stale'
  | 'zombie'
  | 'stopping'

export interface DaemonSupervisorView {
  subject: string
  mode: DaemonSupervisorMode
  pid: number | null
  domain: 'all' | 'cycle' | 'channel' | null
  heartbeat_at: string | null
  started_at: string | null
  log_paths?: { stdout: string; stderr: string } | null
  detail?: string | null
}

export interface TodoSnapshot {
  subject: string
  questions: Record<string, unknown>[]
  briefs: Record<string, unknown>[]
  facts: Record<string, unknown>[]
  goals: Record<string, unknown> | null
  pending_cycle_request: Record<string, unknown> | null
  attention: Record<string, unknown>
}

export interface DesktopSessionRecord {
  id: string
  session_id: string
  role: 'user' | 'assistant' | string
  direction: 'inbound' | 'outbound' | string
  content: string
  created_at: string
  offset: number
  message_id?: string | null
  metadata?: Record<string, unknown>
}

export interface DesktopSessionSummary {
  session_id: string
  target: string
  message_count: number
  last_message_at: string | null
}

export interface DesktopSessionPage {
  schema_version: number
  subject: string
  session_id: string
  records: DesktopSessionRecord[]
  offset: number
  next_offset: number
  total: number
}

export interface ChannelSnapshot {
  subject: string
  projection: Record<string, any>
  sessions: DesktopSessionSummary[]
  inbound: {
    pending: Record<string, unknown>[]
    processed: Record<string, unknown>[]
  }
}

export interface AcpFrameworkView {
  id: string
  provider: string
  available: boolean
  version: string | null
  node_compatible: boolean
  credentials_configured: boolean
  error: string | null
}

export type AcpSessionStatus =
  | 'starting'
  | 'ready'
  | 'prompting'
  | 'awaiting_permission'
  | 'cancelling'
  | 'closing'
  | 'closed'
  | 'error'

export interface AcpSessionView {
  id: string
  acp_session_id: string | null
  framework: string
  execution_root: string
  status: AcpSessionStatus
  pid: number | null
  created_at: string
  config_options: Record<string, unknown>[]
  error: string | null
}

export interface AcpPermissionView {
  session_id: string
  request_id: string
  tool_call_id: string | null
  title: string
  tool_kind: string
  input_summary: string
  paths: string[]
  options: Array<{ optionId: string; kind: string; name?: string }>
  reason: string | null
}

export interface JeaBridge {
  invoke<T = unknown>(command: DesktopCommand, payload?: Record<string, unknown>): Promise<T>
  subscribe(listener: (event: JeaEventEnvelope) => void): () => void
}
