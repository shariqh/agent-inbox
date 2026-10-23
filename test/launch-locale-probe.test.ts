// The CI launch gates start the provisional macOS app as a French and as a
// British user and ask its page, over DevTools, which locale it runs in and
// how it formats the app's two default-locale dates (#292). These tests pin
// what the probe expects against ICU itself and drive it against a fake
// DevTools endpoint.
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPECTED,
  LaunchLocaleError,
  PROBE,
  localeMismatches,
  probeLaunchLocale,
  viewerPage,
} from '../scripts/launch-locale-probe.mjs'

const REPO = resolve(import.meta.dirname, '..')

// PROBE, evaluated by Node under a POSIX locale: the same ICU data Chromium
// formats with.
function formatIn(locale: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, ['-e', `process.stdout.write(${PROBE})`], {
    encoding: 'utf8',
    env: { ...process.env, LANG: locale, LC_ALL: locale, LANGUAGE: '' },
    timeout: 10_000,
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

describe('what the probe expects (#292)', () => {
  it('is what ICU formats for US and British English, and tells them and French apart', () => {
    expect(localeMismatches(formatIn('en_US.UTF-8'), EXPECTED['en-US'])).toEqual([])
    expect(localeMismatches(formatIn('en_GB.UTF-8'), EXPECTED['en-GB'])).toEqual([])
    expect(localeMismatches(formatIn('en_GB.UTF-8'), EXPECTED['en-US'])).toHaveLength(4)
    const french = formatIn('fr_FR.UTF-8')
    expect(localeMismatches(french, EXPECTED['en-US'])).toHaveLength(4)
    expect(localeMismatches(french, EXPECTED['en-GB'])).toHaveLength(4)
  })

  it('reads a narrow or non-breaking space before AM/PM as a space, and names what differs', () => {
    expect(localeMismatches({ ...EXPECTED['en-US'], lastChecked: '10/23/2026, 2:05:06\u202fPM' }, EXPECTED['en-US'])).toEqual([])
    expect(localeMismatches({ ...EXPECTED['en-US'], askedAt: 'Oct 23, 2026, 2:05:06\u00a0PM UTC' }, EXPECTED['en-US'])).toEqual([])
    expect(localeMismatches({ ...EXPECTED['en-GB'], lastChecked: '10/23/2026, 2:05:06 PM' }, EXPECTED['en-GB'])).toEqual([
      'lastChecked is "10/23/2026, 2:05:06 PM", not "23/10/2026, 14:05:06"',
    ])
    expect(localeMismatches(null, EXPECTED['en-GB'])).toHaveLength(4)
  })

  it('finds only the viewer\'s own page', () => {
    const page = { type: 'page', url: 'http://127.0.0.1:14319/', webSocketDebuggerUrl: 'ws://x/page' }
    expect(viewerPage([
      { type: 'service_worker', url: 'http://127.0.0.1:14319/sw.js', webSocketDebuggerUrl: 'ws://x/sw' },
      { type: 'page', url: 'http://127.0.0.1:143190/', webSocketDebuggerUrl: 'ws://x/other-port' },
      { type: 'page', url: 'http://127.0.0.1:14319/', webSocketDebuggerUrl: 7 },
      page,
    ], 14319)).toBe(page)
    expect(viewerPage([{ type: 'page', url: 'http://localhost:14319/', webSocketDebuggerUrl: 'ws://x' }], 14319)).toBeUndefined()
    expect(viewerPage({ not: 'a list' }, 14319)).toBeUndefined()
  })
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => {
    server.closeAllConnections()
    server.close(done)
  })))
})

// A DevTools endpoint: /json/list names the targets, and a target's WebSocket
// answers each Runtime.evaluate with `answer`.
async function fakeDevTools({ viewerPort = 14319, pageAfterPolls = 0, answer }: {
  viewerPort?: number
  pageAfterPolls?: number
  answer: (message: { id: number, method: string, params?: { expression?: string } }) => object
}) {
  const seen = { polls: 0, expressions: [] as string[] }
  const server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end()
      return
    }
    seen.polls += 1
    const { port } = server.address() as AddressInfo
    const targets = [{ type: 'page', url: `http://127.0.0.1:${viewerPort + 1}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/other` }]
    if (seen.polls > pageAfterPolls) {
      targets.push({ type: 'page', url: `http://127.0.0.1:${viewerPort}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` })
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(targets))
  })
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0f
        let length = pending[1]! & 0x7f
        let offset = 2
        if (length === 126) {
          if (pending.length < 4) return
          length = pending.readUInt16BE(2)
          offset = 4
        }
        if (pending.length < offset + 4 + length) return
        const mask = pending.subarray(offset, offset + 4)
        const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]!))
        pending = pending.subarray(offset + 4 + length)
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0x00]))
          return
        }
        if (opcode !== 0x1) continue
        const message = JSON.parse(payload.toString('utf8'))
        seen.expressions.push(message.params?.expression)
        const reply = Buffer.from(JSON.stringify({ id: message.id, ...answer(message) }))
        const header = reply.length < 126
          ? Buffer.from([0x81, reply.length])
          : Buffer.from([0x81, 126, reply.length >> 8, reply.length & 0xff])
        socket.write(Buffer.concat([header, reply]))
      }
    })
    socket.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { devtoolsPort: (server.address() as AddressInfo).port, viewerPort, seen }
}

const reports = (observed: object) => () => ({ result: { result: { type: 'string', value: JSON.stringify(observed) } } })

describe('probeLaunchLocale against a DevTools endpoint (#292)', () => {
  it('waits for the viewer\'s page, evaluates the probe there and accepts the expected locale', async () => {
    const british = { ...EXPECTED['en-GB'], lastChecked: '23/10/2026, 14:05:06' }
    const devtools = await fakeDevTools({ pageAfterPolls: 2, answer: reports(british) })

    const observed = await probeLaunchLocale({ ...devtools, expect: 'en-GB', attempts: 5, intervalMs: 10 })

    expect(observed).toEqual(british)
    expect(devtools.seen.polls).toBe(3)
    expect(devtools.seen.expressions).toEqual([PROBE])
  })

  it('refuses a page that runs in another locale, naming what differs', async () => {
    const devtools = await fakeDevTools({ answer: reports(EXPECTED['en-GB']) })
    await expect(probeLaunchLocale({ ...devtools, expect: 'en-US', attempts: 1 })).rejects.toThrow(
      'the page does not run in en-US: language is "en-GB", not "en-US"; intl is "en-GB", not "en-US"; '
        + 'lastChecked is "23/10/2026, 14:05:06", not "10/23/2026, 2:05:06 PM"; '
        + 'askedAt is "23 Oct 2026, 14:05:06 UTC", not "Oct 23, 2026, 2:05:06 PM UTC"',
    )
  })

  it('gives up when the viewer\'s page never appears', async () => {
    const devtools = await fakeDevTools({ pageAfterPolls: 100, answer: reports(EXPECTED['en-US']) })
    await expect(probeLaunchLocale({ ...devtools, expect: 'en-US', attempts: 3, intervalMs: 10 })).rejects.toThrow(
      `no page for http://127.0.0.1:14319/ on DevTools port ${devtools.devtoolsPort}`,
    )
    expect(devtools.seen.polls).toBe(3)
  })

  it('refuses a probe the page could not evaluate, or an answer that is not JSON', async () => {
    const thrown = await fakeDevTools({
      answer: () => ({ result: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught' } } }),
    })
    await expect(probeLaunchLocale({ ...thrown, expect: 'en-US', attempts: 1 }))
      .rejects.toThrow('the page did not evaluate the probe: {"text":"Uncaught"}')
    const garbled = await fakeDevTools({ answer: () => ({ result: { result: { type: 'string', value: 'not json' } } }) })
    await expect(probeLaunchLocale({ ...garbled, expect: 'en-US', attempts: 1 }))
      .rejects.toThrow(/^the probe returned no JSON: /)
  })

  it('accepts only the two English locales the app ships', async () => {
    await expect(probeLaunchLocale({ devtoolsPort: 1, viewerPort: 2, expect: 'fr' }))
      .rejects.toThrow(new LaunchLocaleError('--expect must be one of en-US, en-GB'))
  })

  it('runs as a command, reporting what the page runs in', async () => {
    const devtools = await fakeDevTools({ answer: reports(EXPECTED['en-US']) })
    const script = join(REPO, 'scripts', 'launch-locale-probe.mjs')
    // asynchronous, so this process keeps serving the fake endpoint
    const run = (...args: string[]) => new Promise<{ status: number | null, stdout: string, stderr: string }>((done) => {
      execFile(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
        done({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
      })
    })

    const passed = await run('--devtools-port', String(devtools.devtoolsPort), '--viewer-port', '14319', '--expect', 'en-US')
    expect(passed.status, passed.stderr).toBe(0)
    expect(passed.stdout).toBe(`launch-locale-probe: the page runs in en-US: ${JSON.stringify(EXPECTED['en-US'])}\n`)

    const refused = await run('--devtools-port', 'x', '--viewer-port', '14319', '--expect', 'en-US')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toBe('launch-locale-probe: --devtools-port must be a TCP port\n')
  })
})
