// Interop with the official A2A CLI (a2aproject/a2a-cli, #532), both directions.
// Official CLI → web search's front door: the requests `a2a` 0.4.0 sent in the manual run,
// replayed byte for byte (ids and the token replaced), so CI needs no CLI. Our client →
// an agent this repo doesn't ship: `meshctl call` against an `@a2a-js/sdk` agent that answers the
// a2a-mesh/v1 challenge, and against one that cannot (14, D17). The tests that run the CLI itself
// (its `send`, and its `server --echo`, a2a-go's server) skip when `a2a` is not on PATH or in A2A_CLI.
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentCard, Role, TaskState } from '@a2a-js/sdk'
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server'
import type { AgentExecutor } from '@a2a-js/sdk/server'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_PATH } from '../src/a2a-client.js'
import { card, createExecutor, fixtureRun } from '../src/web-search/agent.js'
import { EXTENSION, startFrontDoor } from '../src/web-search/front-door.js'

type Json = Record<string, any>
const TOKEN = 'k4'.repeat(20)
const HOOKS = fileURLToPath(new URL('./ts-hooks.mjs', import.meta.url))
const MESHCTL = fileURLToPath(new URL('../../../src/meshctl.ts', import.meta.url))

const made: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-a2a-cli-'))
  made.push(dir)
  return dir
}
const privateFile = (path: string, text: string, mode = 0o600): string => {
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

// `a2a` from A2A_CLI or PATH, or undefined: the tests that run it skip without it
const CLI = ((): string | undefined => {
  const bin = process.env.A2A_CLI || 'a2a'
  return spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout?.startsWith('a2a version') ? bin : undefined
})()

async function frontDoor(): Promise<{ port: number; url: string }> {
  const executor = createExecutor(fixtureRun, () => {})
  const d = await startFrontDoor({ port: 0, tokens: [TOKEN], card: (url) => card(url, '0.0.0-test'), executor, busy: () => executor.open() > 0 })
  cleanups.push(() => d.close())
  return d
}

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
type Run = { code: number | null; stdout: string; stderr: string }
function run(bin: string, args: string[], env: Record<string, string> = {}, input = ''): Promise<Run> {
  const p = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  p.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
  p.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
  p.stdin.end(input)
  return new Promise((resolve) => p.on('close', (code) => resolve({ code, stdout, stderr })))
}
const events = (body: string): Json[] => body.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as Json)

// What `a2a` 0.4.0 sends (#532's manual run): Go's client headers, Authorization from the
// credential helper on the card request too, A2A-Version 1.0, and the body's key order as sent
const CLI_HEADERS = { 'user-agent': 'Go-http-client/1.1', authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' }
const cliPost = (body: Json, stream = false): Record<string, string> => ({
  'user-agent': 'Go-http-client/1.1', 'content-length': String(Buffer.byteLength(JSON.stringify(body))), 'a2a-version': '1.0',
  ...(stream ? { accept: 'text/event-stream' } : {}), authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'accept-encoding': 'gzip',
})
const cliSend = (method: string, params: Json = {}, message: Json = {}): Json => ({
  jsonrpc: '2.0', method,
  params: { ...params, message: { messageId: '01a1c377-1966-7cdc-af80-e54d49fa34d1', ...message, parts: [{ text: 'When did Node 24 enter LTS?' }], role: 'ROLE_USER' } },
  id: 'eac26d0f-8bfd-40d5-99de-a37588ed63ce',
})
const post = (port: number, body: Json, stream = false): Promise<Reply> => send(port, 'POST', '/', cliPost(body, stream), JSON.stringify(body))

describe('the official a2a CLI calls web search through its front door (#532)', () => {
  it('serves the card to the CLI without the identity challenge, and ignores the token it sends with it', async () => {
    const { port } = await frontDoor()
    const res = await send(port, 'GET', CARD_PATH, CLI_HEADERS)
    expect(res.status).toBe(200)
    expect(res.headers['a2a-mesh-proof']).toBeUndefined()
    expect(JSON.parse(res.body).supportedInterfaces).toEqual([{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }])
  })

  it('answers `a2a send`, `a2a send --stream` and `a2a task get` as sent, with no history', async () => {
    const { port } = await frontDoor()
    const sent = JSON.parse((await post(port, cliSend('SendMessage'))).body) as Json
    expect(sent.id).toBe('eac26d0f-8bfd-40d5-99de-a37588ed63ce')
    expect(sent.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(sent.result.task.artifacts[0].parts[0].text).toContain('example.com is reserved')
    expect(sent.result.task.history ?? []).toEqual([])

    const streamed = events((await post(port, cliSend('SendStreamingMessage'), true)).body)
    expect(streamed[0]!.result.task.status.state).toBe('TASK_STATE_SUBMITTED')
    expect(streamed.at(-1)!.result.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED')

    const got = JSON.parse((await post(port, { jsonrpc: '2.0', method: 'GetTask', params: { id: sent.result.task.id }, id: 'd3bb88a8' })).body) as Json
    expect(got.result.status.state).toBe('TASK_STATE_COMPLETED')
    expect(got.result.history ?? []).toEqual([])
  })

  it("takes web search's options through `a2a send --request-payload`, in the message's metadata", async () => {
    const { port } = await frontDoor()
    const body = cliSend('SendMessage', {}, { metadata: { [EXTENSION]: { mode: 'sources', maxSources: 3 } } })
    const sent = JSON.parse((await post(port, body)).body) as Json
    expect(sent.result.task.artifacts[0].parts[1].data.mode).toBe('sources')
  })

  it('asks for the token when the CLI has none: 401 with WWW-Authenticate', async () => {
    const { port } = await frontDoor()
    const headers = cliPost(cliSend('SendMessage'))
    delete headers.authorization
    const res = await send(port, 'POST', '/', headers, JSON.stringify(cliSend('SendMessage')))
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe('Bearer')
  })

  // by design (web search design §3.2): one call, one task, no history, no tenant, no other method
  it.each([
    ['--history 5', cliSend('SendMessage', { configuration: { historyLength: 5 } })],
    ['--async', cliSend('SendMessage', { configuration: { returnImmediately: true } })],
    ['--tenant t1', cliSend('SendMessage', { tenant: 't1' })],
    ['--context-id c1', cliSend('SendMessage', {}, { contextId: 'c1' })],
    ['--metadata (on the request, not the message)', cliSend('SendMessage', { metadata: { [EXTENSION]: { mode: 'sources' } } })],
    ['task get --history 3', { jsonrpc: '2.0', method: 'GetTask', params: { id: 't', historyLength: 3 }, id: '1' }],
    ['task list', { jsonrpc: '2.0', method: 'ListTasks', params: {}, id: '1' }],
    ['task subscribe', { jsonrpc: '2.0', method: 'SubscribeToTask', params: { id: 't' }, id: '1' }],
  ])('refuses `a2a %s` with -32602 before the SDK', async (_flag, body) => {
    const { port } = await frontDoor()
    expect(JSON.parse((await post(port, body)).body).error.code).toBe(-32602)
  })

  it.skipIf(!CLI)('works with the CLI itself, the token from a file through a credential helper', async () => {
    const { port } = await frontDoor()
    const dir = scratch()
    const tokenFile = privateFile(join(dir, 'token'), `${TOKEN}\n`)
    const helper = privateFile(join(dir, 'helper'), `#!${process.execPath}
const t = require('node:fs').readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim()
process.stdout.write(JSON.stringify({ headers: { Authorization: ['Bearer ' + t] } }))
`, 0o700)
    for (const extra of [[], ['--stream']]) {
      // async: the front door answers from this process
      const r = await run(CLI!, ['--credential-helper', `127.0.0.1=${helper}`, 'send', '-a', `http://127.0.0.1:${port}`, '-o', 'jsonl', ...extra, 'When did Node 24 enter LTS?'])
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toContain('TASK_STATE_COMPLETED')
      expect(r.stdout).toContain('example.com is reserved')
    }
  })
})

// An agent this repo doesn't ship: `@a2a-js/sdk`'s own request handler and task store, echoing the
// message as a task's one artifact; `proves` answers the challenge as docs/mesh-call.md says.
async function sdkAgent(o: { proves: boolean }): Promise<{ port: number; posts: () => number }> {
  let posts = 0
  let port = 0
  const agentCard = (): Json => ({
    name: 'SDK Echo', description: 'Echoes the message', version: '1.0.0',
    supportedInterfaces: [{ url: `http://127.0.0.1:${port}/`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: true, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'echo', description: 'Echoes the message', tags: ['echo'] }],
  })
  const executor: AgentExecutor = {
    cancelTask: async () => {},
    execute: async (ctx, bus) => {
      const { taskId, contextId } = ctx
      const content = ctx.userMessage.parts[0]?.content
      const text = content?.$case === 'text' ? content.value : ''
      const status = (state: TaskState) => AgentEvent.statusUpdate({ taskId, contextId, metadata: undefined, status: { state, timestamp: new Date().toISOString(), message: undefined } })
      bus.publish(AgentEvent.task({ id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() }, artifacts: [], history: [], metadata: undefined }))
      bus.publish(status(TaskState.TASK_STATE_WORKING))
      bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: { artifactId: randomUUID(), name: 'echo', description: '', parts: [{ content: { $case: 'text', value: `echo: ${text}` }, mediaType: 'text/plain', filename: '', metadata: undefined }], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }))
      bus.publish(status(TaskState.TASK_STATE_COMPLETED))
    },
  }
  let transport: JsonRpcTransportHandler | undefined
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => void (async () => {
      if (req.method === 'GET' && req.url === CARD_PATH) {
        const nonce = req.headers['a2a-mesh-challenge']
        const proof = o.proves && typeof nonce === 'string' && /^[\w-]{43}$/.test(nonce)
          ? { 'a2a-mesh-proof': createHmac('sha256', TOKEN).update(`a2a-mesh/v1\n${nonce}`).digest('base64url') } : {}
        return void res.writeHead(200, { 'content-type': 'application/json', ...proof }).end(JSON.stringify(agentCard()))
      }
      posts++
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end()
      const context = new ServerCallContext({ user: { isAuthenticated: true, userName: 'caller' }, requestedVersion: '1.0' })
      const result = await transport!.handle(JSON.parse(Buffer.concat(chunks).toString('utf8')), context)
      if (!(Symbol.asyncIterator in result)) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for await (const event of result) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })())
  }
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  transport = new JsonRpcTransportHandler(new DefaultRequestHandler(AgentCard.fromJSON(agentCard()), new InMemoryTaskStore(), executor))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { port, posts: () => posts }
}

function meshctl(home: string, args: string[], input?: string): Promise<Run> {
  return run(process.execPath, ['--import', HOOKS, MESHCTL, ...args], { AGENT_INBOX_MESH_DIR: home }, input)
}
async function addThenCall(cardUrl: string, request: string): Promise<Run> {
  const dir = scratch()
  const tokenFile = privateFile(join(dir, 'token'), `${TOKEN}\n`)
  const added = await meshctl(dir, ['add', cardUrl, '--id', 'external', '--token-file', tokenFile, '--apply'])
  expect(added.code, added.stderr).toBe(0)
  return meshctl(dir, ['call', 'external', '--skill', 'echo'], request)
}

describe('meshctl call reaches an agent this repo does not ship (#532)', () => {
  it('calls an @a2a-js/sdk agent that answers the a2a-mesh/v1 challenge, streamed', async () => {
    const agent = await sdkAgent({ proves: true })
    const r = await addThenCall(`http://127.0.0.1:${agent.port}${CARD_PATH}`, 'hello from meshctl')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^Untrusted result from agent external \(card [0-9a-f]{12}\)/)
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('echo: hello from meshctl')
  })

  it('refuses one that does not answer the challenge (14), and sends it neither the token nor the request', async () => {
    const agent = await sdkAgent({ proves: false })
    const r = await addThenCall(`http://127.0.0.1:${agent.port}${CARD_PATH}`, 'hello')
    expect(r.code).toBe(14)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('a2a-mesh/v1 challenge')
    expect(agent.posts()).toBe(0)
  })

  // a2a-go's server, the official CLI's `a2a server --echo`, behind a proxy that answers the challenge
  it.skipIf(!CLI)("calls the official CLI's own server, with and without the identity proof", async () => {
    const free = async (): Promise<number> => {
      const s = createServer()
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
      const { port } = s.address() as AddressInfo
      await new Promise<void>((resolve) => s.close(() => resolve()))
      return port
    }
    const [echoPort, proxyPort] = [await free(), await free()]
    const dir = scratch()
    const cardFile = join(dir, 'card.json')
    writeFileSync(cardFile, JSON.stringify({
      name: 'Echo Sample', description: 'Echoes the message', version: '1.0.0',
      supportedInterfaces: [{ url: `http://127.0.0.1:${proxyPort}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'echo', description: 'Echoes the message', tags: ['echo'] }],
    }))
    const echo = spawn(CLI!, ['server', '--echo', '--quiet', '--serve-transport', 'jsonrpc', '--port', String(echoPort), '--card', cardFile], { stdio: 'ignore' })
    const gone = new Promise<void>((resolve) => echo.on('exit', () => resolve()))
    cleanups.push(async () => { echo.kill('SIGTERM'); await gone })
    for (let i = 0; i < 50; i++) {
      const up = await send(echoPort, 'GET', CARD_PATH, {}).then((r) => r.status === 200, () => false)
      if (up) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    let proves = false
    const proxy = createServer((req, res) => {
      const nonce = req.headers['a2a-mesh-challenge']
      const up = request({ host: '127.0.0.1', port: echoPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${echoPort}` } }, (r) => {
        const headers = { ...r.headers, ...(proves && typeof nonce === 'string' ? { 'a2a-mesh-proof': createHmac('sha256', TOKEN).update(`a2a-mesh/v1\n${nonce}`).digest('base64url') } : {}) }
        res.writeHead(r.statusCode ?? 502, headers)
        r.pipe(res)
      })
      req.pipe(up)
    })
    await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()) }))
    const cardUrl = `http://127.0.0.1:${proxyPort}${CARD_PATH}`

    expect((await addThenCall(cardUrl, 'hello')).code).toBe(14)
    proves = true
    const r = await addThenCall(cardUrl, 'hello from meshctl')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('hello from meshctl')
  })
})
