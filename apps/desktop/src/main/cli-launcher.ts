import { PublicClientError } from '../client-api/errors'
import type { CliLauncherPort } from '../client-api/owners/cli'
import type { CliStatus } from '../client-api/types'
import {
  CliLauncherError,
  getCliLauncherStatus,
  installCliLauncher,
  uninstallCliLauncher
} from '../../../../src/product/cli-launcher.mjs'

export function createManagedCliLauncher(options: {
  sourceRoot: string
  env?: NodeJS.ProcessEnv
  execPath?: string
} = { sourceRoot: process.cwd() }): CliLauncherPort {
  const base = {
    sourceRoot: options.sourceRoot,
    env: options.env ?? process.env,
    execPath: options.execPath ?? process.execPath
  }

  const toStatus = (status: ReturnType<typeof getCliLauncherStatus>): CliStatus => ({
    installed: status.installed,
    onPath: status.onPath,
    pathHint: status.pathHint,
    supported: status.supported,
    detail: status.detail
  })

  const wrap = (error: unknown): never => {
    if (error instanceof CliLauncherError) {
      throw new PublicClientError(error.code, error.message)
    }
    throw error
  }

  return {
    getStatus: () => toStatus(getCliLauncherStatus(base)),
    install(): CliStatus {
      try {
        return toStatus(installCliLauncher(base))
      } catch (error) {
        return wrap(error)
      }
    },
    uninstall(): CliStatus {
      try {
        return toStatus(uninstallCliLauncher(base))
      } catch (error) {
        return wrap(error)
      }
    }
  }
}
