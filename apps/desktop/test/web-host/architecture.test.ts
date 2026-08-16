import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const webHostRoot = fileURLToPath(new URL('../../src/web-host', import.meta.url))

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.(ts|js|mjs)$/.test(entry)) files.push(full)
  }
  return files
}

describe('Web host architecture', () => {
  it('stays headless and does not own Viewer api-core business commands', () => {
    const files = walk(webHostRoot)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).not.toMatch(/from ['"]electron['"]/)
      expect(source, file).not.toMatch(/BrowserWindow/)
      expect(source, file).not.toMatch(/createViewerApiServer/)
      expect(source, file).not.toMatch(/api-core\.mjs/)
    }
  })

  it('routes application commands through the Client API host', () => {
    const host = readFileSync(join(webHostRoot, 'host.ts'), 'utf8')
    expect(host).toContain('createApplicationCommandHost')
    expect(host).toContain('isWebAllowedCommand')
  })
})
