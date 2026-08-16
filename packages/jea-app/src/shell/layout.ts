export const WORKSPACE_MIN_WIDTH = 320
export const WORKSPACE_COMPACT_WIDTH = 960
export const LEFT_DEFAULT = 280
export const LEFT_MIN = 220
export const LEFT_MAX = 420
export const RIGHT_DEFAULT = 360
export const RIGHT_MIN = 280
export const RIGHT_MAX = 560
export const HANDLE_WIDTH = 8

export const LAYOUT_STORAGE_KEY = 'jea.workspace.layout'

export interface WorkspaceLayout {
  leftWidth: number
  rightWidth: number
  inspectorCollapsed: boolean
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function parseWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.leftWidth !== 'number' || typeof record.rightWidth !== 'number') return null
  return {
    leftWidth: clamp(record.leftWidth, LEFT_MIN, LEFT_MAX),
    rightWidth: clamp(record.rightWidth, RIGHT_MIN, RIGHT_MAX),
    inspectorCollapsed: Boolean(record.inspectorCollapsed)
  }
}

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {
    leftWidth: LEFT_DEFAULT,
    rightWidth: RIGHT_DEFAULT,
    inspectorCollapsed: false
  }
}

export function resizeLeft(layout: WorkspaceLayout, nextWidth: number): WorkspaceLayout {
  return { ...layout, leftWidth: clamp(nextWidth, LEFT_MIN, LEFT_MAX) }
}

export function resizeRight(layout: WorkspaceLayout, nextWidth: number): WorkspaceLayout {
  return { ...layout, rightWidth: clamp(nextWidth, RIGHT_MIN, RIGHT_MAX), inspectorCollapsed: false }
}

export function setInspectorCollapsed(layout: WorkspaceLayout, collapsed: boolean): WorkspaceLayout {
  return { ...layout, inspectorCollapsed: collapsed }
}

export function isCompactViewport(width: number): boolean {
  return width < WORKSPACE_COMPACT_WIDTH
}
