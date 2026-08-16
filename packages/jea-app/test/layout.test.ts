import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceLayout,
  isCompactViewport,
  resizeLeft,
  resizeRight,
  setInspectorCollapsed
} from '../src/shell/layout'

describe('workspace layout', () => {
  it('resizes and collapses the inspector without dropping center identity', () => {
    const start = defaultWorkspaceLayout()
    const resized = resizeRight(resizeLeft(start, 300), 400)
    const collapsed = setInspectorCollapsed(resized, true)
    const expanded = setInspectorCollapsed(collapsed, false)
    expect(resized.leftWidth).toBe(300)
    expect(resized.rightWidth).toBe(400)
    expect(collapsed.inspectorCollapsed).toBe(true)
    expect(expanded.inspectorCollapsed).toBe(false)
    expect(expanded.rightWidth).toBe(400)
    expect(isCompactViewport(959)).toBe(true)
    expect(isCompactViewport(960)).toBe(false)
  })
})
