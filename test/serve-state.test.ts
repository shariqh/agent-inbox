// Serve's shape, checked by the desktop app's main (#617, PR 2c; design
// docs/superpowers/specs/2026-11-17-remote-inbox-design.md §3.2 "Serve's shape, checked by main").
//
// serveState(host, port) reads `tailscale serve status --json` and is ok only for exactly one web
// handler for host:443, at `/`, proxying to http://127.0.0.1:<port>, over HTTPS on 443, with no
// other path on that host, no TCP forward to the port, no Funnel, and nothing it does not
// recognise. Anything else turns the entry off.
//
// WHERE THE FIXTURES COME FROM. From a real run (Tailscale 1.102.4, macOS, 2026-11-17; host
// replaced): `{}` (nothing configured) and goodServe(), the exact output after
// `tailscale serve --bg 4320`. Every other configured shape below (Funnel, TCP forwards, a second
// path, handler fields, Foreground, Services, unknown keys) is written from Tailscale's
// documentation of ServeConfig, NOT from a real run. The parser is strict on purpose: a real shape
// that differs reads as not ok, and the entry stays off.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import remoteEntry from '../electron/remote-entry.cjs'
import remoteTailscale from '../electron/remote-tailscale.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'
import { setting, writeSetting } from './remote-fixtures.js'
import { ALLOWED_ARGS, HOST, cliExists, fakeTailscale, goodServe, selfStatus, tailscaleCalls } from './remote-entry-fixtures.js'

const { REMOVAL_HINT, TAILSCALE_ARGS, TAILSCALE_PATHS, createRemoteEntry, parseServeStatus, tailscaleCli } = remoteEntry
const { runTailscale } = remoteTailscale

const PORT = 4320
const OTHER = 'other.example.ts.net'
const handler = (proxy: string) => ({ Handlers: { '/': { Proxy: proxy } } })
const good = () => goodServe(PORT)

afterEach(() => removeScratchDirs())

// Every call the fakes received in this file used one of the two allowed argument lists.
afterAll(() => {
  expect(tailscaleCalls.length).toBeGreaterThan(5)
  for (const call of tailscaleCalls) expect(ALLOWED_ARGS, call.args.join(' ')).toContainEqual(call.args)
})

describe('parseServeStatus: the one good shape', () => {
  it('is ok for exactly one handler for host:443 at / proxying to http://127.0.0.1:<port> over HTTPS', () => {
    expect(parseServeStatus(JSON.stringify(good()), HOST, PORT)).toEqual({ ok: true })
  })

  it('is ok for the real output of `tailscale serve --bg 4320`, verbatim (Tailscale 1.102.4, host replaced), and not ok for the real `{}`', () => {
    const real = `{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${HOST}:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:4320"
        }
      }
    }
  }
}
`
    expect(parseServeStatus(real, HOST, PORT)).toEqual({ ok: true })
    expect(JSON.parse(real)).toEqual(good())
    expect(parseServeStatus('{}\n', HOST, PORT)).toEqual({ ok: false, reason: 'no_handler', present: false })
  })

  it('stays ok with empty Foreground, Services and AllowFunnel maps, and Funnel set to false', () => {
    expect(parseServeStatus(JSON.stringify({ ...good(), Foreground: {}, Services: {}, AllowFunnel: {} }), HOST, PORT)).toEqual({ ok: true })
    expect(parseServeStatus(JSON.stringify({ ...good(), AllowFunnel: { [`${HOST}:443`]: false } }), HOST, PORT)).toEqual({ ok: true })
  })

  it('stays ok beside another host\'s handler or this host on another port, when neither reaches the port', () => {
    const value = good() as { Web: Record<string, unknown>; TCP: Record<string, unknown> }
    value.Web[`${OTHER}:443`] = handler('http://127.0.0.1:3000')
    value.Web[`${HOST}:8443`] = handler('http://127.0.0.1:3001')
    value.TCP['8443'] = { HTTPS: true }
    value.TCP['2222'] = { TCPForward: '127.0.0.1:22' }
    expect(parseServeStatus(JSON.stringify(value), HOST, PORT)).toEqual({ ok: true })
  })

  it('reads the host key without regard to case or a trailing dot', () => {
    expect(parseServeStatus(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'HUB.Example.ts.net:443': handler(`http://127.0.0.1:${PORT}`) } }), HOST, PORT)).toEqual({ ok: true })
    expect(parseServeStatus(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}.:443`]: handler(`http://127.0.0.1:${PORT}`) } }), HOST, PORT)).toEqual({ ok: true })
  })
})

describe('parseServeStatus: every other shape is not ok, with a fixed reason', () => {
  const cases: Array<[string, unknown, string, boolean]> = [
    ['nothing configured (the real `{}`)', {}, 'no_handler', false],
    ['another host\'s handler only', { TCP: { '443': { HTTPS: true } }, Web: { [`${OTHER}:443`]: handler('http://127.0.0.1:3000') } }, 'no_handler', false],
    ['another host\'s handler proxying to the port', { ...good(), Web: { ...(good().Web as object), [`${OTHER}:443`]: handler(`http://127.0.0.1:${PORT}`) } }, 'other_proxy', true],
    ['this host on another port proxying to the port', { ...good(), Web: { ...(good().Web as object), [`${HOST}:8443`]: handler(`http://127.0.0.1:${PORT}`) } }, 'other_proxy', true],
    ['a second path under the host', { ...good(), Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` }, '/files': { Proxy: 'http://127.0.0.1:3000' } } } } }, 'other_path', true],
    ['only another path under the host', { ...good(), Web: { [`${HOST}:443`]: { Handlers: { '/inbox': { Proxy: `http://127.0.0.1:${PORT}` } } } } }, 'other_path', true],
    ['no handlers at all for the host', { ...good(), Web: { [`${HOST}:443`]: { Handlers: {} } } }, 'no_handler', true],
    ['the wrong port', { ...good(), Web: { [`${HOST}:443`]: handler('http://127.0.0.1:4321') } }, 'wrong_target', true],
    ['a localhost target', { ...good(), Web: { [`${HOST}:443`]: handler(`http://localhost:${PORT}`) } }, 'wrong_target', true],
    ['an https target', { ...good(), Web: { [`${HOST}:443`]: handler(`https://127.0.0.1:${PORT}`) } }, 'wrong_target', true],
    ['a target with a path', { ...good(), Web: { [`${HOST}:443`]: handler(`http://127.0.0.1:${PORT}/inbox`) } }, 'wrong_target', true],
    ['a target with a trailing slash', { ...good(), Web: { [`${HOST}:443`]: handler(`http://127.0.0.1:${PORT}/`) } }, 'wrong_target', true],
    ['a bare port as the target', { ...good(), Web: { [`${HOST}:443`]: handler(String(PORT)) } }, 'wrong_target', true],
    ['a handler with another field (app capabilities, from --accept-app-caps)', { ...good(), Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}`, AcceptAppCaps: ['example.com/cap/x'] } } } } }, 'handler_fields', true],
    ['a handler that serves text', { ...good(), Web: { [`${HOST}:443`]: { Handlers: { '/': { Text: 'hello' } } } } }, 'handler_fields', true],
    ['a host entry with a key besides Handlers', { ...good(), Web: { [`${HOST}:443`]: { ...handler(`http://127.0.0.1:${PORT}`), Extra: true } } }, 'unknown_shape', true],
    ['two keys naming the host', { ...good(), Web: { [`${HOST}:443`]: handler(`http://127.0.0.1:${PORT}`), 'HUB.example.ts.net:443': handler(`http://127.0.0.1:${PORT}`) } }, 'duplicate_host', true],
    ['a TCP forward to the port', { ...good(), TCP: { '443': { HTTPS: true }, '8443': { TCPForward: `127.0.0.1:${PORT}` } } }, 'tcp_forward', true],
    ['a TLS-terminated TCP forward to the port', { ...good(), TCP: { '443': { HTTPS: true }, '8443': { TCPForward: `127.0.0.1:${PORT}`, TerminateTLS: HOST } } }, 'tcp_forward', true],
    ['a TCP forward to the port by name', { ...good(), TCP: { '443': { HTTPS: true }, '9000': { TCPForward: `localhost:${PORT}` } } }, 'tcp_forward', true],
    ['443 a TCP forward instead of HTTPS', { ...good(), TCP: { '443': { TCPForward: '127.0.0.1:3000' } } }, 'not_https', true],
    ['443 plain HTTP', { ...good(), TCP: { '443': { HTTP: true } } }, 'not_https', true],
    ['443 HTTPS with another field', { ...good(), TCP: { '443': { HTTPS: true, ProxyProtocol: 2 } } }, 'not_https', true],
    ['no TCP entry for 443', { Web: good().Web }, 'not_https', true],
    ['Funnel on for the host', { ...good(), AllowFunnel: { [`${HOST}:443`]: true } }, 'funnel', true],
    ['Funnel on, the key in capitals', { ...good(), AllowFunnel: { 'HUB.EXAMPLE.TS.NET:443': true } }, 'funnel', true],
    ['Funnel with a value that is not false', { ...good(), AllowFunnel: { [`${HOST}:443`]: 'yes' } }, 'funnel', true],
    ['an unknown top-level key holding a nested handler for the host', { ...good(), Extra: { Web: { [`${HOST}:443`]: handler('http://127.0.0.1:3000') } } }, 'unknown_shape', true],
    ['an unknown top-level key holding anything', { ...good(), ETag: 'abc' }, 'unknown_shape', true],
    ['a foreground session\'s nested configuration', { ...good(), Foreground: { session1: { Web: { [`${HOST}:443`]: { Handlers: { '/x': { Proxy: 'http://127.0.0.1:3000' } } } } } } }, 'foreground', true],
    ['a foreground session for something else entirely', { ...good(), Foreground: { session1: { TCP: { '2222': { TCPForward: '127.0.0.1:22' } } } } }, 'foreground', true],
    ['a services section with its own handlers (from --service)', { ...good(), Services: { 'svc:inbox': { Web: { 'inbox.example.ts.net:443': handler('http://127.0.0.1:3000') } } } }, 'services', true],
    ['TCP that is not an object', { ...good(), TCP: [] }, 'unknown_shape', true],
    ['Web that is not an object', { ...good(), Web: 'x' }, 'unknown_shape', false],
    ['Handlers that is not an object', { ...good(), Web: { [`${HOST}:443`]: { Handlers: [] } } }, 'unknown_shape', true],
    ['a JSON value that is not an object', [], 'unknown_shape', false],
    ['null', null, 'unknown_shape', false],
  ]
  it.each(cases)('%s', (_name, value, reason, present) => {
    expect(parseServeStatus(JSON.stringify(value), HOST, PORT)).toEqual({ ok: false, reason, present })
  })

  it('checks the order: Funnel wins over a good handler, and a TCP forward over Funnel', () => {
    const both = { ...good(), AllowFunnel: { [`${HOST}:443`]: true }, TCP: { '443': { HTTPS: true }, '8443': { TCPForward: `127.0.0.1:${PORT}` } } }
    expect(parseServeStatus(JSON.stringify(both), HOST, PORT)).toMatchObject({ ok: false })
  })

  it('reads malformed JSON as unreadable', () => {
    expect(parseServeStatus('{"TCP":', HOST, PORT)).toEqual({ ok: false, reason: 'unreadable', present: false })
    expect(parseServeStatus('', HOST, PORT)).toEqual({ ok: false, reason: 'unreadable', present: false })
  })

  it('refuses a bad host or port without reading anything', () => {
    for (const [host, port] of [['127.0.0.1', PORT], ['', PORT], [HOST, 80], [HOST, 70000], [HOST, 4320.5]] as Array<[string, number]>) {
      expect(parseServeStatus(JSON.stringify(goodServe(port, host)), host, port)).toEqual({ ok: false, reason: 'bad_request', present: false })
    }
  })

  it('says a configuration is present when anything names host:443 or the port, for the removal hint', () => {
    expect(parseServeStatus(JSON.stringify({ TCP: { '9000': { TCPForward: `127.0.0.1:${PORT}` } } }), HOST, PORT)).toEqual({ ok: false, reason: 'tcp_forward', present: true })
    // 43201 is not 4320
    expect(parseServeStatus(JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${OTHER}:443`]: handler('http://127.0.0.1:43201') } }), HOST, PORT)).toEqual({ ok: false, reason: 'no_handler', present: false })
  })
})

describe('reading `tailscale serve status --json`', () => {
  function controller(execFile: ReturnType<typeof fakeTailscale>, exists = cliExists) {
    const dir = scratchDir('serve-state-')
    return createRemoteEntry({ isPackaged: true, env: { AGENT_INBOX_DB: join(dir, 'inbox.db') }, execFile, exists })
  }

  it('runs the fixed path with argv only, a 5-second timeout and a 1 MiB cap', async () => {
    const fake = fakeTailscale({ serve: good() })
    expect(await controller(fake).serveState(HOST, PORT)).toEqual({ ok: true })
    expect(fake.calls).toEqual([{
      file: '/usr/local/bin/tailscale',
      args: ['serve', 'status', '--json'],
      options: { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false, windowsHide: true },
    }])
  })

  it.each([
    ['no command line', fakeTailscale({ serve: good() }), () => false],
    ['a non-zero exit', fakeTailscale({ serve: { error: Object.assign(new Error('Command failed'), { code: 1 }) } }), cliExists],
    ['a timeout', fakeTailscale({ serve: { error: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }) } }), cliExists],
    ['output over the cap (execFile\'s own error)', fakeTailscale({ serve: { error: Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) } }), cliExists],
    ['output over 1 MiB handed back anyway', fakeTailscale({ serve: { raw: `{"TCP":{},"x":"${'a'.repeat(1024 * 1024)}"}` } }), cliExists],
    ['malformed JSON', fakeTailscale({ serve: { raw: '{"TCP":' } }), cliExists],
  ] as Array<[string, ReturnType<typeof fakeTailscale>, (path: string) => boolean]>)('%s is unreadable', async (_name, fake, exists) => {
    expect(await controller(fake, exists).serveState(HOST, PORT)).toEqual({ ok: false, reason: 'unreadable', present: false })
  })

  it('looks only at the three fixed paths, in order, never PATH', () => {
    expect(TAILSCALE_PATHS).toEqual(['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'])
    const asked: string[] = []
    expect(tailscaleCli((path) => { asked.push(path); return path.startsWith('/Applications/') })).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    expect(asked).toEqual(TAILSCALE_PATHS)
    expect(tailscaleCli((path) => path === '/opt/homebrew/bin/tailscale')).toBe('/opt/homebrew/bin/tailscale')
    expect(tailscaleCli(() => false)).toBe(null)
  })
})

describe('the watch tries a failed read once more, 5 seconds later, before it counts', () => {
  it('keeps the entry on when the retry reads well, and turns it off once when the retry fails too', async () => {
    const dir = scratchDir('serve-watch-')
    const file = writeSetting(dir, setting(PORT, [], { viewerPort: 4319 }))
    let clock = Date.parse('2026-11-20T09:00:00.000Z')
    const answers: Array<'bad' | 'good'> = ['bad', 'good', 'bad', 'bad']
    const fake = fakeTailscale({ self: selfStatus(), serve: (n: number) => (answers[n - 1] === 'good' ? good() : { raw: 'not json' }) })
    const stopped: string[] = []
    const c = createRemoteEntry({
      isPackaged: true,
      env: { AGENT_INBOX_DB: join(dir, 'inbox.db') },
      execFile: fake,
      exists: cliExists,
      now: () => clock,
      setInterval: () => 0,
      clearInterval: () => {},
      fetch: async () => new Response('{}', { status: 500 }),
      onStopped: (reason) => stopped.push(reason),
    })
    const serveCalls = () => fake.calls.filter((call) => call.args[0] === 'serve').length
    const enabled = () => (JSON.parse(readFileSync(file, 'utf8')) as { enabled: boolean }).enabled

    c.start()
    await c.tick()
    expect(serveCalls()).toBe(1)
    clock += 4_000
    await c.tick()
    expect(serveCalls()).toBe(1)
    clock += 1_000
    await c.tick()
    expect(serveCalls()).toBe(2)
    expect(enabled()).toBe(true)
    expect(stopped).toEqual([])

    clock += 60_000
    await c.tick()
    expect(serveCalls()).toBe(3)
    expect(enabled()).toBe(true)
    clock += 5_000
    await c.tick()
    expect(serveCalls()).toBe(4)
    expect(enabled()).toBe(false)
    expect(stopped).toEqual(['unreadable'])

    for (let i = 0; i < 20; i += 1) {
      clock += 30_000
      await c.tick()
    }
    expect(stopped).toEqual(['unreadable'])
    expect(serveCalls()).toBe(4)
    c.stop()
  })
})

describe('the module never changes Tailscale', () => {
  it('holds exactly three argument lists, frozen: this node without its peers, Serve, and the peers for the connecting Mac', () => {
    expect(TAILSCALE_ARGS).toEqual({ self: ['status', '--json', '--peers=false'], serve: ['serve', 'status', '--json'], peers: ['status', '--json'] })
    expect(Object.isFrozen(TAILSCALE_ARGS) && Object.values(TAILSCALE_ARGS).every((list) => Object.isFrozen(list))).toBe(true)
  })

  it('caps self and serve at 1 MiB and the peer list at 16 MiB', async () => {
    const caps: Record<string, unknown> = {}
    const fake = (_file: string, args: readonly string[], options: { maxBuffer: number }, callback: (error: Error | null, stdout: string) => void) => {
      caps[args.join(' ')] = options.maxBuffer
      callback(null, '{}')
    }
    for (const which of ['self', 'serve', 'peers'] as const) {
      expect(await runTailscale(which, { execFile: fake, exists: cliExists })).toEqual({ ok: true, text: '{}' })
    }
    expect(caps).toEqual({ 'status --json --peers=false': 1024 * 1024, 'serve status --json': 1024 * 1024, 'status --json': 16 * 1024 * 1024 })
    for (const inherited of ['other', 'constructor', 'toString', '__proto__']) {
      expect(await runTailscale(inherited as never, { execFile: fake, exists: cliExists })).toEqual({ ok: false, reason: 'failed' })
    }
  })

  it('refuses peer output past 16 MiB and self output past 1 MiB, even when handed back', async () => {
    const big = (bytes: number) => (_file: string, _args: readonly string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, 'x'.repeat(bytes))
    expect(await runTailscale('peers', { execFile: big(16 * 1024 * 1024 + 1), exists: cliExists })).toEqual({ ok: false, reason: 'failed' })
    expect((await runTailscale('peers', { execFile: big(2 * 1024 * 1024), exists: cliExists })).ok).toBe(true)
    expect(await runTailscale('self', { execFile: big(1024 * 1024 + 1), exists: cliExists })).toEqual({ ok: false, reason: 'failed' })
  })

  // the controller is two files: remote-tailscale.cjs runs the command line, remote-entry.cjs never does
  const source = (name: string) => readFileSync(new URL(`../electron/${name}`, import.meta.url), 'utf8')
  const NO_OTHER_LIST = /\[\s*['"`](?:up|down|set|funnel|reset|cert|logout|switch|web|drive|lock|ssh|nc|ping|bugreport|update|configure|serve(?=['"`]\s*,\s*['"`](?!status)))['"`]/
  const NO_FLAG = /--(?:bg|https|http|tcp|tls-terminated-tcp|set-path|service|accept-app-caps|proxy-protocol|tun|yes)\b/
  const NO_OTHER_RUN = /\bspawn\b|\bexecSync\b|\bexecFileSync\b|\bexec\(|\bfork\(|shell:\s*true/
  const NO_SEARCH = /env\.PATH|env\[['"]PATH['"]\]|\bwhich\(/

  it('names no other Tailscale verb or flag in its source, and runs a command in one place', () => {
    const text = source('remote-tailscale.cjs')
    // the removal hint is shown to the person, never run: take its one definition out first
    const hintLine = `const REMOVAL_HINT = '${REMOVAL_HINT}'`
    expect(text.split(hintLine)).toHaveLength(2)
    const code = text.replace(hintLine, '')
    // the two lists are defined once, and the one run takes its list from them by key
    expect(code.match(/\[\s*'serve'/g)).toHaveLength(1)
    expect(code.match(/'--json'/g)).toHaveLength(3)
    expect(code.match(/'--peers=false'/g)).toHaveLength(1)
    expect(code).toContain("self: Object.freeze(['status', '--json', '--peers=false'])")
    expect(code).toContain("serve: Object.freeze(['serve', 'status', '--json'])")
    expect(code).toContain("peers: Object.freeze(['status', '--json'])")
    expect(code).toContain('const args = Object.hasOwn(TAILSCALE_ARGS, which) ? TAILSCALE_ARGS[which] : null')
    expect(code).toContain('execFile(cli, [...args], { ...RUN_OPTIONS, maxBuffer: cap },')
    expect(code).not.toMatch(NO_OTHER_LIST)
    expect(code).not.toMatch(NO_FLAG)
    expect(code).not.toMatch(NO_OTHER_RUN)
    expect(code.match(/execFile\(/g)).toHaveLength(1)
    expect(code).not.toMatch(NO_SEARCH)
  })

  it('the controller runs nothing itself: no child_process, no argument list, no flag', () => {
    const code = source('remote-entry.cjs')
    expect(code).not.toMatch(/child_process|execFile\(/)
    expect(code).not.toMatch(NO_OTHER_LIST)
    expect(code).not.toMatch(/'--json'|'--peers|\[\s*'serve'|\[\s*'status'/)
    expect(code).not.toMatch(NO_FLAG)
    expect(code).not.toMatch(NO_OTHER_RUN)
    expect(code).not.toMatch(NO_SEARCH)
    // and only the controller requires the Tailscale file
    expect(code).toContain("require('./remote-tailscale.cjs')")
  })
})
