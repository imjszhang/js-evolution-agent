export const JEA_INVOKE_CHANNEL = 'jea:invoke'

export const OPS_COMMANDS = [
  'ops.listSubjects',
  'ops.getDaemon',
  'ops.getObservability',
  'ops.refresh'
] as const

export type OpsCommand = (typeof OPS_COMMANDS)[number]

export interface InvokeRequest {
  command: string
  payload?: unknown
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
}

export interface JeaBridge {
  invoke<T = unknown>(command: OpsCommand, payload?: Record<string, unknown>): Promise<T>
}
