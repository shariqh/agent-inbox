// unslop-code as an agent (step 3a): the A2A server with the unslop-code skill and the
// agent process started with `--profile unslop-code`, over real loopback HTTP against an
// in-process fake OpenAI-compatible backend, in scratch mesh and home folders. No model.
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main, startAgent } from '../src/agent.js'
import type { Agent } from '../src/agent.js'
import { QUESTIONS } from '../src/code-prompt.js'
import type { Question } from '../src/code-prompt.js'
import { localDate } from '../src/files.js'
import { CODE_EXTENSION, CODE_FILE_MS, ESTIMATE_MAX_MS } from '../src/skills.js'

const TOKEN = 'e5'.repeat(32)
const UNSLOP_TOKEN = 'd4'.repeat(32)
const API_KEY = 'code-test-key-Q7'
const HOOKS = fileURLToPath(new URL('./ts-hooks.mjs', import.meta.url))
const WRAP = fileURLToPath(new URL('../src/wrap.ts', import.meta.url))

const lines = (...l: string[]): string => `${l.join('\n')}\n`
const A = lines(
  '// Parses the retry header, in seconds.',
  'export function retryAfter(value: string): number {',
  '  // Convert the value to a number',
  '  const n = Number(value)',
  '  // a date instead of seconds is not supported: the server never sends one',
  '  return Number.isFinite(n) ? n : 0',
  '}',
)
const B = lines(
  'export function total(rows) {',
  '  let sum = 0',
  '  // Loop through the rows',
  '  for (const row of rows) sum += row.size',
  '  // Return the sum',
  '  return sum',
  '}',
)
const fileA = { path: 'src/retry.ts', text: A, added: [1, 2, 3, 4, 5, 6, 7] }
const fileB = { path: 'lib/total.js', text: B, added: [3, 4, 5, 6] }
const ANSWERS: Array<[string, Partial<Record<Question, string>>]> = [
  ['retryAfter', { remove: '{"remove":[3]}', keep: '{"keep":[1,5]}', suggest: '{"suggest":[{"line":6,"kind":"defensive"}]}' }],
  ['total(rows)', { remove: '{"remove":[3,5]}', keep: '{"keep":[]}' }],
]

type Hold = { release: () => void; promise: Promise<void> }
let backend: Server
let backendUrl: string
let seen: Array<{ headers: IncomingHttpHeaders; question: Question; closed: Promise<void> }>
let hold: Hold | undefined
let mode: 'ok' | 'busy' | 'fail'
const made: string[] = []
const stops: Array<() => Promise<void>> = []

const deferred = (): Hold => {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { release, promise }
}
const questionOf = (system: string): Question => (Object.keys(QUESTIONS) as Question[]).find((q) => system.endsWith(QUESTIONS[q]))!

beforeEach(async () => {
  seen = []
  hold = undefined
  mode = 'ok'
  backend = createServer((req, res) => {
    const chunks: Buffer[] = []
    const closed = new Promise<void>((resolve) => res.on('close', () => resolve()))
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
      const question = questionOf(body.messages[0]!.content)
      seen.push({ headers: req.headers, question, closed })
      await hold?.promise
      if (mode !== 'ok') return void res.writeHead(mode === 'busy' ? 503 : 401).end()
      const answers = ANSWERS.find(([needle]) => body.messages[1]!.content.includes(needle))?.[1] ?? {}
      const content = answers[question] ?? (question === 'suggest' ? '{"suggest":[]}' : `{"${question}":[]}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { completion_tokens: 12 } }))
    })
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
})

afterEach(async () => {
  hold?.release()
  for (const stop of stops.splice(0)) await stop()
  backend.closeAllConnections()
  await new Promise<void>((resolve) => backend.close(() => resolve()))
  vi.unstubAllEnvs()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

function privateFile(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

const meshJson = (dir: string, agents: Record<string, number>): void =>
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({
    schema: 1, keep: true, agents: Object.fromEntries(Object.entries(agents).map(([name, port]) => [name, { endpoint: `http://127.0.0.1:${port}`, profile: name }])),
  }))

/** unslop's own files, each one it would refuse or stop on, so an agent that read them would fail */
const TRAPS: Record<string, { text: string; mode: number }> = {
  'mesh/wrappers/unslop.json': { text: '{ not json', mode: 0o644 },
  'mesh/tokens/unslop': { text: `${UNSLOP_TOKEN}\n`, mode: 0o600 },
  'mesh/unslop-deny.txt': { text: 'Acme\n', mode: 0o640 },
  'mesh/unslop-budget.json': { text: JSON.stringify({ date: localDate(Date.now()), tasks: 200, modelMs: 0 }), mode: 0o600 },
}

/** A scratch mesh dir with both agents switched on, unslop-code's files, and unslop's as traps. HOME is pinned to it. */
async function codeHome(profile: Record<string, unknown> = {}): Promise<{ dir: string; port: number; unslopPort: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-code-agent-'))
  made.push(dir)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('AGENT_INBOX_MESH_DIR', dir)
  const [port, unslopPort] = [await freePort(), await freePort()]
  meshJson(dir, { unslop: unslopPort, 'unslop-code': port })
  privateFile(join(dir, 'mesh', 'wrappers', 'unslop-code.json'), JSON.stringify({
    _about: 'unslop-code profile', start: ['/usr/bin/false'], baseUrl: backendUrl, apiKey: { env: 'CODE_TEST_KEY' }, ...profile,
  }))
  privateFile(join(dir, 'mesh', 'tokens', 'unslop-code'), `${TOKEN}\n`)
  for (const [path, trap] of Object.entries(TRAPS)) privateFile(join(dir, path), trap.text, trap.mode)
  return { dir, port, unslopPort }
}

type Ticks = { fire: () => void }
async function agent(dir: string): Promise<Agent & { ticks: Ticks }> {
  const fns: Array<() => void> = []
  const a = await startAgent({
    meshDir: dir, profile: 'unslop-code', env: { CODE_TEST_KEY: API_KEY, HOME: dir, AGENT_INBOX_MESH_DIR: dir },
    every: (_ms, fn) => { fns.push(fn); return () => fns.splice(fns.indexOf(fn), 1) },
  })
  stops.push(() => a.stop('signal'))
  return { ...a, ticks: { fire: () => fns.forEach((fn) => fn()) } }
}

type Reply = { status: number; body: any; raw: string; headers: IncomingHttpHeaders }
function http(port: number, opts: { method?: string; path?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/', headers: {
      authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json', ...opts.headers,
    } }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { raw += c })
      res.on('end', () => {
        let body: unknown
        try { body = JSON.parse(raw) } catch { body = undefined }
        resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const rpc = (port: number, method: string, params: unknown, headers?: Record<string, string>): Promise<Reply> =>
  http(port, { body: { jsonrpc: '2.0', id: 1, method, params }, headers })
const message = (data: unknown, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, parts?: unknown[]): Record<string, unknown> => ({
  message: { messageId: 'm1', role: 'ROLE_USER', parts: parts ?? [{ data, mediaType: 'application/json' }], metadata: { [CODE_EXTENSION]: meta } }, ...extra,
})
const immediate = { configuration: { returnImmediately: true } }
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}
async function finished(port: number, id: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const task = (await rpc(port, 'GetTask', { id })).body.result
    if (task.status.state !== 'TASK_STATE_SUBMITTED' && task.status.state !== 'TASK_STATE_WORKING') return task
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('task did not finish')
}
const settled = async (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))])
const logText = (dir: string): string => {
  const logs = join(dir, 'mesh', 'logs')
  return readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('')
}
const tree = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[]).filter((p) => statSync(join(dir, p)).isFile()).map((p) => relative(dir, join(dir, p))).sort()
const card = (port: number, headers: Record<string, string> = {}): Promise<Reply> =>
  http(port, { method: 'GET', path: '/.well-known/agent-card.json', headers: { authorization: '', ...headers } })

describe('the unslop-code card and proof', () => {
  it('serves its own card: name, skill, extension with no rules, and its input and output modes', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    const { status, body } = await card(port)
    expect(status).toBe(200)
    expect(CODE_EXTENSION).toBe('urn:agent-inbox:ext:unslop-code:v1')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(body).toEqual({
      name: 'unslop-code', description: expect.any(String), version: pkg.version,
      supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false, extensions: [{ uri: CODE_EXTENSION, description: expect.any(String), required: false, params: { api: 1, skillId: 'unslop-code' } }] },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ['application/json'], defaultOutputModes: ['text/x-diff', 'application/json'],
      skills: [{ id: 'unslop-code', name: 'unslop-code', description: expect.any(String), tags: ['code'] }],
    })
  })

  it('answers an identity challenge under the label unslop-code/v1, never unslop/v1', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    const nonce = 'n0'.repeat(21) + 'x'
    const mac = (label: string): string => createHmac('sha256', TOKEN).update(`${label}\n${nonce}`).digest('base64url')
    const challenged = await card(port, { 'a2a-mesh-challenge': nonce })
    expect(challenged.headers['a2a-mesh-proof']).toBe(mac('unslop-code/v1'))
    expect(challenged.headers['a2a-mesh-proof']).not.toBe(mac('unslop/v1'))
    expect(challenged.raw).toBe((await card(port)).raw)
    expect((await card(port, { 'a2a-mesh-challenge': 'short' })).headers['a2a-mesh-proof']).toBeUndefined()
  })
})

describe('unslop-code tasks', () => {
  it('cleans two files: the artifact holds a patch git apply accepts and the report without it', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    const done = await rpc(port, 'SendMessage', message({ files: [fileA, fileB] }))
    const task = done.body.result.task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    const [artifact] = task.artifacts
    expect(artifact.name).toBe('unslop-code')
    const [patch, report] = artifact.parts
    expect(patch.mediaType).toBe('text/x-diff')
    expect(report.mediaType).toBe('application/json')
    expect(report.data).toMatchObject({ code: 0, status: 'cleaned', model: 'coder-next', calls: 6 })
    expect(Object.keys(report.data)).not.toContain('patch')
    expect(report.data.files).toEqual([
      { path: 'src/retry.ts', status: 'cleaned', removed: [3], dropped: [], suggestions: [{ line: 6, kind: 'defensive' }] },
      { path: 'lib/total.js', status: 'cleaned', removed: [3, 5], dropped: [], suggestions: [] },
    ])
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`)

    const repo = mkdtempSync(join(tmpdir(), 'mesh-code-apply-'))
    made.push(repo)
    const git = (...args: string[]): ReturnType<typeof spawnSync> => spawnSync('git', args, { cwd: repo, encoding: 'utf8', input: patch.text })
    git('init', '-q')
    for (const f of [fileA, fileB]) privateFile(join(repo, f.path), f.text)
    expect(git('apply', '--check', '-').status).toBe(0)
    expect(git('apply', '-').status).toBe(0)
    expect(readFileSync(join(repo, fileA.path), 'utf8')).toBe(A.replace('  // Convert the value to a number\n', ''))
    expect(readFileSync(join(repo, fileB.path), 'utf8')).toBe(B.replace('  // Loop through the rows\n', '').replace('  // Return the sum\n', ''))

    // nothing to remove: still COMPLETED, with an empty patch part
    const clean = await rpc(port, 'SendMessage', message({ files: [{ path: 'c.ts', text: lines('export const c = 1'), added: [1] }], suggest: false }))
    expect(clean.body.result.task.artifacts[0].parts[0]).toEqual({ text: '', mediaType: 'text/x-diff' })
    expect(clean.body.result.task.artifacts[0].parts[1].data).toMatchObject({ code: 0, status: 'unchanged' })

    // the log: one line per task, counts and sizes, never a path, a line of code, the token or the key
    const file = join(dir, 'mesh', 'logs', `unslop-code-${localDate(Date.now())}.log`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const logged = logText(dir)
    expect(logged.trim().split('\n').map((l) => JSON.parse(l))[0]).toMatchObject({ taskId: task.id, code: 0, status: 'cleaned', calls: 6, files: [{ bytes: Buffer.byteLength(A), added: 7, removed: 1 }, { removed: 2 }] })
    for (const secret of ['retry', 'total', 'Convert the value', 'Loop through', 'c.ts', 'export const', TOKEN, API_KEY]) expect(logged).not.toContain(secret)
  })

  it('refuses each malformed message: the envelope as -32602, a wrong data shape as REJECTED 11; nothing reaches the backend', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    const envelopes = [
      message(undefined, {}, {}, [{ text: JSON.stringify({ files: [fileA] }) }]),
      message(undefined, {}, {}, [{ text: 'x', data: { files: [fileA] } }]),
      message(undefined, {}, {}, [{ data: { files: [fileA] } }, { data: { files: [fileB] } }]),
      message(undefined, {}, {}, []),
      message(undefined, {}, {}, [{ mediaType: 'application/json' }]),
      { message: { messageId: 'm1', role: 'ROLE_AGENT', parts: [{ data: { files: [fileA] } }] } },
      message({ files: [fileA] }, { timeoutMs: 5 }),
      message({ files: [fileA] }, { timeoutMs: '60000' }),
    ]
    for (const params of envelopes) {
      const r = await rpc(port, 'SendMessage', params)
      expect(r.body.error?.code, JSON.stringify(params)).toBe(-32602)
    }
    const shapes: unknown[] = [
      null, [], 'files', {}, { files: 'x' }, { files: {} }, { files: [null] }, { files: [[]] },
      { files: [{ ...fileA, path: 7 }] }, { files: [{ path: 'a.ts', added: [1] }] }, { files: [{ ...fileA, text: [A] }] },
      { files: [{ ...fileA, added: '1' }] }, { files: [{ ...fileA, added: [1.5] }] }, { files: [{ ...fileA, added: ['3'] }] },
      { files: [{ ...fileA, added: [null] }] }, { files: [{ ...fileA, added: [2 ** 53] }] }, { files: [{ ...fileA, added: [Number.NaN] }] },
      { files: [fileA], suggest: 'yes' }, { files: [fileA], suggest: null },
    ]
    for (const data of shapes) {
      const r = await rpc(port, 'SendMessage', message(data))
      expect(r.body.result.task.status, JSON.stringify(data)).toMatchObject({
        state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'rejected: malformed' }, { data: { code: 11, status: 'rejected', reason: 'malformed' } }] },
      })
    }
    expect(seen).toHaveLength(0)
    // a refusal takes no budget: the budget file was never written
    expect(readdirSync(join(dir, 'mesh'))).not.toContain('unslop-code-budget.json')
    expect(logText(dir).trim().split('\n')).toHaveLength(shapes.length)
    expect(logText(dir)).not.toContain('retry')
  })

  it('reads a body over unslop\'s 64 KiB, refuses one over 4 MiB', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    expect((await http(port, { body: 'x'.repeat(4 * 1024 * 1024 + 1) })).status).toBe(413)
    const big = await rpc(port, 'SendMessage', message({ files: [{ path: 'big.ts', text: `// ${'x'.repeat(1024 * 1024)}\n`, added: [1] }] }))
    expect(big.body.result.task.status.message.parts[1].data).toMatchObject({ code: 11, reason: 'all-skipped', files: [{ path: 'big.ts', status: 'skipped', reason: 'size' }] })
    expect(seen).toHaveLength(0)
  })

  it('estimates twelve seconds a file for the queue, capped at the task limit', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    expect(CODE_FILE_MS).toBe(12_000)
    // 40 files would be 480 s; the estimate's own cap of 270 s (ESTIMATE_MAX_MS, below the task
    // limit of 600 s) fits the default 280 s
    expect(ESTIMATE_MAX_MS).toBe(270_000)
    const many = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, text: 'export const x = 1\n', added: [] }))
    const capped = await rpc(port, 'SendMessage', message({ files: many }))
    expect(capped.body.result.task.status.message.parts[1].data).toMatchObject({ code: 11, reason: 'all-skipped' })

    hold = deferred()
    const running = await rpc(port, 'SendMessage', message({ files: [fileA] }, {}, immediate))
    await until(() => seen.length === 1)
    const three = { files: [fileA, fileB, fileA] }
    // 12 s left of the running file plus 36 s for three does not fit 40 s, does fit 50 s
    const tooLong = await rpc(port, 'SendMessage', message(three, { timeoutMs: 40_000 }, immediate))
    expect(tooLong.body.result.task.status.message.parts[1].data).toMatchObject({ code: 12, reason: 'wait-too-long', retryAfterMs: 60_000 })
    const queued = await rpc(port, 'SendMessage', message(three, { timeoutMs: 50_000 }, immediate))
    expect(queued.body.result.task.status.state).toBe('TASK_STATE_SUBMITTED')
    hold.release()
    expect((await finished(port, running.body.result.task.id)).status.state).toBe('TASK_STATE_COMPLETED')
    expect((await finished(port, queued.body.result.task.id)).status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('a busy backend is REJECTED 12 with retryAfterMs, a failing one FAILED 13; neither carries a patch', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    mode = 'busy'
    const busy = (await rpc(port, 'SendMessage', message({ files: [fileA] }))).body.result.task
    expect(busy.status).toMatchObject({ state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'busy: backend-5xx' }, { data: { code: 12, status: 'busy', reason: 'backend-5xx', retryAfterMs: 60_000 } }] } })
    expect(busy.artifacts).toBeUndefined()
    expect(Object.keys(busy.status.message.parts[1].data)).not.toContain('patch')
    mode = 'fail'
    const failed = (await rpc(port, 'SendMessage', message({ files: [fileA] }))).body.result.task
    expect(failed.status).toMatchObject({ state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'failed: backend-http-401' }, { data: { code: 13, status: 'failed', reason: 'backend-http-401' } }] } })
    expect(failed.artifacts).toBeUndefined()
  })

  it('cancel aborts the backend call', async () => {
    const { dir, port } = await codeHome()
    await agent(dir)
    hold = deferred()
    const sent = await rpc(port, 'SendMessage', message({ files: [fileA] }, {}, immediate))
    const id = sent.body.result.task.id
    await until(() => seen.length === 1)
    expect((await rpc(port, 'CancelTask', { id })).body.result.status.state).toBe('TASK_STATE_CANCELED')
    await seen[0]!.closed
    expect((await rpc(port, 'GetTask', { id })).body.result.status.state).toBe('TASK_STATE_CANCELED')
    expect((await rpc(port, 'CancelTask', { id })).body.error.code).toBe(-32002)
  })
})

describe('the unslop-code agent process', () => {
  it('uses its own endpoint, token, budget and log, and never reads or writes unslop\'s files', async () => {
    const { dir, port, unslopPort } = await codeHome()
    const before = tree(dir)
    const a = await agent(dir)
    expect(a.port).toBe(port)
    expect(a.port).not.toBe(unslopPort)
    // unslop's token is not accepted
    expect((await rpc(port, 'GetTask', { id: 'x' }, { authorization: `Bearer ${UNSLOP_TOKEN}` })).status).toBe(401)
    // unslop's budget is spent for the day; this agent's is its own
    expect((await rpc(port, 'SendMessage', message({ files: [fileA] }))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    const day = localDate(Date.now())
    expect(tree(dir)).toEqual([...before, 'mesh/unslop-code-budget.json', `mesh/logs/unslop-code-${day}.log`].sort())
    expect(JSON.parse(readFileSync(join(dir, 'mesh', 'unslop-code-budget.json'), 'utf8'))).toMatchObject({ date: day, tasks: 1 })
    expect(statSync(join(dir, 'mesh', 'unslop-code-budget.json')).mode & 0o777).toBe(0o600)
    for (const [path, trap] of Object.entries(TRAPS)) {
      expect(readFileSync(join(dir, path), 'utf8'), path).toBe(trap.text)
      expect(statSync(join(dir, path)).mode & 0o777, path).toBe(trap.mode)
    }
  })

  it('refuses daily-budget at 200 tasks of its own budget file', async () => {
    const { dir, port } = await codeHome()
    privateFile(join(dir, 'mesh', 'unslop-code-budget.json'), JSON.stringify({ date: localDate(Date.now()), tasks: 200, modelMs: 0 }))
    await agent(dir)
    expect((await rpc(port, 'SendMessage', message({ files: [fileA] }))).body.result.task.status.message.parts[0].text).toBe('rejected: daily-budget')
    expect(seen).toHaveLength(0)
  })

  it('stops when agents.unslop-code goes or its token changes, not when unslop\'s do', async () => {
    for (const change of ['mesh.json', 'token'] as const) {
      const { dir, port } = await codeHome()
      const a = await agent(dir)
      privateFile(join(dir, 'mesh', 'tokens', 'unslop'), `${'f6'.repeat(32)}\n`)
      meshJson(dir, { unslop: await freePort(), 'unslop-code': port })
      a.ticks.fire()
      expect(await settled(a.exited)).toBe(false)
      if (change === 'mesh.json') meshJson(dir, { unslop: port + 1 })
      else privateFile(join(dir, 'mesh', 'tokens', 'unslop-code'), `${'c3'.repeat(32)}\n`)
      a.ticks.fire()
      expect(await a.exited, change).toBe(change)
    }
  })

  it('names agents.unslop-code in its refusals and needs only a baseUrl in its profile', async () => {
    const { dir } = await codeHome()
    meshJson(dir, { unslop: await freePort() })
    await expect(agent(dir)).rejects.toThrow('mesh.json has no agents.unslop-code: run meshctl enable --unslop-code')
    writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'unslop-code': { endpoint: 'http://localhost:4421' } } }))
    await expect(agent(dir)).rejects.toThrow('agents.unslop-code.endpoint must be http://127.0.0.1:<port>')

    const noUrl = await codeHome({ baseUrl: undefined })
    await expect(agent(noUrl.dir)).rejects.toThrow(/needs a `baseUrl`/)
    const open = await codeHome()
    chmodSync(join(open.dir, 'mesh', 'wrappers', 'unslop-code.json'), 0o644)
    await expect(agent(open.dir)).rejects.toThrow(/unslop-code\.json must be mode 0600/)
  })

  it('main: an unknown profile is a usage error; a missing switch names unslop-code', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mesh-code-main-'))
    made.push(empty)
    const env = { AGENT_INBOX_MESH_DIR: empty, HOME: empty }
    for (const profile of ['bogus', 'constructor', '__proto__', 'web-search']) {
      let out = ''
      expect(await main(['--agent', 'openai-compatible', '--profile', profile], env, (t) => { out += t }), profile).toBe(4)
      expect(out).toBe('usage: agent-inbox-wrap --agent openai-compatible --profile unslop|unslop-code\n')
    }
    let out = ''
    expect(await main(['--agent', 'openai-compatible', '--profile', 'unslop-code'], env, (t) => { out += t })).toBe(1)
    expect(out).toBe('agent-inbox-wrap: mesh.json is missing or unreadable: run meshctl enable --unslop-code\n')
  })

  it('wrap.js runs either agent by --profile, as its own process, and stops on SIGTERM', async () => {
    const { dir, port } = await codeHome()
    const skill = join(dir, 'skill')
    mkdirSync(skill)
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: unslop\ndescription: x\n---\n')
    writeFileSync(join(skill, 'rules.md'), '# Rules\n')
    const unslopPort = await freePort()
    meshJson(dir, { unslop: unslopPort, 'unslop-code': port })
    for (const path of Object.keys(TRAPS)) rmSync(join(dir, path))
    privateFile(join(dir, 'mesh', 'wrappers', 'unslop.json'), JSON.stringify({ skill, baseUrl: backendUrl }))
    privateFile(join(dir, 'mesh', 'tokens', 'unslop'), `${UNSLOP_TOKEN}\n`)

    const env = { ...process.env, HOME: dir, AGENT_INBOX_MESH_DIR: dir, CODE_TEST_KEY: API_KEY, LOAD_SPY: '1' }
    const children = (['unslop-code', 'unslop'] as const).map((profile) => {
      const child = spawn(process.execPath, ['--import', HOOKS, WRAP, '--agent', 'openai-compatible', '--profile', profile], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr!.setEncoding('utf8').on('data', (c: string) => { stderr += c })
      const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
      stops.push(async () => { child.kill('SIGKILL'); await exit })
      return { profile, child, exit, err: () => stderr }
    })
    for (const c of children) await until(() => c.err().includes('listening on'))
    const [code, unslop] = children
    expect(code!.err()).toBe(`agent-inbox-wrap: unslop-code listening on http://127.0.0.1:${port}\n`)
    expect(unslop!.err()).toBe(`agent-inbox-wrap: unslop listening on http://127.0.0.1:${unslopPort}\n`)
    expect((await card(port)).body.name).toBe('unslop-code')
    expect((await card(unslopPort)).body.name).toBe('unslop')
    for (const c of children) {
      c.child.kill('SIGTERM')
      expect(await c.exit, c.profile).toBe(0)
      expect(c.err()).toMatch(/stopped \(signal\)\n$/)
      expect(c.err()).not.toContain('load-spy')
    }
  }, 60_000)
})
