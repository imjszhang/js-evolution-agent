import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLIENT_API_COMMANDS } from '../../src/client-api/protocol'

describe('Client API registration guard', () => {
  it('fails CI when host handlers introduce a command outside the catalog', () => {
    const hostSource = readFileSync(
      fileURLToPath(new URL('../../src/client-api/host.ts', import.meta.url)),
      'utf8'
    )
    const declared = [...hostSource.matchAll(/'([a-z]+(?:\.[a-zA-Z]+)+)':/g)].map((match) => match[1])
    const unknown = declared.filter((name) => !(CLIENT_API_COMMANDS as readonly string[]).includes(name))
    expect(unknown).toEqual([])
    expect(new Set(declared)).toEqual(new Set(CLIENT_API_COMMANDS))
  })
})
