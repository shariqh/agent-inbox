// `meshctl request-post` (#500, request-post design §3, §4.3, §5, §6, §8; slice R3): the
// client the `<mesh dir>/bin/request-post` shim runs. Node core only, and only meshctl
// imports it: never the stdio MCP server or the viewer. It never spawns a process, never
// reads a terminal, never follows a redirect and never uses a proxy or the card's URL: it
// talks to the configured endpoint only, with `Host` exactly that endpoint's authority.
// Off (no `agents.request-post` by the one reading rule) is exit 14 before any connection.
// A tailnet endpoint must still be in this Mac's tailnet before each exchange (#557, mesh
// design §8.8); the suffix comes in as `io.tailnet`, meshctl's `tailscale status` reader.
//
// Exit codes are request-post's own (design §3.3), not unslop's: 0 ok, 11 refused,
// 12 busy, 13 outcome unknown, 14 off (or an endpoint on another tailnet), 15 unavailable
// (DNS, TLS, refused, a redirect, a card mismatch or this Mac's tailnet unreadable; nothing
// sent), 16 conflict, 124 `wait` ran its 4 hours, 4 usage.
// The data part reaches stdout only on exit 0.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { join, resolve } from 'node:path'
import { checkCard } from './agent-card.js'
import { inTailnet, meshDir, meshFile, readMesh, requestPostEndpoint } from './mesh-config.js'
import type { RunCollector } from './mesh-runs.js'

const EXTENSION = 'urn:agent-inbox:ext:request-post:v1'
const FINAL = ['awaiting-go', 'ready-for-human', 'proposed', 'needs-fix', 'failed', 'rejected', 'published']
const BRIEF_MAX = 8192
const MIN = 60_000
const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const ID = /^[\x21-\x7e]{1,128}$/
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW, O_NONBLOCK } = constants

export const REQUEST_POST_USAGE = `usage: <mesh dir>/bin/request-post file --brand <brand> --channels <c>[,<c>…] --title <title>
         [--category <c> --slug <s>] [--source-url <url>] [--key <k>] [--brief-file <f>] [--report <f>] < brief
       <mesh dir>/bin/request-post status (--key <k> | --page-id <id>) [--report <f>]
       <mesh dir>/bin/request-post wait (--key <k> | --page-id <id>) [--through-go] [--report <f>]
(the shim runs agent-inbox-meshctl request-post with the same arguments; docs/request-post.md)
Exit 0 ok (JSON on stdout), 11 refused, 12 busy, 13 outcome unknown, 14 off,
15 unavailable, 16 conflict, 124 wait ran 4 h, 4 usage. stdout is empty unless 0.
`

export interface RequestPostIo {
  env: NodeJS.ProcessEnv
  home: string
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean }
  out: (text: string) => void
  err: (text: string) => void
  /** `wait`'s clock (tests pass a fake one) */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** the 30 s limit of one call (tests shorten it) */
  sendMs?: number
  /** DNS for a tailnet name (tests point it elsewhere) */
  lookup?: LookupFunction
  /** This Mac's MagicDNS suffix, asked before each exchange with a tailnet endpoint (meshctl passes `tailscale status`'s) */
  tailnet?: () => string | undefined
  /** the meshctl entry's run record (cards view V5 §5.3): armed once the key passes its rule */
  run?: RunCollector
}

type Json = Record<string, unknown>
type KeyInput = { brand: string; channels: string[]; title: string; slug?: string; sourceUrl?: string }
type Result = { exit: number; why?: string; data?: Json; fatal?: boolean }
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
// agent-supplied text lands in an assistant's shell: no control bytes, one line
const clean = (v: unknown, max = 300): string => String(v).replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, ' ').slice(0, max)
const json = (v: unknown): string => `${JSON.stringify(v, null, 2).replace(/[\x7F-\x9F\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`

/** Design §5 with R1's pre-image: version, brand, sorted channels and one identity line; never the brief. */
export function requestKey(r: KeyInput): string {
  const channels = [...r.channels].sort()
  const title = r.title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  const identity = channels.includes('blog') ? `slug:${r.slug ?? ''}` : r.sourceUrl !== undefined ? `url:${r.sourceUrl}` : `title:${title}`
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of createHash('sha256').update(['request-post/v1', r.brand, channels.join(','), identity].join('\n'), 'utf8').digest()) {
    value = ((value << 8) | byte) & 0xffff
    for (bits += 8; bits >= 5 && out.length < 26; bits -= 5) out += B32[(value >>> (bits - 5)) & 31]
  }
  return out
}

type Reply = { status: number; body: string } | { failed: 'before' | 'after'; code: string }
/** One exchange with the endpoint. `before` means nothing reached the service. */
function call(base: URL, io: RequestPostIo, o: { method: string; headers?: Record<string, string>; body?: string; timeoutMs: number }): Promise<Reply> {
  return new Promise((done) => {
    const tls = base.protocol === 'https:'
    let connected = false
    let settled = false
    const finish = (r: Reply): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if ('failed' in r) req.destroy()
      done(r)
    }
    const fail = (code: string): void => finish({ failed: connected ? 'after' : 'before', code })
    const req = (tls ? httpsRequest : httpRequest)({
      host: base.hostname, port: base.port || (tls ? 443 : 80), method: o.method, path: o.method === 'GET' ? '/.well-known/agent-card.json' : '/',
      agent: false, lookup: io.lookup, servername: tls ? base.hostname : undefined, headers: { host: base.host, ...o.headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { if ((body += chunk).length > 1024 * 1024) fail('too-large') })
      res.on('close', () => (res.complete ? finish({ status: res.statusCode ?? 0, body }) : fail('cut')))
    })
    req.on('socket', (socket) => socket.once(tls ? 'secureConnect' : 'connect', () => { connected = true }))
    req.on('error', (error: NodeJS.ErrnoException) => fail(error.code ?? 'error'))
    const timer = setTimeout(() => fail('timeout'), o.timeoutMs)
    req.end(o.body)
  })
}

/** A private file: regular (never a symlink), this user's, no group or other bits. */
function readPrivate(path: string): string {
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077 || stat.size > 4096) throw new Error('not private')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

const unreachable = (base: URL, code: string): string => code === 'ENOTFOUND' || code === 'EAI_AGAIN'
  ? `${base.hostname} does not resolve: is this machine on the personal tailnet? A shared tailnet gives this by design`
  : `cannot reach ${base.host} (${clean(code, 40)})`

/** The card check, then one blocking SendMessage (design §3.1, §3.3). */
async function send(base: URL, token: string, io: RequestPostIo, meta: Json, text: string): Promise<Result> {
  // §8.8 (#557): a tailnet endpoint must still be in this Mac's tailnet, or nothing is sent
  if (base.protocol === 'https:') {
    const suffix = io.tailnet?.()
    if (suffix === undefined) return { exit: 15, why: `this Mac's tailnet could not be read (is Tailscale installed, running and logged in?), so ${base.hostname} cannot be told from another tailnet or a Funnel host` }
    if (!inTailnet(base.hostname, suffix)) {
      return { exit: 14, why: `${base.hostname} is on another tailnet or a Funnel host, not this Mac's tailnet (${suffix}), so nothing was sent: run meshctl enable --request-post again with the service's name on this Mac's tailnet` }
    }
  }
  // above the service's 30 s task limit (design §5), so its lock-wait 12 arrives as 12, not 13
  const limit = io.sendMs ?? 40_000
  const got = await call(base, io, { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: Math.min(limit, 10_000) })
  if ('failed' in got) return { exit: 15, why: unreachable(base, got.code) }
  if (got.status >= 300 && got.status < 400) return { exit: 15, why: `${base.host} answered with a redirect, which this client never follows` }
  let card: Json = {}
  try { card = obj(JSON.parse(got.body)) } catch { /* below */ }
  if (got.status !== 200 || !Object.keys(card).length) return { exit: 15, why: `${base.host} has no agent card (HTTP ${got.status})` }
  // the one card rule (agent cards view design §4.4); any failed check is the same 15
  if (checkCard(card, 'request-post')) {
    return { exit: 15, fatal: true, why: 'the agent card does not match this client (skills, A2A 1.0 or the api 1 extension): update agent-inbox or the service' }
  }
  const id = randomUUID()
  const r = await call(base, io, {
    method: 'POST', timeoutMs: limit,
    headers: { authorization: `Bearer ${token}`, 'a2a-version': '1.0', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], metadata: { [EXTENSION]: meta } } } }),
  })
  if ('failed' in r) return r.failed === 'before' ? { exit: 15, why: unreachable(base, r.code) } : { exit: 13, why: `the connection ended before the answer (${r.code})` }
  if (r.status === 401 || r.status === 403) return { exit: 15, why: `the service refused this device (HTTP ${r.status}): a revoked token, or a shared tailnet` }
  if (r.status !== 200) return { exit: 13, why: `HTTP ${r.status}` }
  let reply: Json = {}
  try { reply = obj(JSON.parse(r.body)) } catch { /* below */ }
  const task = obj(obj(reply['result'])['task'])
  if (reply['id'] !== id || typeof task['id'] !== 'string') return { exit: 13, why: reply['error'] ? `JSON-RPC error ${clean(obj(reply['error'])['code'], 20)}` : 'no task in the answer' }
  // R1: the data part sits in the one artifact on COMPLETED, else in the status message
  const status = obj(task['status'])
  const state = status['state']
  const parts = state === 'TASK_STATE_COMPLETED' ? list(list(task['artifacts'])[0]?.['parts']) : list(obj(status['message'])['parts'])
  const data = obj(parts.find((p) => p['data'] !== undefined)?.['data'])
  const exit = state === 'TASK_STATE_COMPLETED' ? (data['code'] === 0 ? 0 : 13)
    : state === 'TASK_STATE_REJECTED' ? (data['code'] === 12 ? 12 : data['reason'] === 'conflict' ? 16 : 11) : 13
  return { exit, data, why: clean(parts.find((p) => typeof p['text'] === 'string')?.['text'] ?? state) }
}

async function readBrief(io: RequestPostIo, file: string | undefined): Promise<Buffer> {
  if (file !== undefined) {
    const fd = openSync(file, O_RDONLY | O_NONBLOCK)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
      const buffer = Buffer.alloc(BRIEF_MAX + 1)
      return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
    } finally {
      closeSync(fd)
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of io.stdin) {
    chunks.push(Buffer.from(chunk))
    if ((size += chunks.at(-1)!.length) > BRIEF_MAX) break
  }
  return Buffer.concat(chunks)
}

export async function runRequestPost(args: string[], io: RequestPostIo): Promise<number> {
  const say = (text: string): void => io.err(`request-post: ${text}\n`)
  const usage = (): number => { io.err(REQUEST_POST_USAGE); return 4 }
  const [sub, ...rest] = args
  const valued: Record<string, string[]> = {
    file: ['--brand', '--channels', '--title', '--category', '--slug', '--source-url', '--key', '--brief-file', '--report'],
    status: ['--key', '--page-id', '--report'], wait: ['--key', '--page-id', '--report'],
  }
  if (sub === undefined || !valued[sub]) return usage()
  const v = new Map<string, string>()
  let throughGo = false
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!
    if (sub === 'wait' && name === '--through-go' && !throughGo) throughGo = true
    else if (valued[sub]!.includes(name) && rest[i + 1] !== undefined && !v.has(name)) v.set(name, rest[++i]!)
    else return usage()
  }
  for (const name of ['--key', '--page-id']) if (v.has(name) && !ID.test(v.get(name)!)) return usage()
  if (sub === 'file' ? !v.get('--brand') || !v.get('--channels') || !v.get('--title') : v.has('--key') === v.has('--page-id')) return usage()
  const report = v.get('--report')
  if (report !== undefined) {
    let bad = false
    try { bad = !lstatSync(report).isFile() } catch { /* absent: written later */ }
    if (bad) { say(`--report ${report} is a symlink or not a regular file`); return 4 }
  }

  let wrote = false
  const writeReport = (d: Json): boolean => {
    try {
      const fd = openSync(report!, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK, 0o600)
      try {
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
        fchmodSync(fd, 0o600)
        writeSync(fd, json(d))
      } finally { closeSync(fd) }
      return (wrote = true)
    } catch {
      return false
    }
  }
  const go = async (): Promise<number> => {
    let text = 'status'
    let meta: Json
    if (sub === 'file') {
      if (!v.has('--brief-file') && io.stdin.isTTY) { say('pipe the brief on stdin or pass --brief-file <file>: this command never reads a terminal'); return 4 }
      let bytes: Buffer
      try { bytes = await readBrief(io, v.get('--brief-file')) } catch { say(`cannot read ${v.get('--brief-file')} as a regular file`); return 4 }
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n') } catch { text = '\0' }
      if (bytes.length > BRIEF_MAX || !text.trim() || /[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(text)) {
        say(`refused: fix brief (at most ${BRIEF_MAX} bytes of UTF-8 text, not blank, no control characters but tab and newline)`)
        return 11
      }
      const channels = v.get('--channels')!.split(',').map((c) => c.trim())
      const fields = { brand: v.get('--brand')!, channels, title: v.get('--title')!, category: v.get('--category'), slug: v.get('--slug'), sourceUrl: v.get('--source-url') }
      // --key overrides the identity key for a deliberate second request (design §5); the
      // service refuses a key that is not the derived one unless keyOverride is true
      meta = { skill: 'request-post', ...fields, idempotencyKey: v.get('--key') ?? requestKey(fields), ...(v.has('--key') ? { keyOverride: true } : {}) }
    } else {
      meta = { skill: 'request-post-status', ...(v.has('--key') ? { requestKey: v.get('--key') } : { pageId: v.get('--page-id') }) }
    }

    // off (design §6, mesh §2.4): nothing below runs without the key
    const dir = resolve(meshDir(io.env, io.home))
    const mesh = readMesh(meshFile(dir))
    const entry = mesh.kind === 'present' ? obj(obj(mesh.doc['agents'])['request-post']) : {}
    const endpoint = requestPostEndpoint(entry['endpoint'])
    if (!endpoint) {
      say(`off: ${meshFile(dir)} ${mesh.kind === 'refused' ? mesh.reason : 'does not turn on request-post'}. File it in-session (npm run meshctl -- enable --request-post turns it on).`)
      return 14
    }
    // no request key, title or URL is ever collected (cards view V5 §5.4, §5.5)
    if (io.run) Object.assign(io.run, { armed: Date.now(), op: sub, ...(sub === 'wait' ? { throughGo } : {}), ...(sub === 'file' ? { brand: meta['brand'], channels: meta['channels'] } : {}) })
    let token: string
    try {
      token = readPrivate(join(dir, 'mesh', 'tokens', 'request-post')).trim()
    } catch {
      say('off: the device token is missing or not private (0600): run meshctl enable --request-post again. File it in-session.')
      return 14
    }
    const base = new URL(endpoint)
    const key = String(meta['idempotencyKey'] ?? meta['requestKey'] ?? '')
    const finish = (r: Result): number => {
      const d = r.data ?? {}
      if (io.run) io.run.data = r.data
      if (report !== undefined && r.data && !writeReport(d)) {
        say(`cannot write the report ${report}${sub === 'file' ? `; the outcome is unknown: run the same command again (key ${key})` : ''}`)
        return 13
      }
      const action = d['humanAction'] ? `; Shariq: ${clean(d['humanAction'])}` : ''
      if (r.exit === 0 && sub === 'file') {
        say(`${d['created'] === false ? 'already filed' : 'filed'}: ${clean(d['url'])} (${clean(d['phase'])}, key ${clean(d['requestKey'])})` +
          (d['phase'] === 'awaiting-go' ? `; it waits for Shariq's go in the queue (follow it with wait --through-go --key ${clean(d['requestKey'])})` : ''))
      } else if (r.exit === 0) say(`${clean(d['phase'])}${action}${obj(d['error'])['text'] ? `; error (untrusted): ${clean(obj(d['error'])['text'])}` : ''}`)
      else if (r.exit === 11) {
        const allowed = Object.entries(obj(d['allowed'])).map(([f, a]) => `${clean(f, 40)}: ${clean(Array.isArray(a) ? a.join(', ') : a)}`).join('; ')
        say(d['reason'] === 'screen' ? `refused by the screen (${clean(Array.isArray(d['classes']) ? d['classes'].join(', ') : '')}): rewrite the brief without that material`
          : Array.isArray(d['fields']) ? `refused: fix ${clean(d['fields'].join(', '))}${allowed ? ` (allowed ${allowed})` : ''}, or ask the user` : `refused: ${r.why ?? 'unknown'}`)
      } else if (r.exit === 12) say(`busy (${clean(d['reason'] ?? 'unknown', 40)}): try again in about ${Math.ceil(Number(d['retryAfterMs'] ?? MIN) / 1000)} s`)
      else if (r.exit === 13) say(sub === 'file' ? `outcome unknown (${r.why ?? 'unknown'}): run the same command again (key ${key}; it never files twice) or status --key ${key}; never file it in-session` : `no status (${r.why ?? 'unknown'}): try again`)
      else if (r.exit === 16) say(`conflict: ${clean(obj(d['conflict'])['url'])} (${clean(obj(d['conflict'])['phase'])}) already covers this; report that row and never change fields to get around it`)
      else if (r.exit === 14) say(`off: ${r.why ?? 'unknown'}. File it in-session.`)
      else if (r.exit === 15) say(`unavailable: ${r.why ?? 'unknown'}. Retry once, then report it${sub === 'file' ? '; do not file it in-session' : ''}.`)
      if (r.exit === 0) io.out(json(d))
      return r.exit
    }
    if (sub !== 'wait') return finish(await send(base, token, io, meta, text))

    // wait (design §4.3): every 2 min for 30 min, then every 15; transient failures back off
    // and only 30 min of them is 15; each run ends after 4 h with 124
    const now = io.now ?? Date.now
    const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
    const start = now()
    const end = start + 240 * MIN
    let failingSince: number | undefined
    let failures = 0
    let last: unknown
    for (;;) {
      const r = await send(base, token, io, meta, text)
      let delay: number
      if (r.exit === 0) {
        failingSince = undefined
        failures = 0
        const phase = r.data?.['phase']
        if (typeof phase === 'string' && FINAL.includes(phase) && !(throughGo && phase === 'awaiting-go')) return finish(r)
        if (phase !== last && last !== undefined) say(`now ${clean(phase, 40)}`)
        last = phase
        if (io.run && typeof phase === 'string') io.run.phase = phase
        delay = now() - start < 30 * MIN ? 2 * MIN : 15 * MIN
      } else if (r.exit === 12) {
        failingSince = undefined
        failures = 0
        delay = Math.min(Math.max(Number(r.data?.['retryAfterMs']) || 0, 2 * MIN), 15 * MIN)
      } else if ((r.exit === 13 || r.exit === 15) && !r.fatal) {
        failingSince ??= now()
        if (now() - failingSince >= 30 * MIN) return finish({ exit: 15, why: `no status for 30 minutes: ${r.why ?? 'unknown'}` })
        delay = Math.min(30_000 * 2 ** failures++, 15 * MIN, failingSince + 30 * MIN - now())
      } else return finish(r)
      if (now() + delay >= end) {
        await sleep(Math.max(0, end - now()))
        say(`no final phase within 4 hours (last: ${clean(last ?? 'none', 40)}): run the same wait again if it still matters`)
        return 124
      }
      await sleep(delay)
    }
  }
  let code: number
  try {
    code = await go()
  } catch {
    if (io.run) io.run.internal = true
    say(`outcome unknown (internal error): run the same command again${sub === 'file' ? ' (the key makes it safe); never file it in-session' : ''}`)
    code = 13
  }
  // an exit without a data part still replaces an earlier report, so none is left stale
  if (report !== undefined && !wrote && !writeReport({ code })) say(`cannot write the report ${report}`)
  return code
}
