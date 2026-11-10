// `meshctl request-post`, the request-post agent's client (#500, request-post design §3, §4.3,
// §5, §6, §10 R3). End to end against a fake A2A server built from R1's fixtures
// (test/fixtures/a2a-request-post/), never the service: every exit code, the key vectors,
// the override, the card check, redirects, the tailnet's DNS, a cut response, `wait` on a
// fake clock, the terminal rule and off. Every non-zero exit is checked for an empty stdout,
// and every run for no spawned process.
import * as childProcess from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo, LookupFunction } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestKey, runRequestPost } from '../src/request-post-client.js'
import type { RequestPostIo } from '../src/request-post-client.js'
import { runMeshctl } from '../src/meshctl.js'
import { checkExchange, checkStatus } from './fixtures/a2a-request-post/conformance.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

// the client must never spawn: every child_process entry point is counted
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  const wrap = <F extends (...a: never[]) => unknown>(f: F) => vi.fn((...a: Parameters<F>) => f(...a))
  return { ...real, spawn: wrap(real.spawn), spawnSync: wrap(real.spawnSync), exec: wrap(real.exec), execSync: wrap(real.execSync), execFile: wrap(real.execFile), execFileSync: wrap(real.execFileSync), fork: wrap(real.fork) }
})
const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const
const spawned = (): number => SPAWNERS.reduce((n, f) => n + vi.mocked(childProcess[f]).mock.calls.length, 0)

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const TSX = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const FIX = join(REPO, 'test', 'fixtures', 'a2a-request-post')
const EXT = 'urn:agent-inbox:ext:request-post:v1'
const TOKEN = 'c3'.repeat(20)
const MIN = 60_000
const read = (rel: string): Json => JSON.parse(readFileSync(join(FIX, rel), 'utf8'))
const CARD = read('card.json')
const files = readdirSync(join(FIX, 'file')).sort().map((f) => read(`file/${f}`)).filter((x) => x.request)
const byRow = (row: string): Json => structuredClone(files.find((x) => x.row === row)!)
const byPhase = (phase: string): Json => read(`status/${phase}.json`)
const metaOf = (body: Json): Json => body.params.message.metadata[EXT]
const dataOf = (x: Json): Json => { const t = x.response.result.task; return (t.artifacts?.[0] ?? t.status.message).parts.find((p: Json) => p.data).data }

const servers: Server[] = []
let card: Json | ((res: ServerResponse) => void)
let onPost: (body: Json, res: ServerResponse, req: IncomingMessage) => void
let seen: Array<{ headers: IncomingMessage['headers']; body: Json }>
let port: number

const answer = (x: Json) => (body: Json, res: ServerResponse): void =>
  void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...x.response, id: body.id }))

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  servers.push(server as Server)
  return (server.address() as AddressInfo).port
}

beforeEach(async () => {
  card = CARD
  seen = []
  onPost = answer(byRow('created-social'))
  port = await listen(createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        return typeof card === 'function' ? card(res) : void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push({ headers: req.headers, body })
      onPost(body, res, req)
    })
  }))
})

afterEach(async () => {
  for (const s of servers.splice(0)) {
    (s as Server).closeAllConnections?.()
    await new Promise((done) => s.close(done))
  }
  removeScratchDirs()
})

/** A mesh dir as `meshctl enable --request-post --apply` leaves it. */
function meshHome(endpoint: string | null = `http://127.0.0.1:${port}`): string {
  const dir = scratchDir('rp-client-')
  if (endpoint !== null) writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'request-post': { endpoint } } }))
  mkdirSync(join(dir, 'mesh', 'tokens'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'mesh', 'tokens', 'request-post'), `${TOKEN}\n`)
  chmodSync(join(dir, 'mesh', 'tokens', 'request-post'), 0o600)
  return dir
}

async function run(dir: string, args: string[], brief: string | Buffer = 'A brief.\n', extra: Partial<RequestPostIo> = {}) {
  const out: string[] = []
  const err: string[] = []
  const before = spawned()
  const code = await runRequestPost(args, {
    env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', stdin: Readable.from([Buffer.from(brief)]),
    out: (t) => out.push(t), err: (t) => err.push(t), ...extra,
  })
  const r = { code, out: out.join(''), err: err.join('') }
  expect(spawned() - before, 'the client spawned a process').toBe(0)
  if (code !== 0) expect(r.out, `stdout must be empty on exit ${code}: ${r.err}`).toBe('')
  expect(r.err, 'stderr carries no control byte but newline').not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/)
  return r
}

/** The CLI arguments and brief that reproduce a fixture's request. */
function argsOf(x: Json): { args: string[]; brief: string } {
  const m = metaOf(x.request)
  const opt = (flag: string, v: unknown) => (v === undefined ? [] : [flag, String(v)])
  return {
    args: ['file', '--brand', m.brand, '--channels', m.channels.join(','), '--title', m.title,
      ...opt('--category', m.category), ...opt('--slug', m.slug), ...opt('--source-url', m.sourceUrl), ...(m.keyOverride ? ['--key', m.idempotencyKey] : [])],
    brief: x.request.params.message.parts[0].text,
  }
}

async function counting(): Promise<{ port: number; count: () => number }> {
  let n = 0
  const p = await listen(createNetServer((socket) => { n++; socket.destroy() }))
  return { port: p, count: () => n }
}

describe('request keys (design §5, R1 keys.json)', () => {
  it('derives every R1 vector, the brief never counting', () => {
    const { vectors } = read('keys.json')
    expect(vectors.length).toBeGreaterThan(5)
    for (const v of vectors) expect(requestKey(v.input), v.name).toBe(v.key)
  })
})

describe('file (design §3.2, §3.3)', () => {
  for (const x of files) {
    it(`${x.row}: exit ${x.exit}, a conforming request with the derived key`, async () => {
      onPost = answer(x)
      const dir = meshHome()
      const reportFile = join(dir, 'report.json')
      const { args, brief } = argsOf(x)
      const r = await run(dir, [...args, '--report', reportFile], brief)
      expect(r.code, r.err).toBe(x.exit)
      expect(seen).toHaveLength(1)
      const { headers, body } = seen[0]!
      expect([headers.host, headers.authorization, headers['a2a-version'], headers.origin]).toEqual([`127.0.0.1:${port}`, `Bearer ${TOKEN}`, '1.0', undefined])
      expect(body.params.configuration?.returnImmediately).toBeUndefined()
      const { seo: _seo, ...sent } = metaOf(x.request)
      expect(metaOf(body)).toEqual(sent)
      expect('keyOverride' in metaOf(body), 'keyOverride only with --key').toBe(sent.keyOverride === true)
      expect(checkExchange({ exit: x.exit, request: body, response: { ...x.response, id: body.id } }, CARD)).toEqual([])
      expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toEqual(dataOf(x))
      expect((lstatSync(reportFile).mode & 0o777).toString(8)).toBe('600')
      if (x.exit === 0) expect(JSON.parse(r.out)).toEqual(dataOf(x))
    })
  }

  it('says what each exit means to the caller', async () => {
    const said = async (row: string) => { onPost = answer(byRow(row)); const { args, brief } = argsOf(byRow(row)); return (await run(meshHome(), args, brief)).err }
    expect(await said('created-blog')).toContain("waits for Shariq's go")
    expect(await said('refused-invalid')).toContain('refused: fix category, sourceUrl (allowed category: example-category, second-category)')
    expect(await said('refused-screen')).toContain('refused by the screen (letter-shape, private-address)')
    expect(await said('busy')).toContain('busy (daily-budget): try again in about 3600 s')
    expect(await said('uncertain')).toContain(`run the same command again (key ${metaOf(byRow('uncertain').request).idempotencyKey}`)
    expect(await said('conflict')).toMatch(/conflict: https:\/\/www\.notion\.so\/\S+ \(drafting\) already covers this; report that row and never change fields/)
  })

  it('--key sends its key with keyOverride: true; the derived key goes without keyOverride', async () => {
    const args = ['file', '--brand', 'example-brand', '--channels', 'x-standalone', '--title', 'Try the agent']
    expect((await run(meshHome(), [...args, '--key', 'second-try-1'])).code).toBe(0)
    expect((await run(meshHome(), args)).code).toBe(0)
    const [over, derived] = seen.map((s) => metaOf(s.body))
    expect([over!.idempotencyKey, over!.keyOverride]).toEqual(['second-try-1', true])
    expect(derived!.idempotencyKey).toBe(metaOf(byRow('created-social').request).idempotencyKey)
    expect('keyOverride' in derived!).toBe(false)
  })

  it('a cut response is 13, and the re-run sends the same key', async () => {
    onPost = (_b, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' }); res.write('{"jsonrpc":"2.0",'); setTimeout(() => res.destroy(), 20) }
    const dir = meshHome()
    const first = await run(dir, ['file', '--brand', 'example-brand', '--channels', 'x-standalone', '--title', 'Try the agent'])
    expect(first.code).toBe(13)
    expect(first.err).toContain('never file it in-session')
    onPost = answer(byRow('replay'))
    const again = await run(dir, ['file', '--brand', 'example-brand', '--channels', 'x-standalone', '--title', '  TRY the agent '], 'A rewritten brief.')
    expect([again.code, JSON.parse(again.out).created]).toEqual([0, false])
    expect(metaOf(seen[1]!.body).idempotencyKey).toBe(metaOf(seen[0]!.body).idempotencyKey)
  })

  it('a timeout, an HTTP 500 and a JSON-RPC error after sending are 13; HTTP 401 is 15', async () => {
    const args = ['file', '--brand', 'example-brand', '--channels', 'linkedin', '--title', 'x']
    onPost = () => { /* never answers */ }
    expect((await run(meshHome(), args, 'b', { sendMs: 300 })).code).toBe(13)
    onPost = (_b, res) => void res.writeHead(500).end()
    expect((await run(meshHome(), args)).code).toBe(13)
    onPost = (b, res) => void res.writeHead(200).end(JSON.stringify({ jsonrpc: '2.0', id: b.id, error: { code: -32603, message: 'x' } }))
    expect((await run(meshHome(), args)).code).toBe(13)
    onPost = (_b, res) => void res.writeHead(401).end()
    const r = await run(meshHome(), args)
    expect(r.code).toBe(15)
    expect(r.err).toContain('a revoked token, or a shared tailnet')
  })

  it("waits past the service's 30 s task limit: a busy answer at 35 s is 12, one at 45 s is 13", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      for (const [after, exit] of [[35_000, 12], [45_000, 13]] as const) {
        seen = []
        onPost = (b, res) => void setTimeout(() => answer(byRow('busy'))(b, res), after)
        const { args, brief } = argsOf(byRow('busy'))
        const pending = run(meshHome(), args, brief)
        while (!seen.length) await new Promise((done) => setImmediate(done))
        await vi.advanceTimersByTimeAsync(after + 1000)
        const r = await pending
        expect(r.code, r.err).toBe(exit)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('--report never keeps a stale report: an exit without a data part writes its code', async () => {
    const reportFile = join(scratchDir('rp-report-'), 'report.json')
    writeFileSync(reportFile, '{"stale":true}')
    chmodSync(reportFile, 0o644)
    const report = () => [JSON.parse(readFileSync(reportFile, 'utf8')), (lstatSync(reportFile).mode & 0o777).toString(8)]
    const args = ['--key', 'k', '--report', reportFile]
    expect((await run(meshHome(null), ['status', ...args])).code).toBe(14)
    expect(report()).toEqual([{ code: 14 }, '600'])
    const free = await counting()
    servers.pop()!.close()
    expect((await run(meshHome(`http://127.0.0.1:${free.port}`), ['status', ...args])).code).toBe(15)
    expect(report()[0]).toEqual({ code: 15 })
    let t = 0
    onPost = answer(byPhase('drafting'))
    expect((await run(meshHome(), ['wait', ...args], '', { now: () => t, sleep: async (ms) => { t += ms } })).code).toBe(124)
    expect(report()[0]).toEqual({ code: 124 })
    const r = await run(meshHome(), ['wait', ...args], '', { now: () => { throw new Error('clock') } })
    expect([r.code, report()[0]]).toEqual([13, { code: 13 }])
    expect(r.err).toContain('outcome unknown (internal error)')
  })

  it('refuses locally: usage is 4, a bad brief is 11, and neither connects', async () => {
    const c = await counting()
    const dir = meshHome(`http://127.0.0.1:${c.port}`)
    const ok = ['file', '--brand', 'b', '--channels', 'blog', '--title', 't']
    for (const args of [[], ['nope'], ['file'], ['file', '--brand', 'b', '--channels', 'blog'], [...ok, '--brand', 'c'], [...ok, '--through-go'], [...ok, '--key', 'has space'],
      ['status'], ['status', '--key', 'k', '--page-id', 'p'], ['wait', '--through-go', '--through-go', '--key', 'k'], ['status', '--key']]) {
      expect((await run(dir, args)).code, args.join(' ')).toBe(4)
    }
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'link'))
    expect((await run(dir, [...ok, '--report', join(dir, 'link')])).code).toBe(4)
    for (const brief of ['', '   \n', 'x'.repeat(8193), 'bell\x07', Buffer.from([0xff, 0xfe])]) {
      expect((await run(dir, ok, brief)).code, JSON.stringify(brief.slice(0, 9))).toBe(11)
    }
    expect((await run(dir, [...ok, '--brief-file', dir])).code).toBe(4)
    expect(c.count()).toBe(0)
  })

  it('reads the brief from --brief-file, CRLF as LF', async () => {
    const dir = meshHome()
    writeFileSync(join(dir, 'brief.md'), 'line one\r\nline two\r\n')
    expect((await run(dir, ['file', '--brand', 'b', '--channels', 'linkedin', '--title', 't', '--brief-file', join(dir, 'brief.md')], '')).code).toBe(0)
    expect(seen[0]!.body.params.message.parts).toEqual([{ text: 'line one\nline two\n' }])
  })
})

describe('the endpoint and the card (design §3.1, §6, §8)', () => {
  const args = ['file', '--brand', 'example-brand', '--channels', 'x-standalone', '--title', 'Try the agent']

  it('a card that does not match is 15 with "update agent-inbox or the service", and nothing is sent', async () => {
    const broken: Array<(c: Json) => void> = [
      (c) => { c.skills = c.skills.filter((s: Json) => s.id !== 'request-post-status') },
      (c) => { c.skills = c.skills.filter((s: Json) => s.id !== 'request-post') },
      (c) => { c.supportedInterfaces[0].protocolVersion = '0.3' },
      (c) => { c.capabilities.extensions[0].params.api = 2 },
      (c) => { c.capabilities.extensions[0].uri = 'urn:other' },
    ]
    for (const breakIt of broken) {
      card = structuredClone(CARD)
      breakIt(card)
      const r = await run(meshHome(), args)
      expect(r.code).toBe(15)
      expect(r.err).toContain('update agent-inbox or the service')
    }
    card = (res) => void res.writeHead(200).end('<html>not a card</html>')
    expect((await run(meshHome(), args)).code).toBe(15)
    expect(seen).toEqual([])
  })

  it('never follows a redirect: on the card it is 15, on the call 13, and the target sees nothing', async () => {
    const c = await counting()
    card = (res) => void res.writeHead(302, { location: `http://127.0.0.1:${c.port}/.well-known/agent-card.json` }).end()
    const r = await run(meshHome(), args)
    expect([r.code, seen.length]).toEqual([15, 0])
    expect(r.err).toContain('redirect')
    card = CARD
    onPost = (_b, res) => void res.writeHead(307, { location: `http://127.0.0.1:${c.port}/` }).end()
    expect((await run(meshHome(), args)).code).toBe(13)
    expect(c.count()).toBe(0)
  })

  it('a tailnet name that does not resolve is 15, and so is a refused or failed TLS connection', async () => {
    const lookups: string[] = []
    const nowhere = ((host: string, _o: unknown, cb: (e: NodeJS.ErrnoException) => void) => {
      lookups.push(host)
      cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))
    }) as unknown as LookupFunction
    const own = (): string => 'tailnet-name.ts.net'
    const r = await run(meshHome('https://request-post.tailnet-name.ts.net'), args, 'b', { lookup: nowhere, tailnet: own })
    expect(r.code).toBe(15)
    expect(r.err).toContain('does not resolve: is this machine on the personal tailnet? A shared tailnet gives this by design')
    expect(lookups).toEqual(['request-post.tailnet-name.ts.net'])
    // the name resolves, but what answers is no TLS server
    const c = await counting()
    const loop = ((_h: string, o: Json, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as unknown as LookupFunction
    expect((await run(meshHome(`https://request-post.tailnet-name.ts.net:${c.port}`), args, 'b', { lookup: loop, tailnet: own })).code).toBe(15)
    expect(c.count()).toBe(1)
    const free = await counting()
    servers.pop()!.close()
    expect((await run(meshHome(`http://127.0.0.1:${free.port}`), args)).code).toBe(15)
  })

  it('sends nothing to a tailnet endpoint outside this Mac\'s tailnet (§8.8, #557); this Mac\'s own still connects', async () => {
    const lookups: string[] = []
    const c = await counting()
    const loop = ((host: string, o: Json, cb: (...a: unknown[]) => void) => {
      lookups.push(host)
      return o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
    }) as unknown as LookupFunction
    const endpoint = `https://request-post.tailnet-example.ts.net:${c.port}`
    let suffix: string | undefined = 'other-example.ts.net'
    let asked = 0
    const extra = { lookup: loop, tailnet: () => { asked++; return suffix } }
    // this Mac on another tailnet (an account switch, or an entry written before #557 or by hand):
    // unavailable, nothing sent, and never the in-session path, which could file a duplicate
    const other = await run(meshHome(endpoint), args, 'b', extra)
    expect(other.code).toBe(15)
    expect(other.err).toBe('request-post: unavailable: this Mac is not on the tailnet the request-post endpoint request-post.tailnet-example.ts.net is configured for (this Mac is on other-example.ts.net), so nothing was sent: switch back, or run meshctl enable --request-post again. Retry once, then report it; do not file it in-session.\n')
    // wait treats it as temporary: it keeps polling for 30 minutes, then is 15, never 14
    let t = 0
    const before = asked
    const waited = await run(meshHome(endpoint), ['wait', '--key', 'k'], '', { ...extra, now: () => t, sleep: async (ms) => { t += ms } })
    expect(waited.code).toBe(15)
    expect(t).toBeGreaterThanOrEqual(30 * MIN)
    expect(asked - before).toBeGreaterThan(2)
    expect(waited.err).toContain('no status for 30 minutes: this Mac is not on the tailnet')
    expect(waited.err).not.toMatch(/off:|File it in-session/)
    // the suffix cannot be read: unavailable, nothing sent
    suffix = undefined
    const unknown = await run(meshHome(endpoint), args, 'b', extra)
    expect(unknown.code).toBe(15)
    expect(unknown.err).toContain('this Mac\'s tailnet could not be read (is Tailscale installed, running and logged in?)')
    expect([lookups, c.count(), seen.length]).toEqual([[], 0, 0])
    // this Mac's own tailnet passes the check and reaches the endpoint (here no TLS server, so 15)
    suffix = 'tailnet-example.ts.net'
    const ownCall = await run(meshHome(endpoint), args, 'b', extra)
    expect(ownCall.code).toBe(15)
    expect(ownCall.err).toContain('unavailable: cannot reach request-post.tailnet-example.ts.net')
    expect([lookups, c.count()]).toEqual([['request-post.tailnet-example.ts.net'], 1])
    // the SSH fallback's loopback endpoint never asks
    const loopbackBefore = asked
    expect((await run(meshHome(), args, 'b', extra)).code).toBe(0)
    expect(asked).toBe(loopbackBefore)
  })

  it('agent text reaches stderr and stdout without control bytes', async () => {
    const x = byPhase('ready-for-human')
    const d = dataOf(x)
    d.humanAction = 'Approve \x1b[31mnow\x1b[0m\x9b2J\u2028then go'
    d.error = { text: 'bad\x07bell', untrusted: true }
    onPost = answer(x)
    const r = await run(meshHome(), ['status', '--key', 'k'])
    expect(r.code).toBe(0)
    expect(r.err).toContain('Approve  [31mnow [0m 2J then go')
    expect(r.out).not.toMatch(/[\x00-\x09\x0B-\x1F\x7F-\x9F\u2028]/)
    expect(JSON.parse(r.out).humanAction).toBe(d.humanAction)
  })
})

describe('status (design §3.3)', () => {
  for (const phase of ['awaiting-go', 'queued', 'drafting', 'in-review', 'ready-for-human', 'proposed', 'needs-fix', 'failed', 'rejected', 'published']) {
    it(`${phase}: prints the snapshot and the human's action`, async () => {
      const x = byPhase(phase)
      onPost = answer(x)
      const m = metaOf(x.request)
      const r = await run(meshHome(), ['status', ...(m.requestKey ? ['--key', m.requestKey] : ['--page-id', m.pageId])])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toEqual(dataOf(x))
      expect(r.err).toContain(`request-post: ${phase}`)
      if (dataOf(x).humanAction) expect(r.err).toContain(`Shariq: ${dataOf(x).humanAction}`)
      expect(checkStatus({ exit: 0, request: seen[0]!.body, response: { ...x.response, id: seen[0]!.body.id } }, CARD)).toEqual([])
    })
  }

  it('--page-id asks by page', async () => {
    onPost = answer(byPhase('queued'))
    expect((await run(meshHome(), ['status', '--page-id', 'p-1'])).code).toBe(0)
    expect(metaOf(seen[0]!.body)).toEqual({ skill: 'request-post-status', pageId: 'p-1' })
  })
})

describe('wait (design §4.3), on a fake clock', () => {
  /** Runs `wait` with replies in order (the last repeats); returns the minute of each read. */
  async function waitWith(replies: Array<Json | ((b: Json, res: ServerResponse) => void)>, extra: string[] = [], dir = meshHome()) {
    let t = 0
    const reads: number[] = []
    onPost = (b, res) => {
      reads.push(t / MIN)
      const next = replies.length > 1 ? replies.shift()! : replies[0]!
      return typeof next === 'function' ? next(b, res) : answer(next)(b, res)
    }
    const r = await run(dir, ['wait', '--key', 'u3niopolofwhyhbnz27awnzmpe', ...extra], '', { now: () => t, sleep: async (ms) => { t += ms } })
    return { ...r, reads, minutes: t / MIN }
  }

  it('reads every 2 minutes for 30 minutes, then every 15, and exits 0 on a final phase', async () => {
    const r = await waitWith([...Array(17).fill(byPhase('drafting')), byPhase('in-review'), byPhase('proposed')])
    expect(r.code).toBe(0)
    expect(r.reads).toEqual([...Array.from({ length: 16 }, (_, i) => i * 2), 45, 60, 75])
    expect(JSON.parse(r.out).phase).toBe('proposed')
    expect(r.err).toBe(`request-post: now in-review\nrequest-post: proposed; Shariq: ${dataOf(byPhase('proposed')).humanAction}\n`)
  })

  it('rides out 5xx, a cut answer, an unreachable card and a budget refusal', async () => {
    let cardDown = false
    card = (res) => (cardDown ? ((cardDown = false), res.destroy()) : void res.writeHead(200).end(JSON.stringify(CARD)))
    const r = await waitWith([
      (_b, res) => void res.writeHead(503).end(),
      (_b, res) => { cardDown = true; res.writeHead(200, { 'content-length': '99' }); res.end('{') },
      byRow('busy'),
      byPhase('ready-for-human'),
    ])
    // 0: 503; 0.5: cut; 1.5: no card (no POST); 3.5: busy for an hour, so 15 min; 18.5: final
    expect([r.code, r.reads, JSON.parse(r.out).phase]).toEqual([0, [0, 0.5, 3.5, 18.5], 'ready-for-human'])
    expect(r.err).toBe(`request-post: ready-for-human; Shariq: ${dataOf(byPhase('ready-for-human')).humanAction}\n`)
  })

  it('a budget refusal waits its retryAfterMs (at most 15 minutes) and is not a failure', async () => {
    const busy = structuredClone(byRow('busy'))
    const r = await waitWith([busy, busy, busy, byPhase('published')])
    expect([r.code, r.reads]).toEqual([0, [0, 15, 30, 45]])
  })

  it('exits 15 after 30 minutes of continuous failure, and backs off on the way', async () => {
    let t = 0
    const reads: number[] = []
    card = (res) => { reads.push(t / MIN); res.destroy() }
    const r = await run(meshHome(), ['wait', '--key', 'k'], '', { now: () => t, sleep: async (ms) => { t += ms } })
    expect(r.code).toBe(15)
    expect(r.err).toContain('no status for 30 minutes')
    expect(reads).toEqual([0, 0.5, 1.5, 3.5, 7.5, 15.5, 30])
  })

  it('a failure streak that recovers starts the 30 minutes again', async () => {
    const down = (_b: Json, res: ServerResponse) => void res.writeHead(503).end()
    const r = await waitWith([down, down, down, down, down, byPhase('drafting'), down, down, down, down, down, down, byPhase('proposed')])
    expect(r.code).toBe(0)
    expect(r.reads).toEqual([0, 0.5, 1.5, 3.5, 7.5, 15.5, 17.5, 18, 19, 21, 25, 33, 47.5])
  })

  it('ends after 4 hours with 124 and an empty stdout', async () => {
    const r = await waitWith([byPhase('drafting')])
    expect([r.code, r.minutes, r.out]).toEqual([124, 240, ''])
    expect(r.reads.at(-1)).toBe(225)
    expect(r.err).toContain('no final phase within 4 hours (last: drafting): run the same wait again')
  })

  it('awaiting-go is final unless --through-go', async () => {
    const plain = await waitWith([byPhase('awaiting-go'), byPhase('ready-for-human')])
    expect([plain.code, JSON.parse(plain.out).phase, plain.reads]).toEqual([0, 'awaiting-go', [0]])
    const through = await waitWith([byPhase('awaiting-go'), byPhase('queued'), byPhase('ready-for-human')], ['--through-go'])
    expect([through.code, JSON.parse(through.out).phase, through.reads]).toEqual([0, 'ready-for-human', [0, 2, 4]])
  })

  it('a card mismatch, a refusal or off ends it at once', async () => {
    card = { ...CARD, skills: [] }
    expect((await waitWith([byPhase('queued')])).code).toBe(15)
    card = CARD
    const refused = await waitWith([byRow('refused-invalid')])
    expect([refused.code, refused.reads]).toEqual([11, [0]])
    expect((await waitWith([byPhase('queued')], [], meshHome(null))).code).toBe(14)
  })
})

describe('off means off (design §10 Off, mesh §2.4)', () => {
  it('without the key, or with an endpoint outside the rule or a non-private token, it connects nowhere and exits 14', async () => {
    const c = await counting()
    const on = `http://127.0.0.1:${c.port}`
    const cases: Array<[string, (dir: string) => void]> = [
      ['no mesh.json', () => {}],
      ['no agents', (dir) => writeFileSync(join(dir, 'mesh.json'), '{"schema":1}')],
      ['no key', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint: on } } }))],
      ['newer schema', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 2, agents: { 'request-post': { endpoint: on } } }))],
      ['a symlink', (dir) => { writeFileSync(join(dir, 'real.json'), JSON.stringify({ schema: 1, agents: { 'request-post': { endpoint: on } } })); symlinkSync(join(dir, 'real.json'), join(dir, 'mesh.json')) }],
      ...[`http://localhost:${c.port}`, `${on}/path`, `https://127.0.0.1:${c.port}`, `http://request-post.tailnet-name.ts.net:${c.port}`, `https://example.com:${c.port}`].map((endpoint): [string, (dir: string) => void] =>
        [endpoint, (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'request-post': { endpoint } } }))]),
      ['token 0644', (dir) => { writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'request-post': { endpoint: on } } })); chmodSync(join(dir, 'mesh', 'tokens', 'request-post'), 0o644) }],
    ]
    for (const [name, arrange] of cases) {
      const dir = meshHome(null)
      arrange(dir)
      for (const args of [['file', '--brand', 'b', '--channels', 'blog', '--title', 't'], ['status', '--key', 'k'], ['wait', '--key', 'k']]) {
        const r = await run(dir, args)
        expect(r.code, `${name}: ${args[0]}`).toBe(14)
        expect(r.err).toContain('File it in-session')
      }
    }
    expect(c.count()).toBe(0)
  })

  it('meshctl request-post without the async entry is a usage error; the source spawns nothing and reads no terminal', () => {
    const err: string[] = []
    expect(runMeshctl(['request-post', 'file'], { env: { AGENT_INBOX_MESH_DIR: scratchDir('rp-') }, err: (t) => err.push(t), out: () => {} })).toBe(4)
    expect(err.join('')).toContain('request-post file --brand')
    const source = readFileSync(join(REPO, 'src', 'request-post-client.ts'), 'utf8')
    expect(source).not.toMatch(/child_process|\/dev\/tty|setRawMode|node:readline|node:tty|followRedirect|HTTPS?_PROXY/)
  })

  it.skipIf(!['darwin', 'linux'].includes(process.platform))('under a pseudo-terminal the CLI exits without waiting on the terminal', () => {
    const dir = meshHome(null)
    const cli = [process.execPath, '--import', TSX, join(REPO, 'src', 'meshctl.ts'), 'request-post', 'file', '--brand', 'b', '--channels', 'blog', '--title', 't']
    const quoted = (argv: string[]): string => argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')
    const pty = (command: string) => childProcess.spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', command] : ['-qec', command, '/dev/null'],
      { env: { PATH: process.env['PATH'], AGENT_INBOX_MESH_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
    const tty = pty(`${quoted(cli)}; echo "exit=$?"`)
    expect(tty.error).toBeUndefined()
    expect(tty.stdout).toContain('never reads a terminal')
    expect(tty.stdout).toContain('exit=4')
    const piped = pty(`printf 'brief' | ${quoted(cli)}; echo "exit=$?"`)
    expect(piped.stdout).toContain('request-post: off:')
    expect(piped.stdout).toContain('exit=14')
  }, 40_000)
})
