// The agent kit (#539; docs/agent-kit.md). The example agent, run as a process the way the docs
// run it and signed by a key `meshctl key create` makes at test time, passes `meshctl check
// --strict` at the publishable level with every live test, `--send` included, which proves the
// kit answers the generic a2a-mesh/v1 identity label. A child whose run calls console, emits a
// warning, throws and leaves a rejection unhandled proves `startKitAgent` installs the output
// guard itself; it also refuses a short token before the port opens, and an agent with no
// extension takes no metadata.
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { echo, echoCard, main } from '../src/examples/echo/agent.js'
import { ConfigError } from '../src/files.js'
import { CARD_PATH, MESH_PROOF_LABEL, proof, rebuildRequest, startKitAgent } from '../src/kit/index.js'

type Json = Record<string, any>
const TOKEN = 'k9'.repeat(20)
const HOOKS = fileURLToPath(new URL('./ts-hooks.mjs', import.meta.url))
const ECHO = fileURLToPath(new URL('../src/examples/echo/agent.ts', import.meta.url))
const CANARY_CHILD = fileURLToPath(new URL('./kit-canary-child.ts', import.meta.url))
// meshctl's key command and check, loaded at run time: they are outside this package's rootDir
const ROOT = (name: string): string => fileURLToPath(new URL(`../../../src/${name}`, import.meta.url))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-kit-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function privateFile(dir: string, name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text)
  chmodSync(path, 0o600)
  return path
}
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const { port } = s.address() as AddressInfo
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}
type Child = { child: ChildProcess; stderr: () => string; stdout: () => string; exited: Promise<number | null> }
function spawnTs(file: string, args: string[], env: Record<string, string>): Child {
  const child = spawn(process.execPath, ['--import', HOOKS, file, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  let out = ''
  child.stderr!.on('data', (c: Buffer) => { err += c.toString('utf8') })
  child.stdout!.on('data', (c: Buffer) => { out += c.toString('utf8') })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  cleanups.push(async () => { child.kill('SIGKILL'); await exited })
  return { child, stderr: () => err, stdout: () => out, exited }
}
async function listening(c: Child, prefix: string): Promise<string> {
  await vi.waitFor(() => expect(c.stderr()).toMatch(new RegExp(`${prefix}: listening on http://127\\.0\\.0\\.1:\\d+/`)), { timeout: 15_000 })
  return new RegExp(`${prefix}: listening on (\\S+)`).exec(c.stderr())![1]!
}
async function post(url: string, body: Json, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: (await res.json()) as Json }
}
const send = (text: string, extra: Json = {}): Json => ({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra } } })

describe('the example agent (#539)', () => {
  it('signed by a key made at test time, passes meshctl check --strict at the publishable level with every live test', async () => {
    const dir = scratch()
    const { runKey } = (await import(ROOT('mesh-keys.ts'))) as { runKey: (args: string[], io: Json) => number }
    const said: string[] = []
    expect(runKey(['create', 'echo', '--apply'], { dir, show: (p: string) => p, out: (t: string) => said.push(t), err: (t: string) => said.push(t) }), said.join('')).toBe(0)
    const tokenFile = privateFile(dir, 'echo.token', `${TOKEN}\n`)
    const message = `kit message ${randomBytes(6).toString('hex')}`
    const messageFile = privateFile(dir, 'message.txt', message)
    const port = await freePort()
    const agent = spawnTs(ECHO, ['--port', String(port), '--token-file', tokenFile], { AGENT_INBOX_MESH_DIR: dir })
    await listening(agent, 'echo')

    const { runCheck } = (await import(ROOT('mesh-check.ts'))) as { runCheck: (args: string[], io: Json) => Promise<number> }
    const out: string[] = []
    const code = await runCheck([`http://127.0.0.1:${port}${CARD_PATH}`, '--strict', '--json', '--token-file', tokenFile, '--send', messageFile], { out: (t: string) => out.push(t), err: (t: string) => out.push(t), tailnet: () => undefined })
    const tests = (JSON.parse(out.join('')) as { level: string; tests: Json[] }).tests
    expect(code, out.join('')).toBe(0)
    expect(tests.filter((t) => t.result !== 'pass').map((t) => `${t.id} ${t.result} ${t.reason}`)).toEqual([])
    expect(tests.map((t) => t.id)).toEqual(expect.arrayContaining(['signature.valid', 'live.identity', 'live.auth', 'live.send']))

    agent.child.kill('SIGTERM')
    expect(await agent.exited).toBe(0)
    // the --send task ran, and the agent wrote nothing but its own two lines
    expect(agent.stderr()).toBe(`echo: listening on http://127.0.0.1:${port}/\necho: stopped\n`)
    expect(agent.stdout()).toBe('')
  }, 30_000)

  it('echoes in upper case behind the front door; takes no metadata; answers a2a-mesh/v1, never web-search/v1', async () => {
    const dir = scratch()
    const url = await listening(spawnTs(ECHO, ['--port', String(await freePort()), '--token-file', privateFile(dir, 'echo.token', TOKEN)], { AGENT_INBOX_MESH_DIR: dir }), 'echo')
    const agent = { url }
    const done = await post(agent.url, send('hello, kit'))
    expect(done.json.result.task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(done.json.result.task.artifacts[0].parts).toEqual([{ text: 'HELLO, KIT', mediaType: 'text/plain' }])
    expect((await post(agent.url, send('   '))).json.result.task.status.state).toBe('TASK_STATE_REJECTED')
    expect((await post(agent.url, send('hi', { metadata: { 'https://example.org/ext/v1': {} } }))).json.error.code).toBe(-32602)
    expect((await post(agent.url, send('hi'), { authorization: 'Bearer wrong' })).status).toBe(401)

    const nonce = randomBytes(32).toString('base64url')
    const res = await fetch(new URL(CARD_PATH, agent.url), { headers: { 'a2a-mesh-challenge': nonce } })
    const card = (await res.json()) as Json
    expect(res.headers.get('a2a-mesh-proof')).toBe(proof(TOKEN, nonce, MESH_PROOF_LABEL))
    expect(res.headers.get('a2a-mesh-proof')).not.toBe(proof(TOKEN, nonce, 'web-search/v1'))
    // no key file: served unsigned, its profile listing no keys
    expect(card.signatures).toBeUndefined()
    expect(card.capabilities.extensions[0].params).toEqual({ id: 'shariqh.github.io/agent-inbox/examples/echo', skills: { echo: { egress: 'none', residency: 'any' } } })
  })

  it('startKitAgent guards the output itself: console calls, a warning, a throw and an unhandled rejection write fixed lines only', async () => {
    const canary = `Kc${randomBytes(6).toString('hex')}`
    const c = spawnTs(CANARY_CHILD, [], { AGENT_INBOX_MESH_DIR: scratch(), KIT_TOKEN: TOKEN })
    const url = await listening(c, 'kit')
    const task = async (text: string): Promise<Json> => (await post(url, send(text))).json.result.task
    expect((await task(`console ${canary}`)).status.state).toBe('TASK_STATE_COMPLETED')
    const thrown = await task(`throw ${canary}`)
    expect(thrown.status.state).toBe('TASK_STATE_FAILED')
    expect(thrown.status.message.parts[0].text).toBe('failed: internal')
    expect(JSON.stringify(thrown)).not.toContain(canary)
    await vi.waitFor(() => expect(c.stderr()).toContain('agent: warning Warning\n'))
    const rejected = await task(`reject ${canary}`)
    expect(rejected.status.state).toBe('TASK_STATE_FAILED')
    expect(rejected.status.message.parts[0].text).toBe('failed: internal')
    expect(await c.exited).toBe(1)
    const lines = c.stderr().trimEnd().split('\n')
    expect(lines).toEqual([expect.stringMatching(/^kit: listening on /), 'sdk: error', 'sdk: warn', 'sdk: log', 'agent: warning Warning', 'agent: uncaught Error'])
    expect(c.stderr()).not.toContain(canary)
    expect(c.stdout()).toBe('')
  }, 30_000)

  it('startKitAgent refuses a token under 32 printable characters before it listens or guards anything', async () => {
    const port = await freePort()
    const log = console.log
    await expect(startKitAgent({ agent: 'echo', meshDir: scratch(), port, token: 'short-token', card: echoCard, run: echo })).rejects.toThrow(ConfigError)
    await expect(startKitAgent({ agent: 'echo', meshDir: scratch(), port, token: `${'a'.repeat(31)} b`, card: echoCard, run: echo })).rejects.toThrow('at least 32 printable characters')
    expect(console.log).toBe(log)
    // nothing took the port
    const s = createServer()
    await new Promise<void>((resolve, reject) => s.once('error', reject).listen(port, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => s.close(() => resolve()))
  })

  it('an agent with no extension: absent or empty metadata passes, any key is refused', () => {
    const spec = { extensions: [], metadata: {} }
    expect((rebuildRequest(send('hi'), spec) as Json).params).toEqual({ message: { messageId: expect.any(String), role: 'ROLE_USER', parts: [{ text: 'hi', mediaType: 'text/plain' }] }, configuration: { historyLength: 0 } })
    expect((rebuildRequest(send('hi', { metadata: {} }), spec) as Json).params.message.metadata).toBeUndefined()
    expect(rebuildRequest(send('hi', { metadata: { '': {} } }), spec)).toBeUndefined()
  })

  it('refuses a usage error with 4 before it guards any output', async () => {
    const out: string[] = []
    expect(await main(['--port', '0'], {}, (t) => out.push(t))).toBe(4)
    expect(out).toEqual(['usage: echo --port <1-65535> --token-file <path>\n'])
  })
})
