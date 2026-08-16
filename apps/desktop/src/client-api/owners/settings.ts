import { join } from 'node:path'
import { readJsonSafe, writeJsonFile } from '../../../../../src/infra/files.mjs'
import { readSubjectsRegistry, setDefaultSubject } from '../../../../../src/infra/subjects.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type { SettingsPatch, SettingsView } from '../types'
import { requireSubject, type ClientRuntimeContext } from './runtime'

const SETTINGS_FILE = 'client-settings.json'

export class SettingsCommandOwner {
  constructor(
    private readonly runtime: ClientRuntimeContext,
    private readonly versions: { appVersion: string; cliVersion: string }
  ) {}

  get(): SettingsView {
    const stored = (readJsonSafe(this.file(), null) ?? {}) as Record<string, unknown>
    const registry = readSubjectsRegistry(this.runtime)
    return redactPublicValue({
      language: stored.language === 'en' ? 'en' : 'zh-CN',
      theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : 'system',
      defaultSubject: registry.default_subject ?? null,
      appVersion: this.versions.appVersion,
      cliVersion: this.versions.cliVersion
    })
  }

  set(patch: SettingsPatch): SettingsView {
    const current = this.get()
    if (patch.language != null && patch.language !== 'zh-CN' && patch.language !== 'en') {
      throw new PublicClientError('INVALID_REQUEST', 'A valid language is required.')
    }
    if (patch.theme != null && !['system', 'light', 'dark'].includes(patch.theme)) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid theme is required.')
    }
    if (patch.defaultSubject) {
      requireSubject(this.runtime, patch.defaultSubject)
      setDefaultSubject(this.runtime, patch.defaultSubject)
    }
    writeJsonFile(this.file(), {
      language: patch.language ?? current.language,
      theme: patch.theme ?? current.theme
    })
    return this.get()
  }

  private file(): string {
    return join(this.runtime.jeaHome, SETTINGS_FILE)
  }
}
