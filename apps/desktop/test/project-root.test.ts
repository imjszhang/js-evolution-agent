import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findProjectRoot, resolveDesktopProjectRoot } from '../src/main/project-root'
import { isDesktopMainExternal } from '../src/main/bundle-externals'
import { toIpcValue } from '../src/main/ipc-value'
import {
  isTrustedRendererLocation,
  resolveDevRendererUrl
} from '../src/main/renderer-security'

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
    const explicit = join(tmpdir(), 'explicit-jea')
    expect(resolveDesktopProjectRoot({
      env: { JEA_PROJECT_ROOT: explicit },
      cwd: tmpdir(),
      fallback: tmpdir()
    })).toBe(explicit)
  })

  it('resolves a packaged JEA.app Resources/app tree from JEA_APP_PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-packaged-root-'))
    const appPath = join(root, 'JEA.app')
    const sourceRoot = join(appPath, 'Contents', 'Resources', 'app')
    mkdirSync(join(sourceRoot, 'src', 'cli'), { recursive: true })
    mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(sourceRoot, 'oada.config.mjs'), 'export default {}\n')
    writeFileSync(join(sourceRoot, 'src', 'cli', 'jea.mjs'), 'export {}\n')
    writeFileSync(join(appPath, 'Contents', 'MacOS', 'JEA'), '#!/bin/sh\n')

    expect(resolveDesktopProjectRoot({
      env: { JEA_APP_PATH: appPath },
      cwd: tmpdir(),
      fallback: tmpdir(),
      execPath: join(appPath, 'Contents', 'MacOS', 'JEA')
    })).toBe(sourceRoot)
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
    expect(isDesktopMainExternal('D:\\repo\\apps\\desktop\\src\\main\\acp-session-manager.ts')).toBe(false)
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

describe('renderer URL security', () => {
  it('allows only unauthenticated loopback development URLs', () => {
    expect(resolveDevRendererUrl('http://localhost:5173')).toBe('http://localhost:5173/')
    expect(resolveDevRendererUrl('https://127.0.0.1:4173/app')).toBe(
      'https://127.0.0.1:4173/app'
    )
    expect(resolveDevRendererUrl(undefined)).toBeNull()
    expect(() => resolveDevRendererUrl('https://example.com')).toThrow(/loopback/)
    expect(() => resolveDevRendererUrl('file:///tmp/renderer.html')).toThrow(/loopback/)
    expect(() => resolveDevRendererUrl('http://user:pass@localhost:5173')).toThrow(/loopback/)
  })

  it('accepts only the configured renderer location', () => {
    expect(isTrustedRendererLocation('http://localhost:5173/app', {
      devRendererUrl: 'http://localhost:5173/',
      productionRendererUrl: 'file:///app/index.html'
    })).toBe(true)
    expect(isTrustedRendererLocation('http://127.0.0.1:5173/app', {
      devRendererUrl: 'http://localhost:5173/',
      productionRendererUrl: 'file:///app/index.html'
    })).toBe(false)
    expect(isTrustedRendererLocation('file:///app/index.html', {
      devRendererUrl: null,
      productionRendererUrl: 'file:///app/index.html'
    })).toBe(true)
    expect(isTrustedRendererLocation('file:///tmp/other.html', {
      devRendererUrl: null,
      productionRendererUrl: 'file:///app/index.html'
    })).toBe(false)
  })
})
