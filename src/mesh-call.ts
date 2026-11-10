// `meshctl call <id>` (#530; mesh design §6.7 D15–D17, §8.5, §8.8): the one generic A2A 1.0
// client for an agent added with `meshctl add`. Node core and the mesh's own modules only, and
// only meshctl imports it: never the stdio MCP server or the viewer. It reads the request from
// stdin, never from a terminal, and never spawns a process. Off (no `agents.<id>` entry that
// `add` wrote, by the one reading rule) is exit 14 before any connection. Otherwise it reads the
// token copy, re-checks a tailnet endpoint against this Mac's tailnet, fetches the card fresh (on
// loopback with the identity challenge, label `a2a-mesh`, so the token and the request go only to
// a connection that proved it holds the token), and compares its pin with the entry's before it
// sends anything else: a changed card is 16 and nothing is sent. Then one task, streamed with a
// GetTask fallback (SendMessage when the card does not stream), and the result printed through
// frameResult (D16). stdout gets the framed result only on exit 0. Exit codes: docs/mesh-call.md.
import { randomUUID } from 'node:crypto'
import { closeSync, constants, lstatSync, writeSync } from 'node:fs'
import type { LookupFunction } from 'node:net'
import { resolve } from 'node:path'
import { checkAddedCard, summarizeCard } from './agent-card.js'
import { frameResult } from './agent-result.js'
import { addedEntry, addedPlace, cardSha256, tailnetRefusal } from './mesh-add.js'
import type { Place } from './mesh-add.js'
import { meshDir, meshFile, openPrivate, readMesh, readPrivate } from './mesh-config.js'
import { meshLink, tlsLink } from './mesh-identity.js'
import type { Exchange, MeshLink } from './mesh-identity.js'
import type { RunCollector } from './mesh-runs.js'

const INPUT_MAX = 64 * 1024
const CARD_MAX = 64 * 1024
const RESULT_MAX = 1024 * 1024
// everything a stream may send, status updates included
const STREAM_MAX = 4 * 1024 * 1024
const CARD_MS = 5_000
const POLL_MS = 5_000
const TERMINAL = ['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']
// a one-shot client cannot answer these, so they end the call too
const INTERRUPTED = ['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']
// A2A 1.0's TaskState names: any other string an agent sends is ignored, so it never reaches the report
const STATES = [...TERMINAL, ...INTERRUPTED, 'TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']
const TASK_ID = /^[\x21-\x7e]{1,128}$/

export const CALL_USAGE = `usage: agent-inbox-meshctl call <id> [--skill <skill>] [--json] [--report <file>] [--timeout <s>] < request
Sends one request (stdin, at most 64 KiB of UTF-8) to an agent added with meshctl add and prints
its result framed as untrusted text. Exit 0: the framed result is on stdout. Any other exit:
stdout is empty. Exit codes: docs/mesh-call.md. Default --timeout 300 s.
`

export interface CallIo {
  env: NodeJS.ProcessEnv
  home: string
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean }
  out: (text: string) => void
  err: (text: string) => void
  /** This Mac's MagicDNS suffix, for a tailnet entry only (meshctl passes `tailscale status`'s). */
  tailnet?: () => string | undefined
  /** DNS for a tailnet name, and the CA that replaces the system roots (test seams only) */
  lookup?: LookupFunction
  ca?: string
  /** GetTask's interval after a stream ends early (tests shorten it) */
  pollMs?: number
  /** the meshctl entry's run record (cards view V5 §5.3): armed once the entry passes its rule */
  run?: RunCollector
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
// the parts as one text: text parts as sent, data parts as two-space JSON
const partsText = (parts: Json[]): string =>
  parts.map((p) => (typeof p['text'] === 'string' ? p['text'] : p['data'] !== undefined ? JSON.stringify(p['data'], null, 2) : '')).filter(Boolean).join('\n\n')

type Ended = { code: number; reason?: string; parts?: Json[]; state?: string }

export async function runCall(args: string[], io: CallIo): Promise<number> {
  const say = (text: string): void => io.err(`meshctl call: ${text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')}\n`)
  // the id comes first, so meshctl's entry names the run record by args[0]
  const id = args[0]?.startsWith('-') ? undefined : args[0]
  let json = false
  let bad = false
  const values = new Map<string, string>()
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--json' && !json) json = true
    else if (['--skill', '--report', '--timeout'].includes(arg) && args[i + 1] !== undefined && !values.has(arg)) values.set(arg, args[++i]!)
    else bad = true
  }
  const timeoutText = values.get('--timeout') ?? '300'
  if (bad || id === undefined || !/^\d{1,3}$/.test(timeoutText) || +timeoutText < 1 || +timeoutText > 600) {
    io.err(CALL_USAGE)
    return 4
  }
  const report = values.get('--report')
  if (report !== undefined) {
    let other = false
    try { other = !lstatSync(report).isFile() } catch { /* absent: written later */ }
    if (other) {
      say(`--report ${report} is a symlink or not a regular file`)
      return 4
    }
  }
  if (io.stdin.isTTY) {
    say('pipe the request on stdin: this command never reads a terminal')
    return 4
  }

  const links: MeshLink[] = []
  let ended: Ended
  let pin: string | undefined
  try {
    ended = await call(id, values.get('--skill'), +timeoutText * 1000, io, links, say, (p) => { pin = p })
  } finally {
    for (const link of links) link.close()
  }
  let { code } = ended
  if (io.run && ended.reason) io.run.data = { reason: ended.reason }
  const text = ended.parts ? partsText(ended.parts) : undefined
  if (text !== undefined && Buffer.byteLength(text) > RESULT_MAX) {
    say(`failed: the result is over ${RESULT_MAX / 1024 / 1024} MiB`)
    code = 13
    if (io.run) io.run.data = { reason: 'too-large' }
  }
  const source = { agent: id, cardSha256: pin ?? '' }
  const framed = text !== undefined && pin ? JSON.parse(frameResult(text, source, { json: true })) as Json : {}
  // every exit after the argument checks rewrites the report, so a stale one never survives
  if (report !== undefined) {
    try {
      const fd = openPrivate(report, constants.O_TRUNC)
      try { writeSync(fd, `${JSON.stringify({ exit: code, ...(ended.state ? { state: ended.state } : {}), ...framed }, null, 2)}\n`) } finally { closeSync(fd) }
    } catch {
      say(`failed: cannot write the report ${report}`)
      if (io.run) io.run.data = { reason: 'report' }
      return 13
    }
  }
  if (code === 0 && text !== undefined && pin) io.out(frameResult(text, source, { json }))
  return code
}

async function readInput(io: CallIo): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of io.stdin) {
    const bytes = Buffer.from(chunk)
    chunks.push(bytes)
    if ((size += bytes.length) > INPUT_MAX) break
  }
  return Buffer.concat(chunks)
}

async function call(id: string, skill: string | undefined, timeoutMs: number, io: CallIo, links: MeshLink[], say: (text: string) => void, pinned: (pin: string) => void): Promise<Ended> {
  const bytes = await readInput(io)
  let text: string
  try {
    if (bytes.length > INPUT_MAX) throw new Error('size')
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    say(`refused: the request must be at most ${INPUT_MAX / 1024} KiB of UTF-8 text`)
    return { code: 11 }
  }
  if (!text.trim()) {
    say('refused: the request is empty')
    return { code: 11 }
  }

  // off: nothing below runs without an entry meshctl add wrote
  const dir = resolve(meshDir(io.env, io.home))
  const file = meshFile(dir)
  const mesh = readMesh(file)
  const agents = mesh.kind === 'present' ? obj(mesh.doc['agents']) : {}
  const entry = Object.hasOwn(agents, id) ? addedEntry(id, agents[id]) : undefined
  if (mesh.kind === 'refused' || entry === undefined || entry === 'invalid') {
    say(`off: ${mesh.kind === 'refused' ? `${file} ${mesh.reason}`
      : entry === 'invalid' ? `the entry for ${id} breaks meshctl add's rules: meshctl remove ${id} --apply, then add it again`
        : `${file} has no agent added under that id (meshctl add adds one; built-in agents have their own commands)`}`)
    return { code: 14 }
  }
  const place = addedPlace(entry.endpoint) as Place
  const card = new URL(entry.card)
  if (!place.loopback) {
    // §8.8: the tailnet the entry was added on must still be this Mac's
    const elsewhere = tailnetRefusal(`agents.${id}`, place, io.tailnet?.())
    if (elsewhere) {
      say(`off: ${elsewhere}`)
      return { code: 14 }
    }
  }
  let token: string | undefined
  if (entry.tokenFile !== undefined) {
    try { token = readPrivate(entry.tokenFile).trim() } catch { /* below */ }
  }
  if (entry.tokenFile !== undefined || place.loopback) {
    if (!token) {
      say(`off: the token copy for ${id} is missing or not private (0600): meshctl remove ${id} --apply, then add it again with --token-file`)
      return { code: 14 }
    }
  }
  if (io.run) Object.assign(io.run, { armed: Date.now(), op: 'call' })

  // the card, fresh, and on loopback the identity proof before anything else is sent (D17)
  const link = place.loopback ? meshLink(Number(card.port), token!, 'a2a-mesh', card.pathname) : tlsLink(new URL(place.origin), token, card.pathname, { lookup: io.lookup, ca: io.ca })
  links.push(link)
  const squatter: Ended = { code: 14, reason: 'identity' }
  const unproven = (): Ended => {
    say(`another process answers at ${place.origin}: it did not prove it holds ${id}'s token, so neither the token nor the request was sent. ` +
      'Is the agent running, and does it answer the a2a-mesh/v1 challenge (docs/mesh-call.md)?')
    return squatter
  }
  const unavailable = (why: string): Ended => {
    say(`unavailable: ${why}; nothing was sent`)
    return { code: 15, reason: 'unavailable' }
  }
  const got = await link.card(CARD_MS)
  if (got === 'unproven') return unproven()
  if (got === 'refused') return unavailable(`nothing answers at ${place.origin}: is the agent running?`)
  if (got === 'error') return unavailable(`the card request to ${place.origin} failed (no answer in ${CARD_MS / 1000} s, a cut connection, DNS or TLS)`)
  if (got.status !== 200) return unavailable(`the card URL answered HTTP ${got.status}${got.status >= 300 && got.status < 400 ? ', and call follows no redirect' : ''}`)
  let fetched: Json | undefined
  try {
    if (Buffer.byteLength(got.body) <= CARD_MAX) fetched = JSON.parse(got.body) as Json
  } catch { /* below */ }
  let pin: string | undefined
  try {
    if (fetched && typeof fetched === 'object' && !Array.isArray(fetched)) pin = cardSha256(fetched)
  } catch { /* nested too deeply */ }
  if (!fetched || pin === undefined) return unavailable(`the card URL sent no JSON card of at most ${CARD_MAX / 1024} KiB`)
  if (pin !== entry.cardSha256) {
    say(`card changed: the card at ${entry.card} is not the one you added (pin ${entry.cardSha256.slice(0, 12)}, now ${pin.slice(0, 12)}), so nothing was sent. ` +
      `To accept it after looking: meshctl remove ${id} --apply, then meshctl add ${entry.card} --id ${id}${token === undefined ? '' : ' --token-file <your token file>'} (a dry run that shows the card) and again with --apply`)
    return { code: 16, reason: 'card-changed' }
  }
  pinned(pin)
  if (checkAddedCard(fetched)) return unavailable('the card no longer passes meshctl add\'s card rule')
  if (skill !== undefined && !list(fetched['skills']).some((s) => s['id'] === skill)) {
    say(`refused: ${id}'s card has no skill with that id; its skills: ${summarizeCard(fetched).skills.items.map((s) => s.id).join(', ')}`)
    return { code: 11, reason: 'skill' }
  }

  return task(id, text, obj(fetched['capabilities'])['streaming'] === true, new URL(entry.endpoint).pathname, link, timeoutMs, io, say, unproven)
}

/** One task: SendStreamingMessage (or SendMessage), GetTask while it is not final, CancelTask at the deadline. */
async function task(id: string, text: string, streaming: boolean, path: string, link: MeshLink, timeoutMs: number, io: CallIo, say: (text: string) => void, unproven: () => Ended): Promise<Ended> {
  const stop = new AbortController()
  const begun = Date.now()
  const timer = setTimeout(() => stop.abort('deadline'), timeoutMs)
  const left = (): number => Math.max(1, timeoutMs - (Date.now() - begun))
  const headers = { 'a2a-version': '1.0', 'content-type': 'application/json' }
  const rpc = (method: string, params: Json, o: { timeout: number; signal?: AbortSignal; onChunk?: (chunk: string) => void; accept?: string }): Promise<Exchange> =>
    link.call({
      method: 'POST', path, headers: o.accept ? { ...headers, accept: o.accept } : headers, timeoutMs: o.timeout, signal: o.signal, onChunk: o.onChunk,
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    })

  let taskId: string | undefined
  let state: string | undefined
  let rpcError = false
  let reply: Json[] | undefined
  let statusParts: Json[] = []
  const artifacts = new Map<string, Json[]>()
  const status = (s: Json): void => {
    if (STATES.includes(s['state'] as string)) state = s['state'] as string
    const parts = list(obj(s['message'])['parts'])
    if (parts.length) statusParts = parts
  }
  const artifact = (a: Json, append: boolean): void => {
    const key = String(a['artifactId'] ?? artifacts.size)
    artifacts.set(key, [...(append ? artifacts.get(key) ?? [] : []), ...list(a['parts'])])
  }
  // a Task, a Message, or one stream event (A2A 1.0's result wrappers)
  const take = (result: Json): void => {
    const t = obj(result['task'])
    if (typeof t['id'] === 'string' && TASK_ID.test(t['id'])) {
      taskId = t['id']
      status(obj(t['status']))
      if (Array.isArray(t['artifacts'])) {
        artifacts.clear()
        for (const a of list(t['artifacts'])) artifact(a, false)
      }
    }
    const message = obj(result['message'])
    if (Array.isArray(message['parts'])) {
      reply = list(message['parts'])
      state = 'TASK_STATE_COMPLETED'
    }
    if (result['artifactUpdate']) artifact(obj(obj(result['artifactUpdate'])['artifact']), obj(result['artifactUpdate'])['append'] === true)
    if (result['statusUpdate']) status(obj(obj(result['statusUpdate'])['status']))
    if (io.run) io.run.task = taskId
  }
  const answer = (body: string): void => {
    try {
      const message = obj(JSON.parse(body))
      if (message['error']) rpcError = true
      else take(obj(message['result']))
    } catch { /* malformed: GetTask has the truth */ }
  }
  const final = (): boolean => TERMINAL.includes(state ?? '') || INTERRUPTED.includes(state ?? '')

  let buffered = ''
  let raw = ''
  let received = 0
  const onChunk = (chunk: string): void => {
    if ((received += chunk.length) > STREAM_MAX) return void stop.abort('too-large')
    if (raw.length < RESULT_MAX) raw += chunk
    buffered += chunk
    const events = buffered.split(/\r?\n\r?\n/)
    buffered = events.pop() ?? ''
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
      if (data) answer(data)
    }
  }
  const message = { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] } }
  try {
    const sent = streaming
      ? await rpc('SendStreamingMessage', message, { timeout: timeoutMs, signal: stop.signal, onChunk, accept: 'text/event-stream' })
      : await rpc('SendMessage', message, { timeout: timeoutMs, signal: stop.signal })
    if (sent === 'unproven') return unproven()
    if (sent === 'refused') {
      say('unavailable: the agent stopped before the request was sent')
      return { code: 15, reason: 'unavailable' }
    }
    if (typeof sent !== 'string') {
      if (sent.status === 401 || sent.status === 403) {
        say(`off: the agent refused the token (HTTP ${sent.status}): meshctl remove ${id} --apply, then add it again with a current --token-file`)
        return { code: 14, reason: 'token' }
      }
      if (sent.status === 429 || sent.status === 503) {
        say(`busy: the agent answered HTTP ${sent.status}; try again later`)
        return { code: 12, reason: 'busy' }
      }
      if (sent.status !== 200) {
        say(`failed: the agent answered HTTP ${sent.status} without a task`)
        return { code: 13, reason: 'http' }
      }
      if (!sent.type.startsWith('text/event-stream')) answer(streaming ? raw : sent.body)
    }
    // the stream ended early, or SendMessage returned before the end: GetTask until a final state
    if (!final() && taskId && !stop.signal.aborted) {
      say('the task is not finished; checking it every few seconds')
      for (let misses = 0; misses < 3 && !stop.signal.aborted && !final();) {
        await Promise.race([sleep(Math.min(io.pollMs ?? POLL_MS, left())), new Promise((done) => stop.signal.addEventListener('abort', done, { once: true }))])
        if (stop.signal.aborted) break
        const got = await rpc('GetTask', { id: taskId }, { timeout: Math.min(10_000, left()), signal: stop.signal })
        let result: Json = {}
        try { if (typeof got !== 'string') result = obj(JSON.parse(got.body)) } catch { /* counted below */ }
        if (got === 'unproven') return unproven()
        if (result['result']) {
          misses = 0
          take({ task: result['result'] })
        } else if (result['error']) misses = 3
        else misses++
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (!final() || INTERRUPTED.includes(state!)) {
    if (taskId && (stop.signal.aborted || final())) await rpc('CancelTask', { id: taskId }, { timeout: 2000 })
    const why = INTERRUPTED.includes(state ?? '') ? ['input-required', 'the agent asked for more input or for authorization, which meshctl call cannot give; the task was cancelled']
      : stop.signal.reason === 'deadline' ? ['deadline', `no result within ${Math.round(timeoutMs / 1000)} s; the task was cancelled`]
        : stop.signal.reason === 'too-large' ? ['too-large', `the agent sent more than ${STREAM_MAX / 1024 / 1024} MiB; the task was cancelled`]
          : rpcError ? ['rpc-error', 'the agent answered with a JSON-RPC error'] : ['lost', 'lost the agent before the task finished']
    say(`failed: ${why[1]}`)
    return { code: 13, reason: why[0], state }
  }
  if (state === 'TASK_STATE_COMPLETED') {
    const done = [...artifacts.values()].flat()
    return { code: 0, parts: reply ?? (done.length ? done : statusParts), state }
  }
  const coded = statusParts.map((p) => obj(p['data'])['code']).find((c) => c !== undefined)
  const rejected = state === 'TASK_STATE_REJECTED'
  const code = rejected ? (coded === 12 ? 12 : 11) : 13
  say(`${code === 12 ? 'busy' : rejected ? 'refused' : 'failed'}: the task ended ${state!.replace('TASK_STATE_', '').toLowerCase()}${statusParts.length ? ' (--report keeps its message, framed as untrusted)' : ''}`)
  return { code, reason: code === 12 ? 'busy' : rejected ? 'rejected' : 'failed', parts: statusParts, state }
}
