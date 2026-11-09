// The web search agent's W1 spike (web search design §3, §4.1, §10.1, §13 W1):
// `@a2a-js/sdk` behind our own front door, over real loopback HTTP. The SDK's own
// client (through identityFetch) and a minimal Node-core client both drive the
// four methods; every allowlist, Origin, Host, token and version refusal is sent
// through the real server and checked never to reach the SDK; the identity
// challenge keeps the token from a squatter; and a canary query never reaches
// stderr or a log, even when a stage throws from a timer.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Role, TaskState } from '@a2a-js/sdk'
import type { SendMessageRequest } from '@a2a-js/sdk'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import type { Client } from '@a2a-js/sdk/client'
import { JsonRpcTransportHandler } from '@a2a-js/sdk/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { CARD_PATH, IdentityError, cardHash, identityFetch, proofFor, resolveCard } from '../src/a2a-client.js'
import { GATE_MS, IDLE_MS, card, createExecutor, fixtureRun, main, startAgent } from '../src/web-search/agent.js'
import type { Agent, Run } from '../src/web-search/agent.js'
import { EXTENSION, rebuild, startFrontDoor } from '../src/web-search/front-door.js'
import type { FrontDoor } from '../src/web-search/front-door.js'

const TOKEN = 'w5'.repeat(20)
const OTHER = 'x7'.repeat(20)
const HOOKS = fileURLToPath(new URL('./ts-hooks.mjs', import.meta.url))
const WRAP = fileURLToPath(new URL('../src/wrap.ts', import.meta.url))
const CHILD = fileURLToPath(new URL('./web-search-canary-child.ts', import.meta.url))
type Json = Record<string, any>

const made: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
let handle: MockInstance

beforeEach(() => {
  handle = vi.spyOn(JsonRpcTransportHandler.prototype, 'handle')
})
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type Hold = { release: () => void; promise: Promise<void> }
const deferred = (): Hold => {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { release, promise }
}

async function door(run: Run = fixtureRun): Promise<FrontDoor & { log: Json[] }> {
  const log: Json[] = []
  const executor = createExecutor(run, (entry) => log.push(entry))
  const d = await startFrontDoor({ port: 0, tokens: [TOKEN, OTHER], card: (url) => card(url, '0.0.0-test'), executor, busy: () => executor.open() > 0 })
  cleanups.push(() => d.close())
  return { ...d, log }
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { server, port, url: `http://127.0.0.1:${port}/` }
}

// The minimal Node-core client.
type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
type CallOptions = { method?: string; path?: string; headers?: Record<string, string | undefined>; body?: string; onEvent?: (event: Json) => void }
function call(port: number, o: CallOptions = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  const all = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json', ...o.headers }
  for (const [k, v] of Object.entries(all)) if (v !== undefined) headers[k] = v
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/', headers }, (res) => {
      let body = ''
      let seen = 0
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        body += c
        const done = body.split('\n\n').slice(0, -1)
        for (const chunk of done.slice(seen)) o.onEvent?.(JSON.parse(chunk.replace(/^data: /, '')) as Json)
        seen = done.length
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(o.body)
  })
}
const envelope = (method: string, params: unknown, id: unknown = 1): string => JSON.stringify({ jsonrpc: '2.0', id, method, params })
async function rpc(port: number, method: string, params: unknown, headers: Record<string, string | undefined> = {}): Promise<Json> {
  return JSON.parse((await call(port, { headers, body: envelope(method, params) })).body) as Json
}
const events = (body: string): Json[] => body.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as Json)
const ask = (text: string, extra: Json = {}): Json => ({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra } })
async function coreCard(port: number, token = TOKEN): Promise<Json> {
  const nonce = randomBytes(32).toString('base64url')
  const res = await call(port, { method: 'GET', path: CARD_PATH, headers: { authorization: undefined, 'a2a-mesh-challenge': nonce } })
  if (res.headers['a2a-mesh-proof'] !== proofFor(token, nonce)) throw new Error('no identity proof')
  return JSON.parse(res.body) as Json
}

const sdkMessage = (text: string): SendMessageRequest => ({
  tenant: '', configuration: undefined, metadata: undefined,
  message: { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [], referenceTaskIds: [] },
})
function sdkClient(endpoint: string, sent: string[] = []): Promise<Client> {
  const f = identityFetch({ token: TOKEN, endpoint })
  const spy: typeof fetch = (input, init) => {
    if (typeof init?.body === 'string') sent.push(init.body)
    return f(input, init)
  }
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, { transports: [new JsonRpcTransportFactory({ fetchImpl: spy })], cardResolver: new DefaultAgentCardResolver({ fetchImpl: spy }) })
  return new ClientFactory(options).createFromUrl(endpoint)
}

describe('the card (§4.1)', () => {
  it('declares one skill, the extension, streaming without push, the bearer scheme, and nothing per copy', async () => {
    const d = await door()
    const res = await call(d.port, { method: 'GET', path: CARD_PATH, headers: { authorization: undefined } })
    expect(res.status).toBe(200)
    const c = JSON.parse(res.body) as Json
    expect(c).toEqual(card(d.url, '0.0.0-test'))
    expect(c.supportedInterfaces).toEqual([{ url: d.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
    expect(c.capabilities).toMatchObject({ streaming: true, pushNotifications: false })
    expect(c.capabilities.extensions[0]).toMatchObject({ uri: EXTENSION, params: { api: 1, modes: ['answer', 'sources'], maxSources: 10, maxQueryChars: 400, maxSites: 5, maxExcludeSites: 10 } })
    expect(c.skills).toEqual([{ id: 'web-search', name: 'web-search', description: expect.any(String), tags: ['search', 'web'] }])
    expect(res.body).not.toMatch(/synthesis|provider|model|kagi/i)
    expect(handle).not.toHaveBeenCalled()
  })

  it('hashes without the interface URL, so copies of one version hash the same', () => {
    const a = cardHash(card('http://127.0.0.1:4421/', '1.0.0'))
    expect(cardHash(card('http://127.0.0.1:5555/', '1.0.0'))).toBe(a)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(cardHash(card('http://127.0.0.1:4421/', '1.0.1'))).not.toBe(a)
  })

  it('answers the identity challenge with HMAC-SHA256(token, "web-search/v1\\n" + nonce), and only a well-formed one', async () => {
    const d = await door()
    expect(await coreCard(d.port)).toMatchObject({ name: 'web-search' })
    const bad = await call(d.port, { method: 'GET', path: CARD_PATH, headers: { authorization: undefined, 'a2a-mesh-challenge': 'short' } })
    expect(bad.headers['a2a-mesh-proof']).toBeUndefined()
    const none = await call(d.port, { method: 'GET', path: CARD_PATH, headers: { authorization: undefined } })
    expect(none.headers['a2a-mesh-proof']).toBeUndefined()
  })
})

describe('the front door refuses before the SDK (§3.2 item 1)', () => {
  const sendBody = envelope('SendMessage', ask('hello'))
  it.each([
    ['any Origin', { origin: 'http://127.0.0.1' }, 403],
    ['an Origin on the card', { origin: 'null' }, 403, 'GET', CARD_PATH],
    ['localhost as Host', { host: 'localhost:PORT' }, 403],
    ['another port in Host', { host: '127.0.0.1:1' }, 403],
    ['no token', { authorization: undefined }, 401],
    ['a wrong token of the same length', { authorization: `Bearer ${'z'.repeat(TOKEN.length)}` }, 401],
    ['a wrong token of another length', { authorization: `Bearer ${TOKEN}x` }, 401],
    ['a Basic scheme', { authorization: `Basic ${TOKEN}` }, 401],
    ['GET /', {}, 404, 'GET', '/'],
    ['another path', {}, 404, 'POST', '/v1/message:send'],
  ] as const)('%s', async (_name, headers, status, method = 'POST', path = '/') => {
    const d = await door()
    const fixed = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v?.replace('PORT', String(d.port))]))
    const res = await call(d.port, { method, path, headers: fixed, body: method === 'POST' ? sendBody : undefined })
    expect(res.status).toBe(status)
    expect(handle).not.toHaveBeenCalled()
  })

  it.each([[undefined], ['1.1'], ['0.3'], ['1'], ['1.0.x'], ['1.0, 1.1']])('refuses A2A-Version %s with -32009', async (version) => {
    const d = await door()
    const res = await rpc(d.port, 'SendMessage', ask('hello'), { 'a2a-version': version })
    expect(res.error).toEqual({ code: -32009, message: 'A2A-Version 1.0 is required' })
    expect(handle).not.toHaveBeenCalled()
  })

  it.each([['1.0'], ['1.0.3']])('accepts A2A-Version %s and hands the SDK 1.0', async (version) => {
    const d = await door()
    const res = await rpc(d.port, 'SendMessage', ask('hello'), { 'a2a-version': version })
    expect(res.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(handle).toHaveBeenCalledTimes(1)
    expect((handle.mock.calls[0]![1] as { requestedVersion: string }).requestedVersion).toBe('1.0')
  })

  it('refuses a body over 16 KiB and malformed JSON', async () => {
    const d = await door()
    expect((await call(d.port, { body: envelope('SendMessage', ask('x'.repeat(16 * 1024))) })).status).toBe(413)
    expect(JSON.parse((await call(d.port, { body: '{"jsonrpc":' })).body).error.code).toBe(-32700)
    expect(handle).not.toHaveBeenCalled()
  })
})

describe('the request is rebuilt from the allowlist (§3.2 item 2)', () => {
  const msg = (extra: Json): Json => ask('hello', extra)
  const conf = (configuration: Json): Json => ({ ...ask('hello'), configuration })
  const ext = (fields: Json): Json => msg({ metadata: { [EXTENSION]: fields } })
  const cases: Array<[string, string, unknown]> = [
    // snake_case aliases the SDK's decoders accept
    ['message.message_id', 'SendMessage', { message: { message_id: 'm', role: 'ROLE_USER', parts: [{ text: 'hello' }] } }],
    ['message.task_id', 'SendMessage', msg({ task_id: 't' })],
    ['message.context_id', 'SendMessage', msg({ context_id: 'c' })],
    ['message.reference_task_ids', 'SendMessage', msg({ reference_task_ids: ['t'] })],
    ['configuration.return_immediately', 'SendMessage', conf({ return_immediately: false })],
    ['configuration.accepted_output_modes', 'SendMessage', conf({ accepted_output_modes: ['text/plain'] })],
    ['configuration.history_length', 'SendMessage', conf({ history_length: 0 })],
    ['configuration.push_notification_config', 'SendMessage', conf({ push_notification_config: { url: 'http://127.0.0.1:1/' } })],
    ['configuration.task_push_notification_config', 'SendStreamingMessage', conf({ task_push_notification_config: { url: 'http://127.0.0.1:1/' } })],
    ['GetTask history_length', 'GetTask', { id: 't', history_length: 1 }],
    // camelCase fields that are not on the allowlist
    ['message.taskId (a continuation)', 'SendMessage', msg({ taskId: 't' })],
    ['message.contextId', 'SendMessage', msg({ contextId: 'c' })],
    ['message.referenceTaskIds', 'SendMessage', msg({ referenceTaskIds: ['t'] })],
    ['message.extensions', 'SendMessage', msg({ extensions: [EXTENSION] })],
    ['configuration.pushNotificationConfig', 'SendMessage', conf({ pushNotificationConfig: { url: 'http://127.0.0.1:1/' } })],
    ['configuration.taskPushNotificationConfig', 'SendStreamingMessage', conf({ taskPushNotificationConfig: { url: 'http://127.0.0.1:1/' } })],
    ['configuration.historyLength', 'SendMessage', conf({ historyLength: 0 })],
    ['configuration.blocking: true (A2A 0.3)', 'SendMessage', conf({ blocking: true })],
    ['configuration.blocking: false (A2A 0.3)', 'SendMessage', conf({ blocking: false })],
    ['configuration.returnImmediately: true', 'SendMessage', conf({ returnImmediately: true })],
    ['configuration: null', 'SendMessage', { ...ask('hello'), configuration: null }],
    ['params.tenant', 'SendMessage', { ...ask('hello'), tenant: 'other' }],
    ['params.metadata', 'SendMessage', { ...ask('hello'), metadata: {} }],
    ['GetTask tenant', 'GetTask', { id: 't', tenant: 'other' }],
    ['GetTask historyLength', 'GetTask', { id: 't', historyLength: 5 }],
    ['CancelTask tenant', 'CancelTask', { id: 't', tenant: 'other' }],
    ['CancelTask metadata', 'CancelTask', { id: 't', metadata: {} }],
    ['GetTask without an id', 'GetTask', {}],
    // the message itself
    ['ROLE_AGENT', 'SendMessage', msg({ role: 'ROLE_AGENT' })],
    ['two parts', 'SendMessage', msg({ parts: [{ text: 'a' }, { text: 'b' }] })],
    ['a data part', 'SendMessage', msg({ parts: [{ data: { q: 'a' } }] })],
    ['a url part', 'SendMessage', msg({ parts: [{ url: 'https://example.com/' }] })],
    ['a raw part', 'SendMessage', msg({ parts: [{ raw: 'aGk=' }] })],
    ['a text/html part', 'SendMessage', msg({ parts: [{ text: 'a', mediaType: 'text/html' }] })],
    ['a part filename', 'SendMessage', msg({ parts: [{ text: 'a', filename: 'q.txt' }] })],
    ['another metadata key', 'SendMessage', msg({ metadata: { 'urn:other': {} } })],
    ['an unknown extension field', 'SendMessage', ext({ provider: 'brave' })],
    ['synthesis in the extension', 'SendMessage', ext({ synthesis: false })],
    ['a bad mode', 'SendMessage', ext({ mode: 'deep' })],
    ['maxSources 11', 'SendMessage', ext({ maxSources: 11 })],
    ['six sites', 'SendMessage', ext({ sites: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'] })],
    ['timeoutMs 1000', 'SendMessage', ext({ timeoutMs: 1000 })],
    // the envelope
    ['jsonrpc 1.0', 'SendMessage', 'jsonrpc'],
    ['an extra top-level key', 'SendMessage', 'extra'],
    ['an object id', 'SendMessage', 'id'],
    // every other method
    ['ListTasks', 'ListTasks', {}],
    ['GetExtendedAgentCard', 'GetExtendedAgentCard', {}],
    ['SubscribeToTask', 'SubscribeToTask', { id: 't' }],
    ['CreateTaskPushNotificationConfig', 'CreateTaskPushNotificationConfig', { taskId: 't', url: 'http://127.0.0.1:1/' }],
    ['GetTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', { taskId: 't', id: 'p' }],
    ['ListTaskPushNotificationConfigs', 'ListTaskPushNotificationConfigs', { taskId: 't' }],
    ['DeleteTaskPushNotificationConfig', 'DeleteTaskPushNotificationConfig', { taskId: 't', id: 'p' }],
    ['message/send (A2A 0.3)', 'message/send', ask('hello')],
    ['tasks/get (A2A 0.3)', 'tasks/get', { id: 't' }],
    ['an unknown method', 'Search', ask('hello')],
  ]

  it.each(cases)('refuses %s with -32602 before the SDK', async (_name, method, params) => {
    const d = await door()
    const body = params === 'jsonrpc' ? JSON.stringify({ jsonrpc: '1.0', id: 1, method, params: ask('hello') })
      : params === 'extra' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: ask('hello'), tenant: 'x' })
        : params === 'id' ? JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method, params: ask('hello') })
          : envelope(method, params)
    const res = JSON.parse((await call(d.port, { body })).body) as Json
    expect(res.error).toEqual({ code: -32602, message: 'Invalid params' })
    expect(handle).not.toHaveBeenCalled()
  })

  it('accepts returnImmediately: false, acceptedOutputModes and every extension field, and hands the SDK a new object', async () => {
    const d = await door()
    const fields = { mode: 'sources', recency: 'week', maxSources: 3, sites: ['nodejs.org'], excludeSites: ['example.net'], fresh: true, timeoutMs: 90_000 }
    const params = { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'node lts', mediaType: 'text/plain' }], metadata: { [EXTENSION]: fields } }, configuration: { returnImmediately: false, acceptedOutputModes: ['application/json'] } }
    const res = await rpc(d.port, 'SendMessage', params)
    expect(res.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(res.result.task.artifacts[0].parts[1].data).toMatchObject({ code: 0, mode: 'sources', untrusted: true })
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0]![0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { ...params.message, parts: [{ text: 'node lts', mediaType: 'text/plain' }] }, configuration: { acceptedOutputModes: ['application/json'] } } })
    expect(rebuild(JSON.parse(envelope('SendMessage', params)))).not.toBe(params)
  })
})

describe('tasks', () => {
  it('a task is invisible to another token', async () => {
    const d = await door()
    const id = (await rpc(d.port, 'SendMessage', ask('hello'))).result.task.id as string
    expect((await rpc(d.port, 'GetTask', { id })).result.id).toBe(id)
    const other = { authorization: `Bearer ${OTHER}` }
    expect((await rpc(d.port, 'GetTask', { id }, other)).error.code).toBe(-32001)
    expect((await rpc(d.port, 'CancelTask', { id }, other)).error.code).toBe(-32001)
  })

  it('streams searching, answering and checking, and the artifact only with COMPLETED', async () => {
    const d = await door()
    const res = await call(d.port, { body: envelope('SendStreamingMessage', ask('hello')) })
    expect(res.headers['content-type']).toBe('text/event-stream')
    const results = events(res.body).map((e) => e.result as Json)
    expect(results[0]!.task.status.state).toBe('TASK_STATE_SUBMITTED')
    const updates = results.slice(1).map((r) => r.artifactUpdate ? 'artifact' : `${r.statusUpdate.status.state}${r.statusUpdate.status.message ? ` ${r.statusUpdate.status.message.parts[0].text}` : ''}`)
    expect(updates).toEqual(['TASK_STATE_WORKING searching', 'TASK_STATE_WORKING answering', 'TASK_STATE_WORKING checking', 'artifact', 'TASK_STATE_COMPLETED'])
  })

  it('never rejects: a stage that throws ends the task FAILED "internal", without its message', async () => {
    const d = await door(async () => { throw new Error('secret-detail') })
    const res = await call(d.port, { body: envelope('SendMessage', ask('hello')) })
    const task = (JSON.parse(res.body) as Json).result.task
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.status.message.parts).toEqual([{ text: 'failed: internal', mediaType: 'text/plain' }, { data: { code: 13, status: 'failed', reason: 'internal' }, mediaType: 'application/json' }])
    expect(res.body).not.toContain('secret-detail')
    expect(d.log).toEqual([expect.objectContaining({ outcome: 'failed:internal', chars: 5, words: 1, mode: 'answer' })])
  })

  it('a stream that disconnects does not stop the task: GetTask sees it complete', async () => {
    const hold = deferred()
    cleanups.push(() => hold.release())
    const d = await door(async (q, o, s, on) => {
      on('searching')
      await hold.promise
      return fixtureRun(q, o, s, () => {})
    })
    const id = await new Promise<string>((resolve, reject) => {
      const headers = { host: `127.0.0.1:${d.port}`, authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json' }
      const req = request({ host: '127.0.0.1', port: d.port, method: 'POST', path: '/', headers }, (res) => {
        res.setEncoding('utf8')
        res.once('data', (c: string) => {
          resolve((JSON.parse(c.split('\n\n')[0]!.replace(/^data: /, '')) as Json).result.task.id as string)
          req.destroy()
        })
      })
      req.on('error', () => {})
      req.on('close', () => reject(new Error('closed before the first event')))
      req.end(envelope('SendStreamingMessage', ask('hello')))
    })
    hold.release()
    await vi.waitFor(async () => expect((await rpc(d.port, 'GetTask', { id })).result.status.state).toBe('TASK_STATE_COMPLETED'))
  })

  it('a refused run ends REJECTED with its data', async () => {
    const d = await door(async () => ({ state: 'rejected', reason: 'screen', data: { code: 11, status: 'rejected', reason: 'screen', classes: ['email'] } }))
    const task = (await rpc(d.port, 'SendMessage', ask('hello'))).result.task
    expect(task.status.state).toBe('TASK_STATE_REJECTED')
    expect(task.status.message.parts[1].data).toEqual({ code: 11, status: 'rejected', reason: 'screen', classes: ['email'] })
  })

  it('keeps only the last 64 finished tasks', async () => {
    const d = await door()
    const ids: string[] = []
    for (let i = 0; i < 66; i++) ids.push((await rpc(d.port, 'SendMessage', ask('hello'))).result.task.id as string)
    expect((await rpc(d.port, 'GetTask', { id: ids[0] })).error.code).toBe(-32001)
    expect((await rpc(d.port, 'GetTask', { id: ids[1] })).error.code).toBe(-32001)
    expect((await rpc(d.port, 'GetTask', { id: ids[2] })).result.id).toBe(ids[2])
    expect((await rpc(d.port, 'GetTask', { id: ids[65] })).result.id).toBe(ids[65])
  })
})


describe('interop over loopback', () => {
  // 'hold' waits until the task is cancelled; anything else answers from the fixture
  const run: Run = async (query, options, signal, onState) => {
    if (query !== 'hold') return fixtureRun(query, options, signal, onState)
    onState('searching')
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
    return fixtureRun(query, options, signal, () => {})
  }

  it("the SDK's own client, through identityFetch: SendMessage, SendStreamingMessage, GetTask, CancelTask", async () => {
    const d = await door(run)
    const sent: string[] = []
    const client = await sdkClient(d.url, sent)

    const task = await client.sendMessage(sdkMessage('hello'))
    if (!('id' in task)) throw new Error('expected a task')
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(task.artifacts[0]!.parts[1]!.content).toMatchObject({ $case: 'data', value: { code: 0, untrusted: true, sources: [expect.objectContaining({ n: 1, host: 'example.com' })] } })
    expect((await client.getTask({ id: task.id, tenant: '', historyLength: undefined })).status?.state).toBe(TaskState.TASK_STATE_COMPLETED)

    const streamed: string[] = []
    for await (const event of client.sendMessageStream(sdkMessage('hello'))) {
      const p = event.payload
      streamed.push(p?.$case === 'statusUpdate' ? TaskState[p.value.status!.state] : p?.$case ?? '')
    }
    expect(streamed).toEqual(['task', 'TASK_STATE_WORKING', 'TASK_STATE_WORKING', 'TASK_STATE_WORKING', 'artifactUpdate', 'TASK_STATE_COMPLETED'])

    const cancelled: string[] = []
    let id = ''
    for await (const event of client.sendMessageStream(sdkMessage('hold'))) {
      const p = event.payload
      if (p?.$case === 'task') id = p.value.id
      cancelled.push(p?.$case === 'statusUpdate' ? TaskState[p.value.status!.state] : p?.$case ?? '')
      if (p?.$case === 'statusUpdate' && p.value.status?.state === TaskState.TASK_STATE_WORKING) {
        expect((await client.cancelTask({ id, tenant: '', metadata: undefined })).status?.state).toBe(TaskState.TASK_STATE_CANCELED)
      }
    }
    expect(cancelled).toEqual(['task', 'TASK_STATE_WORKING', 'TASK_STATE_CANCELED'])

    // everything the SDK client put on the wire is inside the allowlist
    expect(sent.map((b) => (JSON.parse(b) as Json).method)).toEqual(['SendMessage', 'GetTask', 'SendStreamingMessage', 'SendStreamingMessage', 'CancelTask'])
    for (const body of sent) expect(rebuild(JSON.parse(body))).toBeDefined()
  })

  it('a minimal Node-core client: the identity check, then SendMessage, SendStreamingMessage, GetTask, CancelTask', async () => {
    const d = await door(run)
    expect((await coreCard(d.port)).name).toBe('web-search')

    const task = (await rpc(d.port, 'SendMessage', ask('hello'))).result.task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0].parts[0].text).toContain('[1]')
    expect((await rpc(d.port, 'GetTask', { id: task.id })).result.status.state).toBe('TASK_STATE_COMPLETED')
    expect(events((await call(d.port, { body: envelope('SendStreamingMessage', ask('hello')) })).body).at(-1)!.result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED')

    let cancel: Promise<Json> | undefined
    const stream = await call(d.port, {
      body: envelope('SendStreamingMessage', ask('hold')),
      onEvent: (e) => { if (e.result.statusUpdate?.status.state === 'TASK_STATE_WORKING') cancel = rpc(d.port, 'CancelTask', { id: e.result.statusUpdate.taskId }) },
    })
    expect((await cancel!).result.status.state).toBe('TASK_STATE_CANCELED')
    expect(events(stream.body).map((e) => e.result.statusUpdate?.status.state ?? 'task')).toEqual(['task', 'TASK_STATE_WORKING', 'TASK_STATE_CANCELED'])
  })

  it('resolveCard gives the identity-checked card and the hash any copy of this version shares', async () => {
    const d = await door()
    const r = await resolveCard(d.url, TOKEN)
    expect(r.card.name).toBe('web-search')
    expect(r.cardSha256).toBe(cardHash(card('http://127.0.0.1:4421/', '0.0.0-test')))
  })
})

describe('identityFetch (§3.3, §10.1)', () => {
  type Seen = { method: string; url: string; authorization?: string }
  // a server on the port: a squatter serving a copy of the card, or one that knows the token but misbehaves
  async function impostor(o: { proves: boolean; interfaceUrl?: (own: string) => string; redirectTo?: string }): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = []
    const s = await listen((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization })
      if (req.url === CARD_PATH) {
        const nonce = String(req.headers['a2a-mesh-challenge'] ?? '')
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.proves ? { 'a2a-mesh-proof': proofFor(TOKEN, nonce) } : { 'a2a-mesh-proof': proofFor('a-guess'.repeat(6), nonce) }) }
        return res.writeHead(200, headers).end(JSON.stringify(card(o.interfaceUrl?.(s.url) ?? s.url, '0.0.0-test')))
      }
      if (o.redirectTo) return res.writeHead(307, { location: o.redirectTo }).end()
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    return { url: s.url, seen }
  }

  it('a squatter without the proof never receives the token: SDK client, resolveCard and the Node-core path', async () => {
    const squatter = await impostor({ proves: false })
    await expect(sdkClient(squatter.url)).rejects.toThrow(IdentityError)
    await expect(resolveCard(squatter.url, TOKEN)).rejects.toThrow('another process holds the agent port')
    await expect(coreCard(Number(new URL(squatter.url).port))).rejects.toThrow('no identity proof')
    const f = identityFetch({ token: TOKEN, endpoint: squatter.url })
    await expect(f(squatter.url, { method: 'POST', body: '{}' })).rejects.toThrow('has not proven its identity')
    expect(squatter.seen.every((s) => s.method === 'GET' && s.url === CARD_PATH)).toBe(true)
    expect(squatter.seen.some((s) => s.authorization !== undefined)).toBe(false)
  })

  it("refuses a card whose interface URL points elsewhere: the configured endpoint wins", async () => {
    const elsewhere = await impostor({ proves: true })
    const liar = await impostor({ proves: true, interfaceUrl: () => elsewhere.url })
    const client = await sdkClient(liar.url)
    await expect(client.sendMessage(sdkMessage('hello'))).rejects.toThrow('outside the configured endpoint')
    expect(elsewhere.seen).toEqual([])
    expect(liar.seen.filter((s) => s.method === 'POST')).toEqual([])
  })

  it('refuses a redirect and never follows it', async () => {
    const target = await impostor({ proves: true })
    const redirecting = await impostor({ proves: true, redirectTo: target.url })
    const client = await sdkClient(redirecting.url)
    await expect(client.sendMessage(sdkMessage('hello'))).rejects.toThrow('a redirect')
    expect(target.seen).toEqual([])
  })

  it('refuses an endpoint or URL that is not the configured loopback one', async () => {
    expect(() => identityFetch({ token: TOKEN, endpoint: 'http://localhost:4421/' })).toThrow(IdentityError)
    expect(() => identityFetch({ token: TOKEN, endpoint: 'https://127.0.0.1:4421/' })).toThrow(IdentityError)
    const f = identityFetch({ token: TOKEN, endpoint: 'http://127.0.0.1:4421/' })
    for (const url of ['http://127.0.0.1:4422/', 'http://127.0.0.1:4421/other', 'http://127.0.0.1:4421/?q=x', 'http://user@127.0.0.1:4421/']) {
      await expect(f(url)).rejects.toThrow('outside the configured endpoint')
    }
  })
})

function meshHome(o: { port: number; token?: string; key?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-web-search-'))
  made.push(dir)
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, ...(o.key === false ? {} : { agents: { 'web-search': { endpoint: `http://127.0.0.1:${o.port}`, profile: 'web-search' } } }) }))
  mkdirSync(join(dir, 'mesh', 'tokens'), { recursive: true })
  writeFileSync(join(dir, 'mesh', 'tokens', 'web-search'), `${o.token ?? TOKEN}\n`)
  chmodSync(join(dir, 'mesh', 'tokens', 'web-search'), 0o600)
  return dir
}
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}
const logText = (dir: string): string => {
  const logs = join(dir, 'mesh', 'logs')
  try {
    return readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('')
  } catch {
    return ''
  }
}

describe('the agent process', () => {
  async function agent(dir: string, now: () => number = Date.now): Promise<Agent & { tick: () => void }> {
    let fn = (): void => {}
    const a = await startAgent({ meshDir: dir, now, every: (ms, f) => { expect(ms).toBe(GATE_MS); fn = f; return () => {} } })
    cleanups.push(() => a.stop('signal'))
    return { ...a, tick: () => fn() }
  }

  it('refuses to start without agents.web-search or with a non-loopback endpoint', async () => {
    await expect(startAgent({ meshDir: meshHome({ port: 1, key: false }) })).rejects.toThrow('mesh.json has no agents.web-search')
    const dir = meshHome({ port: 1 })
    writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'web-search': { endpoint: 'http://0.0.0.0:4421' } } }))
    await expect(startAgent({ meshDir: dir })).rejects.toThrow('must be http://127.0.0.1:<port>')
  })

  it('serves on its endpoint, logs sizes and outcomes but never the query, and stops when the key goes', async () => {
    const port = await freePort()
    const dir = meshHome({ port })
    const a = await agent(dir)
    expect((await rpc(port, 'SendMessage', ask('canary-Kq3 lookup'))).result.task.status.state).toBe('TASK_STATE_COMPLETED')
    const line = JSON.parse(logText(dir)) as Json
    expect(line).toMatchObject({ chars: 17, words: 2, mode: 'answer', outcome: 'completed' })
    expect(logText(dir)).not.toContain('canary-Kq3')
    a.tick()
    expect(await Promise.race([a.exited, new Promise((r) => setTimeout(() => r('running'), 20))])).toBe('running')
    writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1 }))
    a.tick()
    expect(await a.exited).toBe('mesh.json')
  })

  it('stops when the token changes, and after 30 idle minutes', async () => {
    const port = await freePort()
    const dir = meshHome({ port })
    const a = await agent(dir)
    writeFileSync(join(dir, 'mesh', 'tokens', 'web-search'), `${OTHER}\n`)
    a.tick()
    expect(await a.exited).toBe('token')

    let t = 0
    const b = await agent(meshHome({ port: await freePort() }), () => t)
    t = IDLE_MS - 1
    b.tick()
    t = IDLE_MS
    b.tick()
    expect(await b.exited).toBe('idle')
  })
})

type Child = { stderr: () => string; stdout: () => string; exited: Promise<number | null> }
function spawnNode(args: string[], env: Record<string, string>): Child {
  const p = spawn(process.execPath, ['--import', HOOKS, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  let out = ''
  p.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
  p.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
  const exited = new Promise<number | null>((resolve) => p.on('exit', (code) => resolve(code)))
  cleanups.push(async () => { p.kill('SIGKILL'); await exited })
  return { stderr: () => err, stdout: () => out, exited }
}

describe('wrap.ts (§2.1)', () => {
  it("loads @a2a-js/sdk only for --agent web-search: unslop's start never does", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-wrap-'))
    made.push(dir)
    const unslop = spawnNode([WRAP, '--agent', 'openai-compatible', '--profile', 'unslop'], { AGENT_INBOX_MESH_DIR: dir, LOAD_SPY: '1' })
    expect(await unslop.exited).toBe(1)
    expect(unslop.stderr()).toBe('agent-inbox-wrap: mesh.json is missing or unreadable: run meshctl enable --unslop\n')

    const webSearch = spawnNode([WRAP, '--agent', 'web-search', '--profile', 'web-search'], { AGENT_INBOX_MESH_DIR: dir, LOAD_SPY: '1' })
    expect(await webSearch.exited).toBe(1)
    expect(webSearch.stderr()).toContain('load-spy: @a2a-js/sdk')
    expect(webSearch.stderr()).toContain('agent-inbox-wrap: mesh.json has no agents.web-search: run meshctl enable --web-search\n')
  })

  it('a usage error is 4', async () => {
    let out = ''
    expect(await main(['--agent', 'web-search', '--profile', 'unslop'], {}, (t) => { out += t })).toBe(4)
    expect(out).toBe('usage: agent-inbox-wrap --agent web-search --profile web-search\n')
  })
})

describe('a canary query never reaches stderr or a log (§3.2 item 5, §13 Logs)', () => {
  const CANARY = 'Zq7canaryW1'
  async function start(): Promise<{ port: number; dir: string; child: Child }> {
    const port = await freePort()
    const dir = meshHome({ port })
    const child = spawnNode([CHILD], { AGENT_INBOX_MESH_DIR: dir })
    await vi.waitFor(() => expect(child.stderr()).toContain('listening on'), { timeout: 10_000 })
    return { port, dir, child }
  }
  const clean = (c: { dir: string; child: Child }): void => {
    expect(c.child.stderr()).not.toContain(CANARY)
    expect(c.child.stdout()).toBe('')
    expect(logText(c.dir)).not.toContain(CANARY)
    expect(logText(c.dir)).not.toContain('kagi')
  }

  it('when a stage throws, a provider error carries ?q=, console is called, or a warning is emitted', async () => {
    const c = await start()
    for (const kind of ['throw', 'provider']) {
      const res = await call(c.port, { body: envelope('SendMessage', ask(`${kind} ${CANARY}`)) })
      const task = (JSON.parse(res.body) as Json).result.task
      expect(task.status.state).toBe('TASK_STATE_FAILED')
      expect(task.status.message.parts[0].text).toBe('failed: internal')
      expect(res.body).not.toMatch(/stage failed|kagi/)
    }
    expect((await rpc(c.port, 'SendMessage', ask(`warning ${CANARY}`))).result.task.status.state).toBe('TASK_STATE_COMPLETED')
    await vi.waitFor(() => expect(c.child.stderr()).toContain('agent: warning other'))
    expect(c.child.stderr()).toContain('agent: warning Warning')
    for (const name of ['error', 'warn', 'log', 'info', 'debug', 'trace', 'dir', 'table', 'assert']) expect(c.child.stderr()).toContain(`sdk: ${name}\n`)
    expect(logText(c.dir).trim().split('\n')).toHaveLength(3)
    clean(c)
  })

  it.each([['timer'], ['reject']])('when a %s fails outside any await: one fixed line, open tasks FAILED, exit 1', async (kind) => {
    const c = await start()
    const task = (await rpc(c.port, 'SendMessage', ask(`${kind} ${CANARY}`))).result.task
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.status.message.parts[0].text).toBe('failed: internal')
    expect(await c.child.exited).toBe(1)
    expect(c.child.stderr()).toContain('agent: uncaught Error\n')
    clean(c)
  })
})
