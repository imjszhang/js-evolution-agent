import type { ConversationMessage } from '../../../client-api/types'

export const MAX_CHANNEL_RECORDS = 400

export type WorkspaceMessage = ConversationMessage & {
  content_type?: string | null
  metadata?: Record<string, unknown> | null
  card?: unknown
  target?: string | null
}

export function messageKey(record: Pick<WorkspaceMessage, 'id' | 'offset' | 'message_id'>): string {
  return record.id || record.message_id || `offset:${record.offset}`
}

export function mergeRecords<T extends WorkspaceMessage>(
  current: T[],
  incoming: T[]
): T[] {
  const records = new Map(current.map((record) => [messageKey(record), record]))
  for (const record of incoming) records.set(messageKey(record), record)
  return [...records.values()]
    .sort((a, b) => a.offset - b.offset || a.created_at.localeCompare(b.created_at))
    .slice(-MAX_CHANNEL_RECORDS)
}

export function hasAssistantAfter(
  records: WorkspaceMessage[],
  createdAt: string | null
): boolean {
  if (!createdAt) {
    return records.some((record) => record.role === 'assistant')
  }
  return records.some((record) => (
    record.role === 'assistant' && record.created_at.localeCompare(createdAt) >= 0
  ))
}
