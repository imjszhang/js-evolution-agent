import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type { CliStatus } from '../types'

export interface CliLauncherPort {
  getStatus(): CliStatus
  install(): Promise<CliStatus> | CliStatus
  uninstall(): Promise<CliStatus> | CliStatus
}

export function createUnsupportedCliLauncher(): CliLauncherPort {
  const status: CliStatus = {
    installed: false,
    onPath: false,
    pathHint: '~/.local/bin/jea',
    supported: false,
    detail: 'CLI launcher installation is owned by the macOS packaging workstream.'
  }
  return {
    getStatus: () => status,
    install() {
      throw new PublicClientError('UNAVAILABLE', 'CLI installation is not available on this host.')
    },
    uninstall() {
      throw new PublicClientError('UNAVAILABLE', 'CLI uninstallation is not available on this host.')
    }
  }
}

export class CliCommandOwner {
  constructor(private readonly launcher: CliLauncherPort) {}

  getStatus(): CliStatus {
    return redactPublicValue(this.launcher.getStatus())
  }

  async install(): Promise<CliStatus> {
    return redactPublicValue(await this.launcher.install())
  }

  async uninstall(): Promise<CliStatus> {
    return redactPublicValue(await this.launcher.uninstall())
  }
}
