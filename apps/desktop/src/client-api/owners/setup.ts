import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createSubject,
  getSubjectEntry,
  listRegisteredSubjects,
  readSubjectsRegistry,
  sanitizeSubjectName,
  updateSubjectsRegistry
} from '../../../../../src/infra/subjects.mjs'
import { initData } from '../../../../../src/cli/commands/data.mjs'
import { resolveDesktopConfig } from '../../../../../src/channel/adapters/desktop/config.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type { CliStatus, SetupHomeResult, SetupReadiness, SetupSubjectResult } from '../types'
import { requireSubject, subjectRuntime, type ClientRuntimeContext } from './runtime'

export interface HomePort {
  resolve(requested?: string): SetupHomeResult
}

export function createInjectedHomePort(runtime: ClientRuntimeContext): HomePort {
  return {
    resolve(requested?: string): SetupHomeResult {
      const path = requested?.trim() ? resolve(requested.trim()) : runtime.jeaHome
      if (!isAbsolute(path)) {
        throw new PublicClientError('INVALID_REQUEST', 'A valid path is required.')
      }
      let writable = false
      try {
        mkdirSync(path, { recursive: true })
        accessSync(path, constants.W_OK)
        writable = true
      } catch {
        writable = false
      }
      return {
        path,
        source: requested?.trim() ? 'requested' : runtime.jeaHomeSource,
        writable
      }
    }
  }
}

function desktopEnabled(runtime: ClientRuntimeContext, subject: string): boolean {
  try {
    return resolveDesktopConfig(runtime, subject).enabled === true
  } catch {
    return Boolean(getSubjectEntry(runtime, subject)?.channels?.desktop?.enabled)
  }
}

function enableDesktopChannelEntry(entry: Record<string, unknown> = {}): Record<string, unknown> {
  const channels = (entry.channels && typeof entry.channels === 'object' && !Array.isArray(entry.channels))
    ? { ...(entry.channels as Record<string, unknown>) }
    : {}
  const desktop = (channels.desktop && typeof channels.desktop === 'object' && !Array.isArray(channels.desktop))
    ? { ...(channels.desktop as Record<string, unknown>) }
    : {}
  const presence = (channels.presence && typeof channels.presence === 'object' && !Array.isArray(channels.presence))
    ? { ...(channels.presence as Record<string, unknown>) }
    : {}
  return {
    ...entry,
    channels: {
      ...channels,
      desktop: {
        ...desktop,
        enabled: true,
        default_session: desktop.default_session ?? desktop.defaultSession ?? 'main'
      },
      presence: {
        ...presence,
        default_transport: presence.default_transport ?? 'desktop',
        default_target: presence.default_target ?? 'desktop:main'
      }
    }
  }
}

export class SetupCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly homePort: HomePort,
    private readonly cliStatus: () => CliStatus
  ) {}

  getReadiness(subject?: string): SetupReadiness {
    const registry = readSubjectsRegistry(this.runtime)
    const names = listRegisteredSubjects(this.runtime) as string[]
    const selected = subject?.trim()
      ? requireSubject(this.runtime, subject)
      : registry.default_subject ?? names[0] ?? null
    const initialized = selected
      ? existsSync(join(subjectRuntime(this.runtime, selected).runtimeRoot, 'data', 'evolution'))
      : false
    const modelConfigured = Boolean(process.env.DEEPSEEK_API_KEY)
    return redactPublicValue({
      jeaHome: {
        path: this.runtime.jeaHome,
        source: this.runtime.jeaHomeSource,
        writable: this.homePort.resolve().writable
      },
      subjects: {
        count: names.length,
        defaultSubject: registry.default_subject ?? null,
        names
      },
      model: {
        configured: modelConfigured,
        mode: modelConfigured ? 'deepseek' : 'mock'
      },
      data: { initialized },
      conversation: {
        desktopChannelEnabled: selected ? desktopEnabled(this.runtime, selected) : false,
        subject: selected
      },
      cli: this.cliStatus()
    })
  }

  confirmHome(path?: string): SetupHomeResult {
    const home = this.homePort.resolve(path)
    if (!home.writable) {
      throw new PublicClientError('OPERATION_FAILED', 'The requested JEA Home is not writable.')
    }
    return redactPublicValue(home)
  }

  createSubject(name: string, { enableDesktopChannel = true } = {}): SetupSubjectResult {
    const subject = sanitizeSubjectName(name)
    if (!subject) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid name is required.')
    }
    const result = createSubject(this.runtime, subject)
    if (enableDesktopChannel && !result.skipped) {
      this.enableDesktopChannel(subject)
    }
    return redactPublicValue({
      name: subject,
      created: Boolean(result.written),
      skipped: Boolean(result.skipped),
      desktopChannelEnabled: desktopEnabled(this.runtime, subject)
    })
  }

  initData(subject: string): { subject: string; initialized: boolean } {
    const name = requireSubject(this.runtime, subject)
    initData(this.runtime, { all: true, subject: name })
    return { subject: name, initialized: true }
  }

  enableDesktopChannel(subject: string): SetupSubjectResult {
    const name = requireSubject(this.runtime, subject)
    updateSubjectsRegistry(this.runtime, (registry: {
      default_subject?: string
      subjects: Record<string, Record<string, unknown>>
    }) => ({
      ...registry,
      subjects: {
        ...registry.subjects,
        [name]: enableDesktopChannelEntry(registry.subjects[name] ?? getSubjectEntry(this.runtime, name) ?? {})
      }
    }))
    return redactPublicValue({
      name,
      created: false,
      skipped: false,
      desktopChannelEnabled: true
    })
  }
}
