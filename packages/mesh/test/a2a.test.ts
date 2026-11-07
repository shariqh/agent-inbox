// The unslop agent's A2A server and process (#483, unslop design §4.2-§4.5,
// §7.2-§7.3, §8.3, U2b) over real loopback HTTP, with an in-process fake
// OpenAI-compatible backend, a scratch mesh dir and fake clocks for the gate.
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSION, startServer } from '../src/a2a.js'
import type { A2AServer, RunResult, ServerOptions } from '../src/a2a.js'
import { GATE_MS, IDLE_MS, main, startAgent } from '../src/agent.js'
import type { Agent, AgentOptions } from '../src/agent.js'
import { maxTokens } from '../src/backend.js'
import { localDate } from '../src/files.js'

const TOKEN = 'a1'.repeat(32)
const API_KEY = 'test-api-key-Zx9'
const CANARY = 'Qv8canary'
const RULES = '# Rules\nCut filler words.\n'
const INPUT = `See https://example.com/docs for v2.5.0. It does not ship today, and it is really very important. ${CANARY} stays.\n`
const EDIT = (text: string): string => text.replace(' really very', '')

type Hold = { release: () => void; promise: Promise<void> }
let backend: Server
let backendUrl: string
let seen: Array<{ headers: IncomingHttpHeaders; closed: Promise<void> }>
let hold: Hold | undefined
const made: string[] = []
const stops: Array<() => Promise<void>> = []

const deferred = (): Hold => {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { release, promise }
}

beforeEach(async () => {
  seen = []
  hold = undefined
  backend = createServer((req, res) => {
    const chunks: Buffer[] = []
    const closed = new Promise<void>((resolve) => res.on('close', () => resolve()))
    seen.push({ headers: req.headers, closed })
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
      const text = /TEXT \w+ BEGIN\n([\s\S]*)\nTEXT \w+ END/.exec(body.messages[1]!.content)![1]!
      await hold?.promise
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: EDIT(text) } }], usage: { completion_tokens: 30 } }))
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
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

const meshJson = (dir: string, endpoint?: string): void =>
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, keep: true, ...(endpoint ? { agents: { unslop: { endpoint, profile: 'unslop' } } } : {}) }))

async function meshHome(profile: Record<string, unknown> = {}): Promise<{ dir: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-agent-'))
  made.push(dir)
  const skill = join(dir, 'skill')
  mkdirSync(skill)
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: unslop\ndescription: x\n---\n')
  writeFileSync(join(skill, 'rules.md'), RULES)
  const port = await freePort()
  meshJson(dir, `http://127.0.0.1:${port}`)
  privateFile(join(dir, 'mesh', 'wrappers', 'unslop.json'), JSON.stringify({ skill, baseUrl: backendUrl, apiKey: { env: 'UNSLOP_TEST_KEY' }, ...profile }))
  privateFile(join(dir, 'mesh', 'tokens', 'unslop'), `${TOKEN}\n`)
  return { dir, port }
}

type Ticks = { ms: number[]; fire: () => void }
async function agent(dir: string, extra: Partial<AgentOptions> = {}): Promise<Agent & { ticks: Ticks }> {
  const fns: Array<() => void> = []
  const ticks: Ticks = { ms: [], fire: () => fns.forEach((fn) => fn()) }
  const a = await startAgent({
    meshDir: dir, profile: 'unslop', env: { UNSLOP_TEST_KEY: API_KEY },
    every: (ms, fn) => { ticks.ms.push(ms); fns.push(fn); return () => fns.splice(fns.indexOf(fn), 1) }, ...extra,
  })
  stops.push(() => a.stop('signal'))
  return { ...a, ticks }
}

type Reply = { status: number; body: any; raw: string }
function http(port: number, opts: { method?: string; path?: string; body?: unknown; headers?: Record<string, string>; onData?: (raw: string) => void } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/', headers: {
      authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json', ...opts.headers,
    } }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { raw += c; opts.onData?.(raw) })
      res.on('end', () => {
        let body: unknown
        try { body = JSON.parse(raw) } catch { body = undefined }
        resolve({ status: res.statusCode ?? 0, body, raw })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const rpc = (port: number, method: string, params: unknown, headers?: Record<string, string>): Promise<Reply> =>
  http(port, { body: { jsonrpc: '2.0', id: 1, method, params }, headers })
const message = (text = INPUT, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }], metadata: { [EXTENSION]: { kind: 'pr', ...meta } } }, ...extra,
})
const immediate = { configuration: { returnImmediately: true } }
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}
async function finished(port: number, id: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const state = (await rpc(port, 'GetTask', { id })).body.result.status.state as string
    if (state !== 'TASK_STATE_SUBMITTED' && state !== 'TASK_STATE_WORKING') return state
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('task did not finish')
}
const settled = async (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))])
const logLines = (dir: string): string => {
  const logs = join(dir, 'mesh', 'logs')
  return readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('')
}

const result = (): RunResult => ({ code: 0, status: 'rewritten', text: 'edited', rulesSha256: '', model: 'm', attempts: 1, hard: {}, warnings: [], ms: { queued: 0, load: 0, model: 5, check: 0 } })
async function server(extra: Partial<ServerOptions>): Promise<A2AServer> {
  const s = await startServer({
    host: '127.0.0.1', port: 0, tokens: [TOKEN], version: '0', rules: () => ({ rulesSha256: '', bytes: 0, loadedAt: '' }),
    run: (_task, onState) => { onState('editing'); return new Promise(() => {}) }, ...extra,
  })
  stops.push(() => s.close())
  return s
}

describe('auth, Host, Origin and the card', () => {
  it('refuses a wrong or missing token, a wrong Host and any Origin before the pipeline', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    const refused = [
      await rpc(port, 'SendMessage', message(), { authorization: `Bearer ${'b2'.repeat(32)}` }),
      await rpc(port, 'SendMessage', message(), { authorization: `Bearer ${TOKEN.slice(1)}` }),
      await rpc(port, 'SendMessage', message(), { authorization: '' }),
      await rpc(port, 'SendMessage', message(), { host: `localhost:${port}` }),
      await rpc(port, 'SendMessage', message(), { host: `127.0.0.1:${port + 1}` }),
      await rpc(port, 'SendMessage', message(), { origin: 'http://127.0.0.1' }),
      await rpc(port, 'SendMessage', message(), { origin: 'null' }),
      await http(port, { method: 'GET', path: '/.well-known/agent-card.json', headers: { origin: 'https://evil.example' } }),
    ]
    expect(refused.map((r) => r.status)).toEqual([401, 401, 401, 403, 403, 403, 403, 403])
    expect(refused.every((r) => r.body?.result === undefined)).toBe(true)
    expect(seen).toHaveLength(0)
    expect(readdirSync(join(dir, 'mesh')).includes('logs')).toBe(false)
  })

  it('serves the card without a token, with the version, interface, skill and extension', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    const { status, body } = await http(port, { method: 'GET', path: '/.well-known/agent-card.json', headers: { authorization: '' } })
    expect(status).toBe(200)
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(body.version).toBe(pkg.version)
    expect(body.supportedInterfaces).toEqual([{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
    expect(body.skills.map((s: { id: string }) => s.id)).toEqual(['unslop'])
    expect(body.capabilities.pushNotifications).toBe(false)
    const [ext] = body.capabilities.extensions
    expect(ext.uri).toBe(EXTENSION)
    expect(ext.params).toEqual({
      api: 1, skillId: 'unslop', rulesSha256: createHash('sha256').update(RULES).digest('hex'), bytes: Buffer.byteLength(RULES),
      loadedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    })
  })

  it('refuses push-notification configs, other versions and oversized bodies', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    const push = await rpc(port, 'SendMessage', message(INPUT, {}, { configuration: { taskPushNotificationConfig: { url: 'http://127.0.0.1:1/' } } }))
    expect(push.body.error.code).toBe(-32003)
    expect((await rpc(port, 'CreateTaskPushNotificationConfig', { taskId: 'x' })).body.error.code).toBe(-32003)
    expect((await rpc(port, 'SendMessage', message(), { 'a2a-version': '0.3' })).body.error.code).toBe(-32009)
    expect((await http(port, { body: 'x'.repeat(65 * 1024) })).status).toBe(413)
    expect(seen).toHaveLength(0)
  })
})

describe('tasks', () => {
  it('completes a task once, streaming status only: the text arrives with COMPLETED', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    hold = deferred()
    let working = ''
    const streamed = http(port, { body: { jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage', params: message() }, onData: (raw) => { working = raw } })
    await until(() => seen.length === 1 && working.includes('editing'))
    expect(working).not.toContain(CANARY)
    hold.release()
    const { raw } = await streamed
    const events = raw.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')).result)
    const first = events.findIndex((e) => JSON.stringify(e).includes(CANARY))
    expect(Object.keys(events[first])).toEqual(['artifactUpdate'])
    expect(events.slice(first + 1)).toEqual([{ statusUpdate: expect.objectContaining({ status: expect.objectContaining({ state: 'TASK_STATE_COMPLETED' }) }) }])
    expect(events[0].task.status.state).toMatch(/SUBMITTED|WORKING/)
    const [text, data] = events[first].artifactUpdate.artifact.parts
    expect(text.text).toBe(EDIT(INPUT))
    expect(data.data).toMatchObject({ code: 0, status: 'rewritten', model: 'chat-long', attempts: 1 })
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`)

    const got = await rpc(port, 'GetTask', { id: events[0].task.id })
    expect(got.body.result.status.state).toBe('TASK_STATE_COMPLETED')
    expect(got.body.result.artifacts[0].parts[0].text).toBe(EDIT(INPUT))
  })

  it('logs one line per task 0600 with sizes and classes, never the text, the token or the key', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    const done = await rpc(port, 'SendMessage', message())
    expect(done.body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    const refused = await rpc(port, 'SendMessage', message(`Hi Jane,\n\n${CANARY} jane@customer.example\n\nThanks,\nSam\n`))
    expect(refused.body.result.task.status.state).toBe('TASK_STATE_REJECTED')
    const file = join(dir, 'mesh', 'logs', `unslop-${localDate(Date.now())}.log`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // a failed check: its values reach the caller's artifact, only its classes the log
    const kept = await rpc(port, 'SendMessage', message(`The note says "it is really very ${CANARY} good" here.\n`))
    const data = kept.body.result.task.artifacts[0].parts[1].data
    expect(data).toMatchObject({ code: 10, reason: 'fidelity', failures: [{ class: 'quotes', kind: 'changed', lost: [`it is really very ${CANARY} good`] }] })
    const lines = logLines(dir).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({ taskId: done.body.result.task.id, bytesIn: Buffer.byteLength(INPUT), code: 0, kind: 'pr' })
    expect(lines[1]).toMatchObject({ code: 11, reason: 'screen' })
    expect(lines[2]).toMatchObject({ code: 10, reason: 'fidelity', failures: [{ class: 'quotes', kind: 'changed' }] })
    for (const secret of [CANARY, 'jane@', 'customer.example', TOKEN, API_KEY, 'example.com/docs']) expect(logLines(dir)).not.toContain(secret)
  })

  it('cancel aborts the backend call; a task id from another token is not found', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    hold = deferred()
    const sent = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    const id = sent.body.result.task.id
    await until(() => seen.length === 1)
    const cancelled = await rpc(port, 'CancelTask', { id })
    expect(cancelled.body.result.status.state).toBe('TASK_STATE_CANCELED')
    await seen[0]!.closed
    expect((await rpc(port, 'GetTask', { id })).body.result.status.state).toBe('TASK_STATE_CANCELED')
    expect((await rpc(port, 'CancelTask', { id })).body.error.code).toBe(-32002)

    const other = 'c3'.repeat(32)
    const server: A2AServer = await startServer({
      host: '127.0.0.1', port: 0, tokens: [TOKEN, other], version: '0', rules: () => ({ rulesSha256: '', bytes: 0, loadedAt: '' }),
      run: (_task, onState) => { onState('editing'); return new Promise(() => {}) },
    })
    stops.push(() => server.close())
    const mine = await rpc(server.port, 'SendMessage', message(INPUT, {}, immediate))
    const theirs = { authorization: `Bearer ${other}` }
    expect((await rpc(server.port, 'GetTask', { id: mine.body.result.task.id }, theirs)).body.error.code).toBe(-32001)
    expect((await rpc(server.port, 'CancelTask', { id: mine.body.result.task.id }, theirs)).body.error.code).toBe(-32001)
    expect((await rpc(server.port, 'GetTask', { id: mine.body.result.task.id })).body.result.status.state).toBe('TASK_STATE_WORKING')
  })
})

describe('queue and budget', () => {
  it('runs one and queues one; a full queue or a wait past the timeout is busy (12) up front', async () => {
    const { dir, port } = await meshHome()
    await agent(dir)
    hold = deferred()
    const est = (maxTokens(INPUT) / 44) * 1000
    const a = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    await until(() => seen.length === 1)
    const tooLong = await rpc(port, 'SendMessage', message(INPUT, { timeoutMs: Math.ceil(est * 1.5) }, immediate))
    expect(tooLong.body.result.task.status).toMatchObject({ state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'busy: wait-too-long' }, { data: { code: 12, reason: 'wait-too-long', retryAfterMs: 60_000 } }] } })
    const b = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    expect(b.body.result.task.status).toMatchObject({ state: 'TASK_STATE_SUBMITTED', message: { parts: [{ text: 'waiting' }] } })
    const full = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    expect(full.body.result.task.status.message.parts[1].data).toMatchObject({ code: 12, reason: 'queue-full' })
    expect(seen).toHaveLength(1)
    hold.release()
    expect(await finished(port, a.body.result.task.id)).toBe('TASK_STATE_COMPLETED')
    expect(await finished(port, b.body.result.task.id)).toBe('TASK_STATE_COMPLETED')
    expect(seen).toHaveLength(2)
    expect((await rpc(port, 'SendMessage', message(INPUT, { timeoutMs: Math.ceil(est * 1.5) }))).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('refuses with REJECTED "daily-budget" once 200 tasks ran today, and counts tasks in a 0600 file', async () => {
    const { dir, port } = await meshHome()
    const file = join(dir, 'mesh', 'unslop-budget.json')
    privateFile(file, JSON.stringify({ date: localDate(Date.now()), tasks: 199, modelMs: 0 }))
    await agent(dir)
    expect((await rpc(port, 'SendMessage', message())).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ tasks: 200 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const over = await rpc(port, 'SendMessage', message())
    expect(over.body.result.task.status).toMatchObject({ state: 'TASK_STATE_REJECTED', message: { parts: [{ text: 'rejected: daily-budget' }, { data: { code: 11 } }] } })
    expect(seen).toHaveLength(1)
  })
})

describe('failures inside the server', () => {
  it('a budget write that throws never leaves a task unfinished or rejects unhandled', async () => {
    const takeFails = await server({ budget: { take: () => { throw new Error('ENOSPC') }, spend: () => {} } })
    expect((await rpc(takeFails.port, 'SendMessage', message())).body.result.task.status.message.parts[1].data).toMatchObject({ code: 11, reason: 'budget-unavailable' })

    let calls = 0
    const spendFails = await server({ budget: { take: () => true, spend: () => { throw new Error('ENOSPC') } }, run: async () => {
      calls++
      const r = result()
      // the second task's result throws when read: the task still ends FAILED
      if (calls === 2) Object.defineProperty(r, 'warnings', { enumerable: true, get: () => { throw new Error('boom') } })
      return r
    } })
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => rpc(spendFails.port, 'SendMessage', message())))
    expect(a!.body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(b!.body.result.task.status).toMatchObject({ state: 'TASK_STATE_FAILED', message: { parts: [{ text: 'failed: internal' }, {}] } })
    expect(c!.body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('logs a never-started task once when the agent stops', async () => {
    const { dir, port } = await meshHome()
    const a = await agent(dir)
    hold = deferred()
    await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    await until(() => seen.length === 1)
    const waiting = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    await a.stop('signal')
    await until(() => logLines(dir).trim().split('\n').length === 2)
    const lines = logLines(dir).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.find((l) => l.taskId === waiting.body.result.task.id)).toMatchObject({ code: 13, status: 'failed', reason: 'agent-stopped' })
    expect(lines.find((l) => l.taskId !== waiting.body.result.task.id)).toMatchObject({ code: 13, reason: 'cancelled' })
  })
})

describe('start, the mesh.json gate and idle exit', () => {
  it('refuses to bind anything but 127.0.0.1, and a non-loopback endpoint', async () => {
    await expect(startServer({ host: '0.0.0.0', port: 0, tokens: [TOKEN], version: '0', rules: () => ({ rulesSha256: '', bytes: 0, loadedAt: '' }), run: () => new Promise(() => {}) }))
      .rejects.toThrow(/127\.0\.0\.1 only/)
    const { dir, port } = await meshHome()
    for (const endpoint of ['http://127.0.0.1:80', `http://0.0.0.0:${port}`, `http://localhost:${port}`, `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}/x`]) {
      meshJson(dir, endpoint)
      await expect(agent(dir)).rejects.toThrow(/must be http:\/\/127\.0\.0\.1:<port>/)
    }
  })

  it('refuses to start without the key, then exits within one stat interval after it goes', async () => {
    const { dir, port } = await meshHome()
    meshJson(dir)
    await expect(agent(dir)).rejects.toThrow(/no agents\.unslop/)
    rmSync(join(dir, 'mesh.json'))
    await expect(agent(dir)).rejects.toThrow(/mesh\.json is missing/)

    meshJson(dir, `http://127.0.0.1:${port}`)
    const a = await agent(dir)
    expect(a.ticks.ms).toEqual([GATE_MS])
    expect(GATE_MS).toBeLessThanOrEqual(60_000)
    a.ticks.fire()
    expect(await settled(a.exited)).toBe(false)
    meshJson(dir)
    a.ticks.fire()
    expect(await a.exited).toBe('mesh.json')
    await expect(http(port, { method: 'GET', path: '/.well-known/agent-card.json' })).rejects.toThrow()
  })

  it('exits within one stat interval when the caller token changes or goes', async () => {
    for (const change of ['rewrite', 'remove'] as const) {
      const { dir, port } = await meshHome()
      const a = await agent(dir)
      const token = join(dir, 'mesh', 'tokens', 'unslop')
      privateFile(token, `${TOKEN}\n`) // the same token rewritten keeps it running
      a.ticks.fire()
      expect(await settled(a.exited)).toBe(false)
      if (change === 'rewrite') privateFile(token, `${'c3'.repeat(32)}\n`)
      else rmSync(token)
      a.ticks.fire()
      expect(await a.exited, change).toBe('token')
      await expect(http(port, { method: 'GET', path: '/.well-known/agent-card.json' })).rejects.toThrow()
    }
  })

  it('exits after 30 idle minutes (fake clock), not while a task runs', async () => {
    const { dir, port } = await meshHome()
    const clock = { t: Date.now() }
    const a = await agent(dir, { now: () => clock.t })
    hold = deferred()
    const sent = await rpc(port, 'SendMessage', message(INPUT, {}, immediate))
    await until(() => seen.length === 1)
    clock.t += IDLE_MS
    a.ticks.fire()
    expect(await settled(a.exited)).toBe(false)
    hold.release()
    expect(await finished(port, sent.body.result.task.id)).toBe('TASK_STATE_COMPLETED')
    clock.t += IDLE_MS - 60_000
    a.ticks.fire()
    expect(await settled(a.exited)).toBe(false)
    clock.t += 60_000
    a.ticks.fire()
    expect(await a.exited).toBe('idle')
  })

  it('refuses a profile, token or deny list that is not 0600 or is a symlink', async () => {
    const { dir } = await meshHome()
    const profile = join(dir, 'mesh', 'wrappers', 'unslop.json')
    const token = join(dir, 'mesh', 'tokens', 'unslop')
    chmodSync(profile, 0o644)
    await expect(agent(dir)).rejects.toThrow(/unslop\.json must be mode 0600/)
    chmodSync(profile, 0o600)
    rmSync(token)
    privateFile(join(dir, 'real-token'), TOKEN)
    symlinkSync(join(dir, 'real-token'), token)
    await expect(agent(dir)).rejects.toThrow(/unslop is a symlink/)
    rmSync(token)
    privateFile(token, TOKEN)
    privateFile(join(dir, 'mesh', 'unslop-deny.txt'), 'Acme\n', 0o640)
    await expect(agent(dir)).rejects.toThrow(/unslop-deny\.txt must be mode 0600/)
  })

  it('never prints an API key from a malformed profile, and wants an absolute key file', async () => {
    const { dir } = await meshHome({ apiKey: 'sk-live-SECRETKEY123' })
    let stderr = ''
    expect(await main(['--agent', 'openai-compatible', '--profile', 'unslop'], { AGENT_INBOX_MESH_DIR: dir }, (t) => { stderr += t })).toBe(1)
    expect(stderr).toMatch(/apiKey must be/)
    expect(stderr).not.toContain('SECRETKEY')

    const relative = await meshHome({ apiKey: { file: 'keys/box' } })
    await expect(agent(relative.dir)).rejects.toThrow(/apiKey must be .*file: absolute path/)
  })

  it('runs an API key command with a fixed argv and no shell', async () => {
    const { dir, port } = await meshHome({ apiKey: { command: [process.execPath, '-e', 'process.stdout.write("cmd-key-1")'] } })
    await agent(dir)
    expect((await rpc(port, 'SendMessage', message())).body.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(seen[0]!.headers.authorization).toBe('Bearer cmd-key-1')
  })
})
