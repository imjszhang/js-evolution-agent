import { existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLED_PROJECT_ROOT_CANDIDATE = resolve(
  fileURLToPath(new URL('../../../..', import.meta.url))
)

function isJeaProjectRoot(candidate: string): boolean {
  return existsSync(join(candidate, 'oada.config.mjs'))
    && existsSync(join(candidate, 'src', 'cli', 'jea.mjs'))
}

export function findProjectRoot(start: string): string | null {
  let current = resolve(start)
  for (let i = 0; i < 10; i += 1) {
    if (isJeaProjectRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export function resolveDesktopProjectRoot({
  env = process.env,
  cwd = process.cwd(),
  fallback = BUNDLED_PROJECT_ROOT_CANDIDATE
}: {
  env?: NodeJS.ProcessEnv
  cwd?: string
  fallback?: string
} = {}): string {
  if (env.JEA_PROJECT_ROOT) return resolve(env.JEA_PROJECT_ROOT)
  return findProjectRoot(fallback) ?? findProjectRoot(cwd) ?? fallback
}
