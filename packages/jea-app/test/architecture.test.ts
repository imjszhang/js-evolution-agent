import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcRoot = fileURLToPath(new URL('../src', import.meta.url))
const electronHostFiles = [
  fileURLToPath(new URL('../../../apps/desktop/src/renderer/src/App.tsx', import.meta.url)),
  fileURLToPath(new URL('../../../apps/desktop/src/renderer/src/main.tsx', import.meta.url))
]

const forbidden = [
  /from\s+['"]electron['"]/,
  /from\s+['"]node:/,
  /from\s+['"]fs['"]/,
  /from\s+['"]path['"]/,
  /from\s+['"]http['"]/,
  /from\s+['"]https['"]/,
  /from\s+['"]net['"]/,
  /require\(\s*['"]electron['"]/,
  /window\.jea\b/,
  /src\/cli\//,
  /src\/intelligence\//,
  /src\/daemon\//,
  /src\/actions\//,
  /src\/engine\//,
  /createServer\s*\(/
]

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) return walk(full)
    if (['.ts', '.tsx', '.js', '.mjs', '.css'].includes(extname(full))) return [full]
    return []
  })
}

describe('shared renderer import boundary', () => {
  it('does not import Electron, Node, HTTP servers, JEA runtime helpers, or window.jea', () => {
    const files = walk(srcRoot)
    expect(files.length).toBeGreaterThan(5)
    const violations: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${file.replace(srcRoot, 'src')} matches ${pattern}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps Electron host entries free of window.jea feature-data calls', () => {
    const violations: string[] = []
    for (const file of electronHostFiles) {
      const source = readFileSync(file, 'utf8')
      if (/window\.jea\b/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})
