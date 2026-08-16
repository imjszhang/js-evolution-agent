import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManagedCliLauncher } from '../src/main/cli-launcher'
import { PublicClientError } from '../src/client-api/errors'

describe('desktop managed CLI launcher port', () => {
  it('reports unsupported without a packaged app and does not leak secrets', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-desktop-cli-'))
    const launcher = createManagedCliLauncher({
      sourceRoot: root,
      env: { PATH: root, DEEPSEEK_API_KEY: 'sk-secret-value' },
      execPath: join(root, 'node')
    })
    const status = launcher.getStatus()
    expect(status.supported).toBe(false)
    expect(JSON.stringify(status)).not.toContain('sk-secret-value')
    expect(() => launcher.install()).toThrow(PublicClientError)
  })

  it('installs a managed launcher for a fake JEA.app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-desktop-cli-app-'))
    const appPath = join(root, 'JEA.app')
    const sourceRoot = join(appPath, 'Contents', 'Resources', 'app')
    mkdirSync(join(sourceRoot, 'src', 'cli'), { recursive: true })
    mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(sourceRoot, 'oada.config.mjs'), 'export default {}\n')
    writeFileSync(join(sourceRoot, 'src', 'cli', 'jea.mjs'), 'export {}\n')
    writeFileSync(join(appPath, 'Contents', 'MacOS', 'JEA'), '#!/bin/sh\n')
    chmodSync(join(appPath, 'Contents', 'MacOS', 'JEA'), 0o755)
    const binDir = join(root, '.local', 'bin')
    const launcher = createManagedCliLauncher({
      sourceRoot,
      env: { JEA_APP_PATH: appPath, JEA_CLI_BIN_DIR: binDir, PATH: binDir },
      execPath: join(appPath, 'Contents', 'MacOS', 'JEA')
    })
    const status = await launcher.install()
    expect(status.installed).toBe(true)
    expect(status.supported).toBe(true)
    expect(status.pathHint).toBe('~/.local/bin/jea')
  })
})
