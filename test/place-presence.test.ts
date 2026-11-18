// Where a session runs, as the in-process MCP server writes it (#617, PR 1).
//
// buildMcpServer takes its place readers as an option, so a test can hand it readers
// that touch nothing (test/quiet-place.ts) or ones it controls. The default is the real
// tmux and the real home, which no test may reach.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../src/mcp.js'
import type { PlaceSource } from '../src/session-place.js'
import { listActivity, openDb } from '../src/store.js'
import { scratchDir } from './scratch.js'
import { waitUntil } from './wait.js'

const REPO = new URL('..', import.meta.url).pathname

describe('no test reaches the real tmux or the real home', () => {
  const testFiles = (dir: string): string[] => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? testFiles(join(dir, entry.name)) : /\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [])

  it('every buildMcpServer() call in a test passes its own place readers', () => {
    const offenders: string[] = []
    for (const file of testFiles('test')) {
      if (file === 'test/place-presence.test.ts') continue
      readFileSync(join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*|import )/.test(line) || !/\bbuildMcpServer\(/.test(line)) return
        if (!/\bplace:/.test(line)) offenders.push(`${file}:${index + 1}`)
      })
    }
    expect(offenders, 'pass { place: quietPlace } from test/quiet-place.ts').toEqual([])
  })

  it('the test environment has no TMUX or TMUX_PANE, so a server a test spawns starts no tmux either', () => {
    expect(process.env['TMUX']).toBeUndefined()
    expect(process.env['TMUX_PANE']).toBeUndefined()
  })
})

describe('the server writes its place through the readers it is given', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const fn of cleanups.splice(0)) fn() })

  async function connect(name: string, place: PlaceSource) {
    const events: EventEmitter = process
    for (const signal of ['exit', 'SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
      const before = events.listeners(signal)
      cleanups.push(() => {
        for (const listener of events.listeners(signal)) {
          if (!before.includes(listener)) events.removeListener(signal, listener as (...args: unknown[]) => void)
        }
      })
    }
    const db = openDb(join(scratchDir('place-presence-'), 'inbox.db'))
    cleanups.push(() => db.close())
    const server = buildMcpServer(db, process.cwd(), { place })
    const client = new Client({ name, version: 'test' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanups.push(() => { void client.close() })
    return { db }
  }

  it('writes a desk read before its row existed once the session registers (a non-Claude session in tmux)', async () => {
    // the reader answers at once, at construction, long before the handshake creates the row:
    // only the flush at registration can put it there (the next reading is 30 seconds on)
    const desk = vi.fn(async () => 'work')
    const remoteSession = vi.fn(() => 'session_abc')
    const { db } = await connect('github-copilot-cli', { place: { machine: 'testbox', pane: '%3' }, desk, remoteSession })
    const row = await waitUntil(() => listActivity(db).find((r) => r.desk), 'the desk')
    expect(row).toMatchObject({ machine: 'testbox', pane: '%3', desk: 'work' })
    expect(desk).toHaveBeenCalledWith('%3')
    // the Remote Control id is read for a Claude Code host only
    expect(remoteSession).not.toHaveBeenCalled()
    expect(Object.keys(row)).not.toContain('remote_session')
  })

  it('reads the Remote Control id of its host process for a Claude Code client', async () => {
    const remoteSession = vi.fn(() => 'session_abc')
    const { db } = await connect('claude-code', { place: {}, desk: async () => null, remoteSession })
    const row = await waitUntil(() => listActivity(db).find((r) => r.remote_session), 'the Remote Control id')
    expect(row.remote_session).toBe('session_abc')
    expect(remoteSession).toHaveBeenCalledWith(process.ppid)
    expect(Object.keys(row)).not.toContain('desk')
  })

  it('a failed read (undefined) writes nothing and a clean absence (null) writes nothing to an empty row', async () => {
    const { db } = await connect('claude-code', { place: { pane: '%3' }, desk: async () => undefined, remoteSession: () => undefined })
    const row = await waitUntil(() => listActivity(db)[0], 'the presence row')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(row.pane).toBe('%3')
    expect(Object.keys(listActivity(db)[0]!)).not.toContain('desk')
    expect(Object.keys(listActivity(db)[0]!)).not.toContain('remote_session')
  })
})
