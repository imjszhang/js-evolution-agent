import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWebJeaClient } from '../../src/client-api'
import { createWebHost } from '../../src/web-host'

const TOKEN = 'b'.repeat(32) + 'sse-resume-token'
const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) {
    const host = hosts.pop()
    await host?.close().catch(() => {})
  }
  delete process.env.JEA_HOME
})

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-sse-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-sse-home-'))
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: { alpha: { data_namespace: 'alpha-data' } }
  }))
  return { sourceRoot, jeaHome }
}

async function readSseUntil(
  response: Response,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
  timeout = 3000
): Promise<{ events: Array<Record<string, unknown>>; transcript: string[] }> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing SSE body')
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, unknown>> = []
  const transcript: string[] = []
  const started = Date.now()
  try {
    while (Date.now() - started < timeout) {
      const remaining = timeout - (Date.now() - started)
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('sse_read_timeout')), Math.max(25, remaining))
        })
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        transcript.push(part)
        const id = part.split(/\r?\n/).find((line) => line.startsWith('id:'))?.slice(3).trim()
        const data = part.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data) continue
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (id && parsed.cursor == null) parsed.cursor = id
        events.push(parsed)
      }
      if (predicate(events)) return { events, transcript }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // The stream may already be released.
    }
  }
  throw new Error(`Timed out waiting for SSE events: ${events.map((item) => item.type).join(',')}`)
}

describe('Web SSE resume', () => {
  it('resumes from Last-Event-ID without duplicating applied events', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.JEA_HOME = jeaHome
    const host = await createWebHost({
      sourceRoot,
      jeaHome,
      token: TOKEN,
      port: 0,
      watcher: { start() {}, stop() {} }
    })
    hosts.push(host)

    const live = await fetch(`${host.origin}/jea/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' }
    })
    const first = host.publish({ type: 'subject.changed', subject: 'alpha', payload: { subject: 'alpha', reason: 'one' } })
    host.publish({ type: 'service.status', subject: 'alpha', payload: { subject: 'alpha', health: 'ok' } })
    const cursorEvent = host.publish({ type: 'evolution.updated', subject: 'alpha', payload: { subject: 'alpha', cycle_status: 'completed' } })
    const firstPass = await readSseUntil(live, (events) => events.some((item) => Number(item.seq) === cursorEvent.seq))
    const firstSeqs = firstPass.events.map((item) => Number(item.seq))
    expect(new Set(firstSeqs).size).toBe(firstSeqs.length)

    await live.body?.cancel().catch(() => {})
    const late = host.publish({ type: 'projection.channel_updated', subject: 'alpha', payload: { channel: { running: false, blocked: true } } })
    const resume = await fetch(`${host.origin}/jea/events?cursor=${cursorEvent.cursor}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'text/event-stream',
        'Last-Event-ID': String(cursorEvent.cursor)
      }
    })
    const secondPass = await readSseUntil(resume, (events) => events.some((item) => Number(item.seq) === late.seq))
    const applied = new Set(firstSeqs)
    const replayed = secondPass.events.filter((item) => item.type !== 'client.hello')
    const transcript = {
      first_event_types: firstPass.events.map((item) => item.type),
      first_seq: firstSeqs,
      resume_from: cursorEvent.cursor,
      last_event_id: cursorEvent.cursor,
      replay_types: secondPass.events.map((item) => item.type),
      replay_seq: secondPass.events.map((item) => Number(item.seq)),
      duplicates: replayed.filter((item) => applied.has(Number(item.seq))).map((item) => item.seq)
    }
    writeFileSync(join(jeaHome, 'sse-resume-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
    expect(transcript.duplicates).toEqual([])
    expect(transcript.replay_seq.every((seq) => Number.isFinite(seq) && seq > Number(first.cursor) - 1)).toBe(true)
    expect(secondPass.events.some((item) => item.type === 'projection.channel_updated')).toBe(true)
    expect(JSON.stringify(secondPass.events)).not.toContain(TOKEN)

    const client = createWebJeaClient({ baseUrl: host.origin, token: TOKEN })
    const firstClient: number[] = []
    const stopFirst = client.subscribe((event) => {
      const seq = Number((event as { seq?: number }).seq)
      if (Number.isFinite(seq)) firstClient.push(seq)
    })
    await viWaitFor(() => firstClient.length > 0)
    stopFirst()
    const extra = host.publish({ type: 'evolution.updated', subject: 'alpha', payload: { subject: 'alpha', cycle_status: 'failed' } })
    const seen = new Set<number>()
    const resumed: number[] = []
    const stopResume = client.subscribe((event) => {
      const seq = Number((event as { seq?: number }).seq)
      if (!Number.isFinite(seq)) return
      if (seen.has(seq)) throw new Error(`duplicate applied seq ${seq}`)
      seen.add(seq)
      resumed.push(seq)
    })
    await viWaitFor(() => resumed.includes(extra.seq))
    stopResume()
    expect(resumed.every((seq) => seq > Math.max(...firstClient))).toBe(true)
    expect(new Set(resumed).size).toBe(resumed.length)
  })
})

async function viWaitFor(assert: () => boolean, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (assert()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for web client resume.')
}
