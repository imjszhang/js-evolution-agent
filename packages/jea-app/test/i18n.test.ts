import { describe, expect, it } from 'vitest'
import { messages, resolveLocale, t } from '../src/i18n/messages'

describe('shell i18n', () => {
  it('covers primary shell, navigation, and global-state copy in English and Chinese', () => {
    const keys = Object.keys(messages.en)
    expect(keys).toEqual(Object.keys(messages.zh))
    for (const key of keys) {
      expect(messages.en[key as keyof typeof messages.en].length).toBeGreaterThan(0)
      expect(messages.zh[key as keyof typeof messages.zh].length).toBeGreaterThan(0)
    }
    expect(t('zh', 'settings')).toBe('设置')
    expect(t('en', 'settings')).toBe('Settings')
    expect(t('zh', 'offlineTitle')).toContain('离线')
    expect(resolveLocale('zh', 'en-US')).toBe('zh')
    expect(resolveLocale(null, 'zh-CN')).toBe('zh')
    expect(resolveLocale(null, 'en-US')).toBe('en')
  })
})
