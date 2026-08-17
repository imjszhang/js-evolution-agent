import { recordProcessFailure, sanitizeProcessFailure } from '../../../../src/product/diagnostics-store.mjs'
import { loadBuildMetadata } from '../../../../src/product/build-metadata.mjs'
import type { DesktopRuntimeContext } from './runtime-context'

const PROCESS_TYPES = new Set(['renderer', 'utility', 'gpu', 'unknown'])

export function classifyProcessType(type: string | undefined): 'renderer' | 'utility' | 'gpu' | 'unknown' {
  const value = String(type || '').toLowerCase()
  if (value.includes('render')) return 'renderer'
  if (value.includes('gpu')) return 'gpu'
  if (value.includes('utility') || value.includes('plugin') || value.includes('sandbox')) return 'utility'
  if (PROCESS_TYPES.has(value)) return value as 'renderer' | 'utility' | 'gpu' | 'unknown'
  return 'unknown'
}

export function summarizeProcessGoneEvent(event: {
  type?: string
  reason?: string
  exitCode?: number
  serviceName?: string
}): { process_type: 'renderer' | 'utility' | 'gpu' | 'unknown'; reason: string } {
  return {
    process_type: classifyProcessType(event.type || event.serviceName),
    reason: String(event.reason || 'unknown').slice(0, 64)
  }
}

export function recordDesktopProcessFailure(
  runtime: Pick<DesktopRuntimeContext, 'sourceRoot' | 'jeaHome'>,
  event: { type?: string; reason?: string; exitCode?: number; serviceName?: string },
  identity?: { version?: string; build_id?: string }
) {
  const metadata = loadBuildMetadata({ sourceRoot: runtime.sourceRoot, collect: false })
  const summary = summarizeProcessGoneEvent(event)
  return recordProcessFailure(runtime, {
    ...summary,
    occurred_at: new Date().toISOString()
  }, {
    version: identity?.version || metadata.version,
    build_id: identity?.build_id || metadata.build_id
  })
}

export function simulateProcessFailure(
  runtime: Pick<DesktopRuntimeContext, 'sourceRoot' | 'jeaHome'>,
  kind: 'renderer' | 'utility' = 'renderer'
) {
  return recordDesktopProcessFailure(runtime, {
    type: kind,
    reason: kind === 'renderer' ? 'crashed' : 'abnormal-exit'
  })
}

export { sanitizeProcessFailure }
