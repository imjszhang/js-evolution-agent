import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationRoot = fileURLToPath(new URL('../../src/renderer/src/conversation', import.meta.url))
const hostFiles = [
  fileURLToPath(new URL('../../src/renderer/src/App.tsx', import.meta.url)),
  fileURLToPath(new URL('../../src/renderer/src/main.tsx', import.meta.url)),
  fileURLToPath(new URL('../../src/renderer/src/DesktopRoot.tsx', import.meta.url))
]

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
  return files
}

describe('conversation architecture', () => {
  it('keeps feature slots on JeaClient and out of window.jea, HTTP, and filesystem writes', () => {
    const files = walk(conversationRoot).filter((file) => !file.endsWith('host-client.ts'))
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/window\.jea\b/)
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toMatch(/fetch\s*\(/)
      expect(source, file).not.toMatch(/writeFileSync|mkdirSync|rmSync/)
      expect(source, file).not.toMatch(/approval_granted/)
      expect(source, file).not.toMatch(/DEEPSEEK_API_KEY/)
    }
  })

  it('keeps desktop host entries free of direct window.jea feature-data calls', () => {
    for (const file of hostFiles) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/window\.jea\b/)
    }
  })
})
