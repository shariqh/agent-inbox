// `meshctl unslop` (#483, unslop design §3.3, §4.3-§4.5, §6.3, §7.2-§7.3): the
// client the `<mesh dir>/bin/unslop` shim runs. Node core only, and only meshctl
// imports it: never the stdio MCP server or the viewer. It reads the draft from
// stdin (or --in), never from a terminal, and never prompts. Off (no
// `agents.unslop` in mesh.json by the one reading rule) is exit 14 before any
// spawn or connection. Otherwise it fetches the agent's card, starts the
// profile's `start` command when nothing answers, checks the card's version,
// streams one task and falls back to GetTask polling when the stream drops.
// The edited text reaches stdout only on exit 0; on any other exit stdout is empty.
//
// Exit codes: 0 rewritten or unchanged, 10 kept the original, 11 refused,
// 12 busy, 13 failed or timed out, 14 off, no agent or a card mismatch, 4 usage.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { request } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { checkCard } from './agent-card.js'
import { loopbackPort, meshDir, meshFile, readMesh } from './mesh-config.js'

const EXTENSION = 'urn:agent-inbox:ext:unslop:v1'
const KINDS = ['pr', 'issue', 'release-notes', 'docs', 'blog']
const INPUT_MAX = 12 * 1024
const PRIVATE_MAX = 64 * 1024
const START_WAIT_MS = 10_000
const POLL_MS = 5_000
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'])
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_APPEND, O_NOFOLLOW, O_NONBLOCK } = constants

export const UNSLOP_USAGE = `usage: <mesh dir>/bin/unslop --kind <pr|issue|release-notes|docs|blog> [--report <file>] [--timeout <s>] [--in <file>] < draft
       (the shim runs agent-inbox-meshctl unslop with the same arguments)
Sends one public draft to the local unslop agent. Email, customer text and private
material stay in-session. Exit 0: the edited text is on stdout. Any other exit:
stdout is empty; edit the original in-session. Default --timeout 280 s.
`

export interface UnslopIo {
  env: NodeJS.ProcessEnv
  home: string
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean }
  out: (text: string) => void
  err: (text: string) => void
  spawn?: typeof nodeSpawn
  /** GetTask's interval after a dropped stream (tests shorten it) */
  pollMs?: number
  /** the local deadline only, when tests need it shorter than the --timeout sent to the agent */
  deadlineMs?: number
}

type Json = Record<string, unknown>
type Reply = { status: number; type: string; body: string }
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** One HTTP exchange with the agent; `onChunk` streams the body instead of collecting it. */
function http(port: number, o: { method: string; path: string; headers?: Json; body?: string; timeoutMs: number; signal?: AbortSignal; onChunk?: (text: string) => void }): Promise<Reply | 'refused' | 'error'> {
  return new Promise((done) => {
    let body = ''
    let settled = false
    const finish = (result: Reply | 'refused' | 'error'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', abort)
      if (typeof result === 'string') req.destroy()
      done(result)
    }
    const req = request({ host: '127.0.0.1', port, method: o.method, path: o.path, agent: false, headers: { host: `127.0.0.1:${port}`, ...(o.headers as Record<string, string>) } }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        if (o.onChunk && res.statusCode === 200) o.onChunk(chunk)
        else if (body.length < 1024 * 1024) body += chunk
      })
      res.on('end', () => finish({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body }))
      res.on('error', () => finish('error'))
      res.on('aborted', () => finish('error'))
    })
    const abort = (): void => finish('error')
    const timer = setTimeout(abort, o.timeoutMs)
    o.signal?.addEventListener('abort', abort, { once: true })
    req.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'error'))
    req.end(o.body)
  })
}

/** A private file: regular (never a symlink), this user's, no group or other bits. */
function readPrivate(path: string): string {
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077 || stat.size > PRIVATE_MAX) throw new Error('not private')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function openPrivate(path: string, flags: number): number {
  const fd = openSync(path, flags | O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  if (!fstatSync(fd).isFile()) {
    closeSync(fd)
    throw new Error('not a regular file')
  }
  fchmodSync(fd, 0o600)
  return fd
}

async function readInput(io: UnslopIo, file: string | undefined): Promise<Buffer> {
  if (file !== undefined) {
    const fd = openSync(file, O_RDONLY | O_NONBLOCK)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
      const buffer = Buffer.alloc(INPUT_MAX + 1)
      return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0))
    } finally {
      closeSync(fd)
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of io.stdin) {
    const bytes = Buffer.from(chunk)
    chunks.push(bytes)
    size += bytes.length
    if (size > INPUT_MAX) break
  }
  return Buffer.concat(chunks)
}

type Card = { kind: 'none' } | { kind: 'bad' } | { kind: 'ok'; card: Json }
async function getCard(port: number): Promise<Card> {
  const reply = await http(port, { method: 'GET', path: '/.well-known/agent-card.json', timeoutMs: 3000 })
  if (reply === 'refused') return { kind: 'none' }
  if (reply === 'error' || reply.status !== 200) return { kind: 'bad' }
  try {
    return { kind: 'ok', card: obj(JSON.parse(reply.body)) }
  } catch {
    return { kind: 'bad' }
  }
}

/** Starts the profile's `start` argv, detached and without a shell; a string says why not. */
function startAgent(dir: string, io: UnslopIo): { exited: () => boolean; log: string } | string {
  const profile = join(dir, 'mesh', 'wrappers', 'unslop.json')
  let start: unknown
  try {
    start = obj(JSON.parse(readPrivate(profile))).start
  } catch {
    return `${profile} must be a JSON file owned by you with mode 0600: run meshctl enable --unslop`
  }
  if (!Array.isArray(start) || !start.length || !start.every((a) => typeof a === 'string' && !/[\x00-\x1f\x7f]/.test(a)) || !isAbsolute(start[0])) {
    return `the profile's "start" must be a list of arguments, the first an absolute path: run meshctl enable --unslop`
  }
  const logs = join(dir, 'mesh', 'logs')
  const log = join(logs, 'unslop-agent.log')
  let fd: number
  try {
    mkdirSync(logs, { recursive: true, mode: 0o700 })
    fd = openPrivate(log, O_APPEND)
  } catch {
    return `cannot write ${log}`
  }
  let exited = false
  try {
    const child = (io.spawn ?? nodeSpawn)(start[0] as string, start.slice(1) as string[], {
      detached: true, stdio: ['ignore', fd, fd], cwd: dir, env: { ...io.env, AGENT_INBOX_MESH_DIR: dir },
    })
    child.on('error', () => { exited = true })
    child.on('exit', () => { exited = true })
    child.unref()
  } finally {
    closeSync(fd)
  }
  return { exited: () => exited, log }
}

type Outcome = { state?: string; data?: Json; text?: string }

export async function runUnslop(args: string[], io: UnslopIo): Promise<number> {
  // agent-supplied text reaches an assistant's shell output: no control bytes but tab and newline
  const say = (text: string): void => io.err(`unslop: ${text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')}\n`)
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i]!, args[i + 1]]
    if (!['--kind', '--report', '--timeout', '--in'].includes(name) || value === undefined || values.has(name)) {
      io.err(UNSLOP_USAGE)
      return 4
    }
    values.set(name, value)
  }
  const kind = values.get('--kind')
  const timeoutText = values.get('--timeout') ?? '280'
  const report = values.get('--report')
  if (kind === undefined || !/^\d{1,3}$/.test(timeoutText) || +timeoutText < 1 || +timeoutText > 600) {
    io.err(UNSLOP_USAGE)
    return 4
  }
  if (!KINDS.includes(kind)) {
    say(`refused: --kind must be one of ${KINDS.join(', ')}. Edit it in-session.`)
    return 11
  }
  if (report !== undefined) {
    let isLink = false
    try { isLink = !lstatSync(report).isFile() } catch { /* absent: written later */ }
    if (isLink) {
      say(`--report ${report} is a symlink or not a regular file`)
      return 4
    }
  }
  if (!values.has('--in') && io.stdin.isTTY) {
    say('pipe the draft on stdin or pass --in <file>: this command never reads a terminal')
    return 4
  }
  let text: string
  let bytes: Buffer
  try {
    bytes = await readInput(io, values.get('--in'))
  } catch {
    say(`cannot read ${values.get('--in') ?? 'stdin'} as a regular file`)
    return 4
  }
  try {
    if (bytes.length > INPUT_MAX) {
      say(`refused: the draft is over ${INPUT_MAX / 1024} KiB. Edit it in-session.`)
      return 11
    }
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    say('refused: the draft cannot be read as UTF-8 text. Edit it in-session.')
    return 11
  }
  if (!text.trim()) {
    say('refused: the draft is empty')
    return 11
  }

  // off (design §4.5 f): nothing below runs without the key
  const dir = resolve(meshDir(io.env, io.home))
  const mesh = readMesh(meshFile(dir))
  const entry = mesh.kind === 'present' ? obj(obj(mesh.doc['agents'])['unslop']) : {}
  if (!('endpoint' in entry)) {
    say(`off: ${meshFile(dir)} ${mesh.kind === 'refused' ? mesh.reason : 'does not turn on unslop'}. Edit it in-session (npm run meshctl -- enable --unslop turns it on).`)
    return 14
  }
  const port = loopbackPort(entry['endpoint'])
  if (!port) {
    say('off: agents.unslop.endpoint must be http://127.0.0.1:<port>. Run meshctl enable --unslop again.')
    return 14
  }
  const unavailable = (why: string): number => {
    say(`${why}. Edit it in-session.`)
    return 14
  }

  let card = await getCard(port)
  if (card.kind === 'none') {
    const started = startAgent(dir, io)
    if (typeof started === 'string') return unavailable(`no agent at 127.0.0.1:${port} and cannot start one: ${started}`)
    say('starting the agent')
    for (const until = Date.now() + START_WAIT_MS; card.kind === 'none' && Date.now() < until;) {
      const gone = started.exited()
      await sleep(200)
      card = await getCard(port)
      if (gone) break
    }
    if (card.kind === 'none') return unavailable(`the agent did not start; see ${started.log}`)
  }
  if (card.kind === 'bad') return unavailable(`something other than the unslop agent answers at 127.0.0.1:${port}`)
  // the one card rule (unslop design §4.4, §8.3; agent cards view design §4.4)
  const mismatch = checkCard(card.card, 'unslop')
  if (mismatch) return unavailable(`the agent's card does not match this meshctl (${mismatch}): rebuild packages/mesh (npm ci && npm run build there) and stop the running agent`)
  let token: string
  try {
    token = readPrivate(join(dir, 'mesh', 'tokens', 'unslop')).trim()
  } catch {
    return unavailable('the caller token is missing or not private (0600): run meshctl enable --unslop again')
  }

  const timeoutMs = +timeoutText * 1000
  const deadline = new AbortController()
  const begun = Date.now()
  const timer = setTimeout(() => deadline.abort(), io.deadlineMs ?? timeoutMs)
  const left = (): number => Math.max(1, (io.deadlineMs ?? timeoutMs) - (Date.now() - begun))
  const headers = { authorization: `Bearer ${token}`, 'a2a-version': '1.0', 'content-type': 'application/json' }
  const rpc = (method: string, params: Json, timeout: number): Promise<Reply | 'refused' | 'error'> =>
    http(port, { method: 'POST', path: '/', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), timeoutMs: timeout })

  let taskId: string | undefined
  const outcome: Outcome = {}
  let note = ''
  const apply = (status: Json): void => {
    outcome.state = String(status['state'] ?? '')
    const parts = Array.isArray(obj(status['message'])['parts']) ? obj(status['message'])['parts'] as unknown[] : []
    const said = parts.map(obj).find((p) => typeof p['text'] === 'string')?.['text']
    outcome.data = parts.map(obj).find((p) => p['data'])?.['data'] as Json | undefined ?? outcome.data
    if (!TERMINAL.has(outcome.state) && typeof said === 'string' && said !== note) say((note = said))
  }
  const artifact = (value: unknown): void => {
    const parts = Array.isArray(obj(value)['parts']) ? obj(value)['parts'] as unknown[] : []
    outcome.text = parts.map(obj).find((p) => typeof p['text'] === 'string')?.['text'] as string | undefined
    outcome.data = obj(parts.map(obj).find((p) => p['data'])?.['data'])
  }
  const take = (result: Json): void => {
    const task = obj(result['task'])
    if (typeof task['id'] === 'string') {
      taskId = task['id']
      apply(obj(task['status']))
      if (Array.isArray(task['artifacts'])) artifact(task['artifacts'][0])
    }
    if (result['artifactUpdate']) artifact(obj(result['artifactUpdate'])['artifact'])
    if (result['statusUpdate']) apply(obj(obj(result['statusUpdate'])['status']))
  }

  let buffered = ''
  const streamed = await http(port, {
    method: 'POST', path: '/', headers: { ...headers, accept: 'text/event-stream' }, timeoutMs: timeoutMs + 60_000, signal: deadline.signal,
    body: JSON.stringify({
      jsonrpc: '2.0', id: randomUUID(), method: 'SendStreamingMessage',
      params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], metadata: { [EXTENSION]: { kind, timeoutMs } } } },
    }),
    onChunk: (chunk) => {
      buffered += chunk
      const events = buffered.split(/\r?\n\r?\n/)
      buffered = events.pop() ?? ''
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        try {
          if (data) take(obj(obj(JSON.parse(data))['result']))
        } catch { /* a malformed event: GetTask has the truth */ }
      }
    },
  })
  try {
    if (typeof streamed !== 'string' && streamed.status === 401) {
      return unavailable('a running agent holds an older token; it stops within a minute, so run the command again shortly')
    }
    if (typeof streamed !== 'string' && streamed.status === 403) {
      return unavailable('the agent refused this call (HTTP 403): run meshctl enable --unslop again')
    }
    if (typeof streamed !== 'string' && !streamed.type.startsWith('text/event-stream')) {
      say(`failed: the agent answered HTTP ${streamed.status} without a task. Edit it in-session.`)
      return 13
    }
    // the stream dropped: GetTask every few seconds until a final state (design §7.3)
    if (!TERMINAL.has(outcome.state ?? '') && taskId && !deadline.signal.aborted) {
      say('the stream dropped; checking the task every few seconds')
      for (let misses = 0; misses < 3 && !deadline.signal.aborted && !TERMINAL.has(outcome.state ?? '');) {
        await Promise.race([sleep(Math.min(io.pollMs ?? POLL_MS, left())), new Promise((done) => deadline.signal.addEventListener('abort', done, { once: true }))])
        if (deadline.signal.aborted) break
        const got = await rpc('GetTask', { id: taskId }, Math.min(10_000, left()))
        let result: Json = {}
        try {
          if (typeof got !== 'string') result = obj(JSON.parse(got.body))
        } catch { /* counted below */ }
        if (result['result']) {
          misses = 0
          take({ task: result['result'] })
        } else if (result['error']) misses = 3
        else misses++
      }
    }
    if (!TERMINAL.has(outcome.state ?? '')) {
      if (deadline.signal.aborted && taskId) await rpc('CancelTask', { id: taskId }, 2000)
      say(deadline.signal.aborted ? `failed: no result within ${timeoutText} s; the task was cancelled. Edit it in-session.` : 'failed: lost the agent. Edit it in-session.')
      return 13
    }
  } finally {
    clearTimeout(timer)
  }

  const data = outcome.data ?? {}
  const code = outcome.state === 'TASK_STATE_COMPLETED' ? (data['code'] === 0 || data['code'] === 10 ? data['code'] : 13)
    : outcome.state === 'TASK_STATE_REJECTED' ? (data['code'] === 12 ? 12 : 11) : 13
  if (report !== undefined && outcome.data) {
    try {
      const fd = openPrivate(report, O_TRUNC)
      try { writeSync(fd, `${JSON.stringify(data, null, 2)}\n`) } finally { closeSync(fd) }
    } catch {
      say(`failed: cannot write the report ${report}. Edit it in-session.`)
      return 13
    }
  }
  const reason = typeof data['reason'] === 'string' ? data['reason'] : 'unknown'
  if (data['skillStale']) say('warning: the agent kept its last good rules because rules.md could not be re-read')
  if (code === 0 && typeof outcome.text === 'string') {
    const warnings = Array.isArray(data['warnings']) ? data['warnings'].map(obj) : []
    say(`${String(data['status'])} by ${String(data['model'])} (attempts: ${String(data['attempts'])}, rules ${String(data['rulesSha256']).slice(0, 12)})` +
      (warnings.length ? `; check: ${warnings.map((w) => `${String(w['class'])}${w['detail'] ? ` (${String(w['detail'])})` : ''}`).join('; ')}` : ''))
    io.out(outcome.text)
    return 0
  }
  if (code === 10) say(`kept the original (${reason}). Edit it in-session.`)
  else if (code === 11) say(`refused (${reason}${Array.isArray(data['screen']) ? `: ${data['screen'].join(', ')}` : ''}). Edit it in-session.`)
  else if (code === 12) say(`busy (${reason}): try again in about ${Math.round(Number(data['retryAfterMs'] ?? 60_000) / 1000)} s, or edit it in-session.`)
  else say(`failed (${reason}). Edit it in-session.`)
  return code === 0 ? 13 : code as number
}
