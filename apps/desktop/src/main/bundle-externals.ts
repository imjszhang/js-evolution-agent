import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
])

export function isDesktopMainExternal(id: string): boolean {
  if (id === 'electron' || id.startsWith('electron/')) return true
  if (builtins.has(id)) return true
  if (id.endsWith('.mjs')) return true
  if (id.includes('/src/') && (id.endsWith('.js') || id.endsWith('.mjs'))) return true
  return /^[@a-zA-Z]/.test(id)
}
