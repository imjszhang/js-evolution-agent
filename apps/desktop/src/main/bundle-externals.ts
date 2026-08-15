import { builtinModules } from 'node:module'
import { isAbsolute, win32 } from 'node:path'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
])

export function isDesktopMainExternal(id: string): boolean {
  if (id === 'electron' || id.startsWith('electron/')) return true
  if (builtins.has(id)) return true
  if (id.endsWith('.mjs')) return true
  const normalized = id.replaceAll('\\', '/')
  if (normalized.includes('/src/') && (id.endsWith('.js') || id.endsWith('.mjs'))) return true
  if (isAbsolute(id) || win32.isAbsolute(id)) return false
  return /^[@a-zA-Z]/.test(id)
}
