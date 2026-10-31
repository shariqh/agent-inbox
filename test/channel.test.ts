// Issue #411 (channels, research preview): the server pushes one notice per new
// message into a Claude Code session that listens on Claude Code's channel
// extension, and records in presence whether the session was launched listening.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { ackMessage, listActivity, openDb, sendSessionMessage, upsertActivity, withdrawSessionMessage } from '../src/store.js'
import { channelNotice, channelPollMs, namesChannel, startChannelPush } from '../src/channel.js'
import type { ChannelNotice } from '../src/channel.js'
import { inferProcessArgs } from '../src/infer.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let db: Database.Database

function present(session: string, over: { push_wake?: boolean } = {}) {
  upsertActivity(db, {
    session, project: 'alpha', stream: 'main', agent: 'claude-code', doing: 'open', idle: true, claim: false,
    receives_messages: true, ...over,
  })
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
}
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
  db = openDb(join(scratchDir('channel-'), 'inbox.db'))
})

afterEach(() => {
  db.close()
  removeScratchDirs()
})

describe('push_wake presence (store)', () => {
  it('serves push_wake only when true, and keeps it when a later write omits it', () => {
    present('mcp-a', { push_wake: true })
    present('mcp-b', { push_wake: false })
    present('mcp-c')
    const row = (session: string) => listActivity(db).find((r) => r.session === session)!
    expect(row('mcp-a').push_wake).toBe(true)
    expect('push_wake' in row('mcp-b')).toBe(false)
    expect('push_wake' in row('mcp-c')).toBe(false)
    // a status write that does not know the flag keeps it, as with receives_messages
    upsertActivity(db, { session: 'mcp-a', project: 'alpha', stream: 'main', agent: 'claude-code', doing: 'Testing' })
    expect(row('mcp-a').push_wake).toBe(true)
  })
})

describe('the channel push loop', () => {
  it('pushes one notice per open message of its own session, carrying the id and never the text', async () => {
    present('mcp-a')
    present('mcp-b')
    const sent: ChannelNotice[] = []
    const stop = startChannelPush({ db, session: 'mcp-a', intervalMs: 20, send: async (notice) => { sent.push(notice) } })
    try {
      sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'Also run the DOM tests.' })
      sendSessionMessage(db, { id: id(2), session: 'mcp-b', text: 'Not yours.' })
      await until(() => sent.length >= 1)
      await settle()
      expect(sent).toEqual([channelNotice(id(1))])
      expect(sent[0]!.meta).toEqual({ message_id: id(1) })
      expect(JSON.stringify(sent)).not.toContain('DOM tests')

      // still open on later ticks, delivered or not: never pushed again
      await settle()
      expect(sent).toHaveLength(1)

      // a second message is pushed on its own; closed ones are forgotten
      sendSessionMessage(db, { id: id(3), session: 'mcp-a', text: 'And the store tests.' })
      await until(() => sent.length >= 2)
      expect(sent.map((n) => n.meta.message_id)).toEqual([id(1), id(3)])
      ackMessage(db, { id: id(1), session: 'mcp-a', outcome: 'Done.' })
      withdrawSessionMessage(db, id(3), 1)
      await settle()
      expect(sent).toHaveLength(2)
    } finally {
      stop()
    }
  })

  it('retries a notice whose send failed, and stops when told', async () => {
    present('mcp-a')
    let attempts = 0
    const sent: string[] = []
    const stop = startChannelPush({
      db, session: 'mcp-a', intervalMs: 20,
      send: async (notice) => { attempts += 1; if (attempts === 1) throw new Error('transport closed'); sent.push(notice.meta.message_id) },
    })
    sendSessionMessage(db, { id: id(1), session: 'mcp-a', text: 'hi' })
    await until(() => sent.length >= 1)
    expect(sent).toEqual([id(1)])
    expect(attempts).toBe(2)
    stop()
    sendSessionMessage(db, { id: id(2), session: 'mcp-a', text: 'after stop' })
    await settle()
    expect(sent).toEqual([id(1)])
  })

  it('polls every 2 s unless a test forces a sane interval', () => {
    expect(channelPollMs({})).toBe(2000)
    expect(channelPollMs({ AGENT_INBOX_CHANNEL_POLL_MS: '100' })).toBe(100)
    expect(channelPollMs({ AGENT_INBOX_CHANNEL_POLL_MS: '0' })).toBe(2000)
    expect(channelPollMs({ AGENT_INBOX_CHANNEL_POLL_MS: 'soon' })).toBe(2000)
  })
})

describe('whether Claude Code was launched listening (namesChannel)', () => {
  const DEV = '--dangerously-load-development-channels'
  it('needs the development flag naming server:agent-inbox', () => {
    expect(namesChannel(['claude', DEV, 'server:agent-inbox'])).toBe(true)
    expect(namesChannel(['claude', DEV, 'server:webhook', 'server:agent-inbox', '--model', 'x'])).toBe(true)
    expect(namesChannel(['claude', `${DEV}=server:agent-inbox`])).toBe(true)
    expect(namesChannel(['claude'])).toBe(false)
    expect(namesChannel(['claude', DEV, 'server:webhook'])).toBe(false)
    expect(namesChannel(['claude', DEV, 'server:agent-inbox-dev'])).toBe(false)
    // a positional prompt after another flag is not a channel entry
    expect(namesChannel(['claude', DEV, 'server:webhook', '--verbose', 'server:agent-inbox'])).toBe(false)
    // during the preview --channels registers allowlisted plugins only, never a bare server
    expect(namesChannel(['claude', '--channels', 'server:agent-inbox'])).toBe(false)
    // print mode ignores the flag
    expect(namesChannel(['claude', '-p', DEV, 'server:agent-inbox'])).toBe(false)
    expect(namesChannel(['claude', DEV, 'server:other'], 'other')).toBe(true)
  })

  it('reads a process’s arguments locally, and nothing for an impossible pid', () => {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const args = inferProcessArgs(process.pid)
      expect(args?.some((arg) => arg.includes('node'))).toBe(true)
    }
    expect(inferProcessArgs(0)).toBeNull()
    expect(inferProcessArgs(1.5)).toBeNull()
    expect(inferProcessArgs(2 ** 30)).toBeNull()
  })
})
