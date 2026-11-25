// Model servers step 1 (D2, D3): a local agent's profile names a model server (an entry of
// <mesh dir>/mesh/servers.json) instead of holding baseUrl and apiKey. The agent resolves it
// when it starts, refuses a profile with both or neither, stops at the gate when the entry
// changes or goes, and an inline profile's agent never reads servers.json. Real loopback HTTP
// against an in-process fake backend, in scratch mesh and home folders. No model.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startAgent } from '../src/agent.js'
import type { Agent, AgentName } from '../src/agent.js'
import { CODE_EXTENSION } from '../src/skills.js'

const TOKEN = 'e5'.repeat(32)
const API_KEY = 'server-key-planted-Q7'
const SOURCE = 'tests/retry.ts'

let backend: Server
let backendUrl: string
let seen: IncomingHttpHeaders[]
const made: string[] = []
const stops: Array<() => Promise<void>> = []

beforeEach(async () => {
  seen = []
  backend = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(req.headers)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"remove":[],"keep":[],"suggest":[]}' } }] }))
    })
  })
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
})

afterEach(async () => {
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text)
  chmodSync(path, mode)
}
const servers = (dir: string, list: Record<string, unknown>, mode = 0o600): void =>
  privateFile(join(dir, 'mesh', 'servers.json'), JSON.stringify({ schema: 1, servers: list }), mode)
const profile = (dir: string, agent: AgentName, body: Record<string, unknown>): void =>
  privateFile(join(dir, 'mesh', 'wrappers', `${agent}.json`), JSON.stringify({ _about: 'test', start: ['/usr/bin/false'], ...body }))

/** A scratch mesh dir with the agent switched on and its token; the profile is the caller's. */
async function home(agent: AgentName): Promise<{ dir: string; port: number; skill: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-servers-agent-'))
  made.push(dir)
  const port = await freePort()
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { [agent]: { endpoint: `http://127.0.0.1:${port}`, profile: agent } } }))
  privateFile(join(dir, 'mesh', 'tokens', agent), `${TOKEN}\n`)
  const skill = join(dir, 'skill')
  mkdirSync(skill)
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: unslop\ndescription: x\n---\n')
  writeFileSync(join(skill, 'rules.md'), '# Rules\n')
  return { dir, port, skill }
}

async function agent(dir: string, name: AgentName): Promise<Agent & { tick: () => void }> {
  const fns: Array<() => void> = []
  const a = await startAgent({
    meshDir: dir, profile: name, env: { BOX_KEY: API_KEY, OTHER_KEY: 'other-key-value', HOME: dir, AGENT_INBOX_MESH_DIR: dir },
    every: (_ms, fn) => { fns.push(fn); return () => fns.splice(fns.indexOf(fn), 1) },
  })
  stops.push(() => a.stop('signal'))
  return { ...a, tick: () => fns.forEach((fn) => fn()) }
}

function rpc(port: number, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { authorization: `Bearer ${TOKEN}`, 'a2a-version': '1.0', 'content-type': 'application/json' } }, (res) => {
      let raw = ''
      res.setEncoding('utf8').on('data', (c: string) => { raw += c }).on('end', () => resolve(JSON.parse(raw)))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  })
}
async function cleanOne(port: number): Promise<void> {
  const file = { path: SOURCE, text: 'export const a = 1 // one\n', added: [1] }
  const sent = await rpc(port, 'SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ data: { files: [file] }, mediaType: 'application/json' }], metadata: { [CODE_EXTENSION]: {} } } })
  const id = sent.result.task.id as string
  for (let i = 0; i < 300; i++) {
    const task = (await rpc(port, 'GetTask', { id })).result
    if (!['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('task did not finish')
}
const settled = async (p: Promise<unknown>): Promise<boolean> => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 20))])

describe('a profile that names a model server (model servers D2, D3)', () => {
  it('unslop-code starts from the server entry and sends its key to its address', async () => {
    const { dir, port } = await home('unslop-code')
    servers(dir, { box: { baseUrl: backendUrl, apiKey: { env: 'BOX_KEY' } } })
    profile(dir, 'unslop-code', { server: 'box', model: 'coder-next' })
    await agent(dir, 'unslop-code')
    await cleanOne(port)
    expect(seen.length).toBeGreaterThan(0)
    for (const headers of seen) expect(headers.authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('unslop starts from the server entry too, keeping its skill and other keys', async () => {
    const { dir, port, skill } = await home('unslop')
    servers(dir, { box: { baseUrl: backendUrl } })
    profile(dir, 'unslop', { skill, server: 'box', model: 'chat-long', terms: ['Acme'] })
    const a = await agent(dir, 'unslop')
    expect(a.port).toBe(port)
  })

  it('refuses a profile with both or neither, naming the profile and the rule and never a value', async () => {
    for (const agentName of ['unslop', 'unslop-code'] as const) {
      const { dir, skill } = await home(agentName)
      servers(dir, { box: { baseUrl: backendUrl, apiKey: { env: 'BOX_KEY' } } })
      const base = agentName === 'unslop' ? { skill } : {}
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ server: 'box', baseUrl: 'https://planted.example' }, new RegExp(`^the ${agentName} profile holds both \`server\` and an inline \`baseUrl\` or \`apiKey\``)],
        [{ server: 'box', apiKey: { env: 'PLANTED_ENV' } }, /holds both `server` and an inline/],
        [{ model: 'x' }, new RegExp(`^the ${agentName} profile needs a \`baseUrl\` or a \`server\`$`)],
        [{ server: 'Planted Name!' }, new RegExp(`^the ${agentName} profile's \`server\` is not a server name$`)],
        [{ server: 'gone' }, /^the profile names the server gone, which mesh\/servers\.json does not hold: run meshctl server list$/],
      ]
      for (const [body, words] of cases) {
        profile(dir, agentName, { ...base, ...body })
        const error = await agent(dir, agentName).then(() => undefined, (e: Error) => e)
        expect(error?.message, JSON.stringify(body)).toMatch(words)
        expect(error?.message).not.toMatch(/planted|PLANTED|127\.0\.0\.1/)
      }
    }
  })

  it('refuses a missing or refused servers.json, naming the server and the reason only', async () => {
    const { dir } = await home('unslop-code')
    profile(dir, 'unslop-code', { server: 'box' })
    await expect(agent(dir, 'unslop-code')).rejects.toThrow(/^the profile names the server box, but mesh\/servers\.json is missing: run meshctl server add box$/)
    servers(dir, { box: { baseUrl: 'https://planted.example' } }, 0o644)
    await expect(agent(dir, 'unslop-code')).rejects.toThrow(/^the profile names the server box, but mesh\/servers\.json is not a file you own that only you can read: run meshctl server list$/)
    servers(dir, { box: { baseUrl: 'https://planted.example', apiKey: 'sk-planted' } })
    const error = await agent(dir, 'unslop-code').then(() => undefined, (e: Error) => e)
    expect(error?.message).toBe('the profile names the server box, but mesh/servers.json holds a bad apiKey: run meshctl server list')
  })

  it('the gate stops it with "server" when its entry changes or goes, and not when another entry or nothing changes', async () => {
    const changes: Array<[string, (dir: string) => void]> = [
      ['address', (dir) => servers(dir, { box: { baseUrl: `${backendUrl}/v2`, apiKey: { env: 'BOX_KEY' } }, other: { baseUrl: 'https://other.example' } })],
      ['key source', (dir) => servers(dir, { box: { baseUrl: backendUrl, apiKey: { env: 'OTHER_KEY' } }, other: { baseUrl: 'https://other.example' } })],
      ['key removed', (dir) => servers(dir, { box: { baseUrl: backendUrl }, other: { baseUrl: 'https://other.example' } })],
      ['entry gone', (dir) => servers(dir, { other: { baseUrl: 'https://other.example' } })],
      ['file gone', (dir) => unlinkSync(join(dir, 'mesh', 'servers.json'))],
      ['file refused', (dir) => chmodSync(join(dir, 'mesh', 'servers.json'), 0o644)],
    ]
    for (const [what, change] of changes) {
      const { dir } = await home('unslop-code')
      servers(dir, { box: { baseUrl: backendUrl, apiKey: { env: 'BOX_KEY' } }, other: { baseUrl: 'https://other.example' } })
      profile(dir, 'unslop-code', { server: 'box' })
      const a = await agent(dir, 'unslop-code')
      // the same entry written again, and another server changed: it keeps running
      servers(dir, { box: { baseUrl: backendUrl, apiKey: { env: 'BOX_KEY' } }, other: { baseUrl: 'https://moved.example' } })
      a.tick()
      expect(await settled(a.exited), what).toBe(false)
      change(dir)
      a.tick()
      expect(await a.exited, what).toBe('server')
    }
  })

  it('an inline profile\'s agent never reads servers.json: one that would be refused changes nothing', async () => {
    for (const agentName of ['unslop', 'unslop-code'] as const) {
      const { dir, skill } = await home(agentName)
      // refused three ways at once: open to others, not JSON, and a key that is a string
      privateFile(join(dir, 'mesh', 'servers.json'), '{ not json "sk-planted"', 0o644)
      profile(dir, agentName, { ...(agentName === 'unslop' ? { skill } : {}), baseUrl: backendUrl, apiKey: { env: 'BOX_KEY' } })
      const a = await agent(dir, agentName)
      a.tick()
      expect(await settled(a.exited), agentName).toBe(false)
      if (agentName === 'unslop-code') {
        await cleanOne(a.port)
        expect(seen.at(-1)?.authorization).toBe(`Bearer ${API_KEY}`)
      }
      // and a server-naming profile with the same file is refused
      profile(dir, agentName, { ...(agentName === 'unslop' ? { skill } : {}), server: 'box' })
      await a.stop('signal')
      await expect(agent(dir, agentName)).rejects.toThrow(/mesh\/servers\.json is not a file you own/)
    }
  })
})
