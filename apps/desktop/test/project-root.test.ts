import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findProjectRoot, resolveDesktopProjectRoot } from '../src/main/project-root'
import { isDesktopMainExternal } from '../src/main/bundle-externals'
import { toIpcValue } from '../src/main/ipc-value'

describe('desktop project root', () => {
  it('walks up to the JEA marker files', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-desktop-root-'))
    mkdirSync(join(root, 'src', 'cli'), { recursive: true })
    writeFileSync(join(root, 'oada.config.mjs'), 'export default {}\n')
    writeFileSync(join(root, 'src', 'cli', 'jea.mjs'), 'export {}\n')
    const nested = join(root, 'apps', 'desktop', 'out', 'main')
    mkdirSync(nested, { recursive: true })

    expect(findProjectRoot(nested)).toBe(root)
    expect(resolveDesktopProjectRoot({
      env: {},
      cwd: nested,
      fallback: nested
    })).toBe(root)
  })

  it('prefers JEA_PROJECT_ROOT over marker discovery', () => {
    expect(resolveDesktopProjectRoot({
      env: { JEA_PROJECT_ROOT: '/tmp/explicit-jea' },
      cwd: '/tmp',
      fallback: '/tmp'
    })).toBe('/tmp/explicit-jea')
  })
})

describe('desktop main externals', () => {
  it('keeps Electron, Node builtins and JEA source modules unbundled', () => {
    expect(isDesktopMainExternal('electron')).toBe(true)
    expect(isDesktopMainExternal('node:fs')).toBe(true)
    expect(isDesktopMainExternal('fs')).toBe(true)
    expect(isDesktopMainExternal('dotenv')).toBe(true)
    expect(isDesktopMainExternal('../../../../src/daemon/daemon-projection.mjs')).toBe(true)
    expect(isDesktopMainExternal('/workspace/src/infra/project.mjs')).toBe(true)
    expect(isDesktopMainExternal('./command-registry')).toBe(false)
    expect(isDesktopMainExternal('\0vite/preload')).toBe(false)
  })
})

describe('ipc value sanitization', () => {
  it('returns JSON-safe clones and rejects cycles', () => {
    const value = { name: 'alpha', nested: { ok: true }, skipped: undefined }
    expect(toIpcValue(value)).toEqual({ name: 'alpha', nested: { ok: true } })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => toIpcValue(cyclic)).toThrow(/ipc_value_not_serializable/)
  })
})
