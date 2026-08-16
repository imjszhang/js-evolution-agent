import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))

const FORBIDDEN_RENDERER = [
  /from\s+['"]electron(?:\/[^'"]*)?['"]/,
  /from\s+['"]node:[^'"]+['"]/,
  /from\s+['"](?:fs|http|https|net|child_process|os|path)['"]/,
  /from\s+['"][^'"]*\/src\/daemon\/[^'"]+['"]/,
  /from\s+['"][^'"]*\/src\/intelligence\/(?!redaction)[^'"]+['"]/,
  /from\s+['"][^'"]*\/src\/infra\/(?:runtime-paths|jea-home|files)[^'"]+['"]/,
  /from\s+['"][^'"]*\/main\/[^'"]+['"]/
]

const FORBIDDEN_ADAPTER = [
  /from\s+['"]electron(?:\/[^'"]*)?['"]/,
  /from\s+['"]node:fs['"]/,
  /from\s+['"][^'"]*\/owners\/[^'"]+['"]/,
  /from\s+['"]\.\.\/host['"]/,
  /from\s+['"][^'"]*\/src\/daemon\/[^'"]+['"]/,
  /from\s+['"][^'"]*\/src\/intelligence\/[^'"]+['"]/,
  /from\s+['"][^'"]*\/src\/infra\/(?:runtime-paths|jea-home|files)[^'"]+['"]/
]

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) files.push(full)
  }
  return files
}

describe('Client API architecture boundaries', () => {
  it('keeps renderer feature code on JeaClient and shared public types', () => {
    const files = walk(join(desktopRoot, 'src/renderer'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN_RENDERER) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('keeps transport adapters free of domain decisions and runtime-file writes', () => {
    const files = [
      join(desktopRoot, 'src/client-api/adapters/electron.ts'),
      join(desktopRoot, 'src/client-api/adapters/memory.ts'),
      join(desktopRoot, 'src/client-api/adapters/web.ts')
    ]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN_ADAPTER) {
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern)
      }
      expect(source).not.toMatch(/writeFileSync|rmSync|mkdirSync/)
    }
  })
})
