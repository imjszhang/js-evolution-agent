import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopRuntimeContext } from '../src/main/runtime-context'

const roots: string[] = []
const originalProjectRoot = process.env.JEA_PROJECT_ROOT
const originalJeaHome = process.env.JEA_HOME

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  if (originalProjectRoot == null) delete process.env.JEA_PROJECT_ROOT
  else process.env.JEA_PROJECT_ROOT = originalProjectRoot
  if (originalJeaHome == null) delete process.env.JEA_HOME
  else process.env.JEA_HOME = originalJeaHome
})

describe('desktop runtime context', () => {
  it('keeps source root and JEA Home independent', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-desktop-source-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-desktop-home-'))
    roots.push(sourceRoot, jeaHome)
    process.env.JEA_HOME = jeaHome

    const context = resolveDesktopRuntimeContext(sourceRoot)

    expect(context.sourceRoot).toBe(sourceRoot)
    expect(context.jeaHome).toBe(jeaHome)
    expect(process.env.JEA_PROJECT_ROOT).toBe(sourceRoot)
    expect(process.env.JEA_HOME).toBe(jeaHome)
  })
})
