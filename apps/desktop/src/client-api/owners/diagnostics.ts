import { homedir } from 'node:os'
import { webHostStatusView } from '../../web-host/lifecycle'
import { loadBuildMetadata } from '../../../../../src/product/build-metadata.mjs'
import {
  ownedDaemonLogPaths,
  readDaemonStartupFailure,
  readProcessFailures,
} from '../../../../../src/product/diagnostics-store.mjs'
import { redactMachinePaths } from '../../../../../src/product/path-redact.mjs'
import { redactPublicValue } from '../redact'
import type { DiagnosticReport, SettingsView } from '../types'
import { fromSubjectReadiness, projectOperationalReadiness } from './operational-readiness'
import type { ClientRuntimeContext } from './runtime'
import type { ServiceCommandOwner } from './service'
import type { SetupCommandOwner } from './setup'

interface BuildIdentity {
  version: string
  commit: string | null
  commit_short: string | null
  dirty: boolean | null
  built_at: string | null
  platform: string | null
  arch: string | null
  build_id: string
}

export class DiagnosticsCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly setup: SetupCommandOwner,
    private readonly service: ServiceCommandOwner,
    private readonly settings: { get(): SettingsView }
  ) {}

  exportDiagnostics({
    subject,
    redactPaths = true,
  }: {
    subject?: string
    redactPaths?: boolean
  } = {}): DiagnosticReport {
    const setup = this.setup.getReadiness(subject)
    const selected = subject?.trim()
      || setup.subjects.defaultSubject
      || setup.conversation.subject
      || null
    const settings = this.settings.get()
    const metadata = loadBuildMetadata({ sourceRoot: this.runtime.sourceRoot })
    let readiness
    if (selected) {
      try {
        readiness = fromSubjectReadiness(this.service.getReadiness(selected))
      } catch {
        readiness = null
      }
    }
    if (!readiness) {
      let service = null
      if (selected) {
        try {
          service = this.service.getStatus(selected)
        } catch {
          service = null
        }
      }
      const web = webHostStatusView(this.runtime.jeaHome) as { running?: boolean }
      readiness = projectOperationalReadiness({ setup, service, web })
    }
    const startupFailure = selected
      ? readDaemonStartupFailure(this.runtime, selected)
      : readDaemonStartupFailure(this.runtime)
    const logPaths = selected ? ownedDaemonLogPaths(this.runtime, selected) : null
    const report: DiagnosticReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      product: productView(metadata, settings),
      host: {
        jea_home: this.runtime.jeaHome,
        jea_home_source: this.runtime.jeaHomeSource,
        subject: selected,
      },
      readiness,
      daemon: {
        log_paths: logPaths,
        last_startup_failure: startupFailure,
      },
      process_failures: readProcessFailures(this.runtime),
    }
    const publicReport = redactPublicValue(report)
    if (!redactPaths) return publicReport
    return redactMachinePaths(publicReport, {
      home: homedir(),
      jeaHome: this.runtime.jeaHome,
    }) as DiagnosticReport
  }
}

function productView(metadata: BuildIdentity, settings: SettingsView) {
  return {
    version: settings.appVersion || metadata.version,
    commit: metadata.commit,
    commit_short: metadata.commit_short || settings.commitShort || null,
    built_at: metadata.built_at || settings.buildTime || null,
    platform: metadata.platform || settings.platform || process.platform,
    architecture: metadata.arch || settings.architecture || process.arch,
    dirty: metadata.dirty,
    build_id: metadata.build_id,
  }
}
