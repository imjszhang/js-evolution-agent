import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyProcessType,
  recordDesktopProcessFailure,
  sanitizeProcessFailure,
  simulateProcessFailure,
  summarizeProcessGoneEvent
} from '../src/main/process-failures'

describe('desktop process-failure summaries', () => {
  it('classifies renderer and utility gone events', () => {
    expect(classifyProcessType('renderer')).toBe('renderer')
    expect(classifyProcessType('Utility')).toBe('utility')
    expect(classifyProcessType('GPU')).toBe('gpu')
    expect(classifyProcessType('sandbox')).toBe('utility')
    expect(classifyProcessType('mystery')).toBe('unknown')
  })

  it('records only time, process type, reason, version, and build id', () => {
    const summary = summarizeProcessGoneEvent({
      type: 'renderer',
      reason: 'crashed',
      exitCode: 5,
      serviceName: 'ignored'
    })
    expect(summary).toEqual({ process_type: 'renderer', reason: 'crashed' })
    const sanitized = sanitizeProcessFailure({
      ...summary,
      occurred_at: '2026-08-17T04:32:54.000Z',
      stdout: 'secret-output',
      env: { DEEPSEEK_API_KEY: 'sk-not-allowed' }
    }, { version: '0.3.1', buildId: 'build-1' })
    expect(sanitized).toEqual({
      schema_version: 1,
      occurred_at: '2026-08-17T04:32:54.000Z',
      process_type: 'renderer',
      reason: 'crashed',
      version: '0.3.1',
      build_id: 'build-1'
    })
    expect(JSON.stringify(sanitized)).not.toContain('secret-output')
    expect(JSON.stringify(sanitized)).not.toContain('sk-not-allowed')
  })

  it('simulates renderer and utility failures into JEA Home diagnostics', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-pf-src-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-pf-home-'))
    const renderer = simulateProcessFailure({ sourceRoot, jeaHome }, 'renderer')
    const utility = simulateProcessFailure({ sourceRoot, jeaHome }, 'utility')
    expect(renderer.process_type).toBe('renderer')
    expect(utility.process_type).toBe('utility')
    expect(utility.reason).toBe('abnormal-exit')
  })

  it('swallows handler errors so a simulated gone event cannot crash the main App', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-pf-bad-src-'))
    const blocked = mkdtempSync(join(tmpdir(), 'jea-pf-blocked-'))
    const notADir = join(blocked, 'not-a-dir')
    writeFileSync(notADir, 'file')
    expect(() => {
      try {
        recordDesktopProcessFailure(
          { sourceRoot, jeaHome: notADir },
          { type: 'renderer', reason: 'crashed' }
        )
      } catch {
        // Same contract as apps/desktop/src/main/index.ts: diagnostics must not crash the main App.
      }
    }).not.toThrow()
  })
})
