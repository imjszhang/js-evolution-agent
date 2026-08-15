export function toIpcValue<T>(value: T): T {
  if (value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    throw new Error('ipc_value_not_serializable')
  }
}
