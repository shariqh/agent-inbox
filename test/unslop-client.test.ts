// `meshctl unslop`, the unslop agent's client (#483, unslop design §4.3-§4.5,
// §6.3, §7.3, U3b). End to end against the real agent (packages/mesh's source,
// run through tsx so the root suite needs no packages/mesh build) with a fake
// OpenAI-compatible backend on loopback, plus off test (f), the card check and
// the terminal rule. Every non-zero exit is checked for an empty stdout.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runUnslop } from '../src/unslop-client.js'
import type { UnslopIo } from '../src/unslop-client.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const TSX = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const WRAP = join(REPO, 'packages', 'mesh', 'src', 'wrap.ts')
const TOKEN = 'b2'.repeat(32)
const EXT = 'urn:agent-inbox:ext:unslop:v1'
const INPUT = 'See https://example.com/docs for v2.5.0. It does not ship today, and it is really very important.\n'
const EDITED = INPUT.replace(' really very', '')

type Mode = 'edit' | 'same' | 'length' | '503' | 'hold' | 'slow'
let mode: Mode
let backend: Server
let backendUrl: string
let backendCalls: Array<{ closed: Promise<void> }>
const servers: Server[] = []
const children: ChildProcess[] = []
let spawns = 0
const spy = ((...args: Parameters<typeof spawn>) => {
  spawns++
  const child = spawn(...args)
  children.push(child)
  return child
}) as typeof spawn

beforeEach(async () => {
  mode = 'edit'
  spawns = 0
  backendCalls = []
  backend = createServer((req, res) => {
    const chunks: Buffer[] = []
    backendCalls.push({ closed: new Promise((done) => res.on('close', () => done())) })
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (mode === 'hold') return
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ content: string }> }
      const text = /TEXT \w+ BEGIN\n([\s\S]*)\nTEXT \w+ END/.exec(body.messages[1]!.content)![1]!
      if (mode === '503') return void res.writeHead(503).end('{}')
      const reply = (): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason: mode === 'length' ? 'length' : 'stop', message: { role: 'assistant', content: mode === 'same' ? text : text.replace(' really very', '') } }],
      }))
      if (mode === 'slow') setTimeout(reply, 600)
      else reply()
    })
  })
  servers.push(backend)
  backendUrl = `http://127.0.0.1:${await listen(backend)}`
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((done) => child.once('exit', done))
    try { process.kill(-child.pid!, 'SIGTERM') } catch { /* gone */ }
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise((done) => server.close(done))
  }
  removeScratchDirs()
})

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

async function freePort(): Promise<number> {
  const s = createServer()
  const port = await listen(s)
  await new Promise((done) => s.close(done))
  return port
}

function privateFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, text)
  chmodSync(path, 0o600)
}

/** A mesh dir as `meshctl enable --unslop` leaves it, with the profile filled in. */
function meshHome(endpoint: string | null, profile: Record<string, unknown> = {}): string {
  const dir = scratchDir('unslop-client-')
  const skill = join(dir, 'skill')
  mkdirSync(skill)
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: unslop\ndescription: x\n---\n')
  writeFileSync(join(skill, 'rules.md'), '# Rules\nCut filler words.\n')
  if (endpoint !== null) writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint, profile: 'unslop' } } }))
  privateFile(join(dir, 'mesh', 'tokens', 'unslop'), `${TOKEN}\n`)
  privateFile(join(dir, 'mesh', 'wrappers', 'unslop.json'), JSON.stringify({
    skill, baseUrl: backendUrl, start: [process.execPath, '--import', TSX, WRAP, '--agent', 'openai-compatible', '--profile', 'unslop'], ...profile,
  }))
  return dir
}

async function run(dir: string, args: string[], input: string | Buffer = INPUT, extra: Partial<UnslopIo> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runUnslop(args, {
    env: { AGENT_INBOX_MESH_DIR: dir, PATH: process.env['PATH'] }, home: '/nonexistent-home', stdin: Readable.from([Buffer.from(input)]),
    out: (text) => out.push(text), err: (text) => err.push(text), spawn: spy, pollMs: 100, ...extra,
  })
  const r = { code, out: out.join(''), err: err.join('') }
  if (code !== 0) expect(r.out, `stdout must be empty on exit ${code}: ${r.err}`).toBe('')
  return r
}

/** A listener that counts every connection and answers none. */
async function counting(): Promise<{ port: number; count: () => number }> {
  let n = 0
  const server = createNetServer((socket) => { n++; socket.destroy() })
  const port = await listen(server)
  servers.push(server as unknown as Server)
  return { port, count: () => n }
}

describe('off means off (unslop design §4.5 f)', () => {
  it('without agents.unslop, or with a non-loopback endpoint, it spawns nothing, connects nowhere and exits 14', async () => {
    const c = await counting()
    const on = `http://127.0.0.1:${c.port}`
    const cases: Array<[string, (dir: string) => void]> = [
      ['no mesh.json', () => {}],
      ['no key', (dir) => writeFileSync(join(dir, 'mesh.json'), '{"schema":1,"agents":{"other":{}}}')],
      ['newer schema', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 2, agents: { unslop: { endpoint: on } } }))],
      ['symlink', (dir) => {
        writeFileSync(join(dir, 'real.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint: on } } }))
        symlinkSync(join(dir, 'real.json'), join(dir, 'mesh.json'))
      }],
      ['localhost', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint: `http://localhost:${c.port}` } } }))],
      ['0.0.0.0', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint: `http://0.0.0.0:${c.port}` } } }))],
      ['https', (dir) => writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { unslop: { endpoint: `https://127.0.0.1:${c.port}` } } }))],
    ]
    for (const [name, write] of cases) {
      const dir = meshHome(null)
      write(dir)
      const r = await run(dir, ['--kind', 'pr'])
      expect([name, r.code], r.err).toEqual([name, 14])
      expect(r.err).toMatch(/^unslop: off: /)
    }
    // a refused kind or an oversize draft is refused before the switch is even read
    const dir = meshHome(on)
    expect((await run(dir, ['--kind', 'email'])).code).toBe(11)
    expect((await run(dir, ['--kind', 'pr'], 'x'.repeat(12 * 1024 + 1))).code).toBe(11)
    expect((await run(dir, ['--kind', 'pr'], Buffer.from([0x66, 0xff, 0xfe]))).code).toBe(11)
    expect((await run(dir, ['--kind'])).code).toBe(4)
    expect((await run(dir, ['--kind', 'pr', '--in', dir])).code).toBe(4)
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(12 * 1024 + 1))
    expect((await run(dir, ['--kind', 'pr', '--in', join(dir, 'big.md')])).code).toBe(11)
    expect([spawns, c.count()]).toEqual([0, 0])
  })

  it('never reads a terminal: a TTY on stdin is a usage error, and the source never names /dev/tty', async () => {
    const c = await counting()
    const r = await run(meshHome(`http://127.0.0.1:${c.port}`), ['--kind', 'pr'], '', { stdin: Object.assign(Readable.from([]), { isTTY: true }) })
    expect([r.code, c.count()]).toEqual([4, 0])
    expect(r.err).toContain('never reads a terminal')
    for (const file of ['src/unslop-client.ts', 'src/meshctl.ts']) expect(readFileSync(join(REPO, file), 'utf8')).not.toMatch(/\/dev\/tty|setRawMode|node:readline|node:tty/)
  })

  it.skipIf(!['darwin', 'linux'].includes(process.platform))('under a pseudo-terminal the CLI exits without waiting on the terminal', () => {
    const dir = meshHome(null)
    const cli = [process.execPath, '--import', TSX, join(REPO, 'src', 'meshctl.ts'), 'unslop', '--kind', 'pr']
    const quoted = (argv: string[]): string => argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ')
    const pty = (command: string) => spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', command] : ['-qec', command, '/dev/null'],
      { env: { PATH: process.env['PATH'], AGENT_INBOX_MESH_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
    const tty = pty(`${quoted(cli)}; echo "exit=$?"`)
    expect(tty.error).toBeUndefined()
    expect(tty.stdout).toContain('never reads a terminal')
    expect(tty.stdout).toContain('exit=4')
    // stdin piped while stdout and stderr stay on the terminal, as in an assistant's shell
    const piped = pty(`printf 'draft' | ${quoted(cli)}; echo "exit=$?"`)
    expect(piped.stdout).toContain('unslop: off:')
    expect(piped.stdout).toContain('exit=14')
  }, 40_000)
})

describe('the card check (design §4.4)', () => {
  it('a card without the skill, A2A 1.0 or the api-1 extension is exit 14, and no text is sent', async () => {
    const good = {
      skills: [{ id: 'unslop' }], supportedInterfaces: [{ url: 'x', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { extensions: [{ uri: EXT, params: { api: 1 } }] },
    }
    const variants: Array<[string, unknown]> = [
      ['no unslop skill', { ...good, skills: [{ id: 'other' }] }],
      ['no A2A 1.0', { ...good, supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] }],
      ['no urn:agent-inbox', { ...good, capabilities: { extensions: [] } }],
      ['api is not 1', { ...good, capabilities: { extensions: [{ uri: EXT, params: { api: 2 } }] } }],
    ]
    let card: unknown
    let posts = 0
    const fake = createServer((req, res) => {
      if (req.method === 'POST') posts++
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card))
    })
    servers.push(fake)
    const dir = meshHome(`http://127.0.0.1:${await listen(fake)}`)
    for (const [words, variant] of variants) {
      card = variant
      const r = await run(dir, ['--kind', 'pr'])
      expect(r.code).toBe(14)
      expect(r.err).toContain(words)
      expect(r.err).toContain('rebuild packages/mesh')
    }
    card = '<html>'
    expect((await run(dir, ['--kind', 'pr'])).err).toContain('rebuild packages/mesh')
    expect([posts, spawns]).toEqual([0, 0])
  })
})

describe('end to end against the agent (design §6.3, §7.3)', () => {
  it('starts the agent on demand, prints the edit on exit 0 with a 0600 report, and the next call reuses it', async () => {
    const dir = meshHome(`http://127.0.0.1:${await freePort()}`)
    const report = join(dir, 'report.json')
    const first = await run(dir, ['--kind', 'pr', '--report', report])
    expect(first.code, first.err).toBe(0)
    expect(first.out).toBe(EDITED)
    expect(first.err).toContain('starting the agent')
    expect(first.err).toMatch(/rewritten by chat-long \(attempts: 1, rules [0-9a-f]{12}\)/)
    expect((lstatSync(report).mode & 0o777).toString(8)).toBe('600')
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ code: 0, status: 'rewritten', model: 'chat-long', attempts: 1, hard: expect.any(Object), ms: expect.any(Object) })
    expect(readFileSync(join(dir, 'mesh', 'logs', 'unslop-agent.log'), 'utf8')).toContain('unslop listening')
    expect((lstatSync(join(dir, 'mesh', 'logs', 'unslop-agent.log')).mode & 0o777).toString(8)).toBe('600')

    mode = 'same'
    writeFileSync(join(dir, 'draft.md'), INPUT)
    const second = await run(dir, ['--kind', 'docs', '--report', report, '--in', join(dir, 'draft.md')], '')
    expect([second.code, second.out]).toEqual([0, INPUT])
    expect(second.err).not.toContain('starting the agent')
    expect(JSON.parse(readFileSync(report, 'utf8')).status).toBe('unchanged')
    expect(spawns).toBe(1)

    // a symlinked report is refused before anything is sent
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'link.json'))
    const calls = backendCalls.length
    expect((await run(dir, ['--kind', 'pr', '--report', join(dir, 'link.json')])).code).toBe(4)
    expect(backendCalls.length).toBe(calls)
  }, 40_000)

  it('kept-original is 10, a screen refusal 11 and a backend 5xx busy (12), each with an empty stdout', async () => {
    const dir = meshHome(`http://127.0.0.1:${await freePort()}`)
    const report = join(dir, 'report.json')
    mode = 'length'
    const kept = await run(dir, ['--kind', 'pr', '--report', report])
    expect(kept.code, kept.err).toBe(10)
    expect(kept.err).toContain('kept the original (truncated)')
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({ code: 10, status: 'kept-original' })

    const calls = backendCalls.length
    const refused = await run(dir, ['--kind', 'pr'], 'Hi Jane,\n\nThe fix ships today.\n\nThanks,\nSam\n')
    expect(refused.code).toBe(11)
    expect(refused.err).toContain('refused (screen: letter-shape)')
    expect(backendCalls.length).toBe(calls)

    mode = '503'
    const busy = await run(dir, ['--kind', 'pr'])
    expect(busy.code).toBe(12)
    expect(busy.err).toMatch(/busy \(backend-5xx\): try again in about 60 s, or edit it in-session/)
    expect(spawns).toBe(1)
  }, 40_000)

  it('falls back to GetTask when the stream drops, and completes', async () => {
    // the agent serves its own mesh dir; the caller's endpoint is a proxy that cuts the stream after its first chunk
    const agentPort = await freePort()
    const agentDir = meshHome(`http://127.0.0.1:${agentPort}`)
    mode = 'same'
    expect((await run(agentDir, ['--kind', 'pr'])).code).toBe(0)
    const methods: string[] = []
    const proxy = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const method = body.length ? String(JSON.parse(body.toString()).method) : 'card'
        methods.push(method)
        const up = request({ host: '127.0.0.1', port: agentPort, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: `127.0.0.1:${agentPort}` } }, (upRes) => {
          res.writeHead(upRes.statusCode!, { 'content-type': String(upRes.headers['content-type']) })
          if (method !== 'SendStreamingMessage') return void upRes.pipe(res)
          upRes.once('data', (chunk: Buffer) => {
            res.write(chunk)
            setTimeout(() => { upRes.destroy(); res.destroy() }, 50)
          })
        })
        up.end(body)
      })
    })
    servers.push(proxy)
    const dir = meshHome(`http://127.0.0.1:${await listen(proxy)}`)
    copyFileSync(join(agentDir, 'mesh', 'tokens', 'unslop'), join(dir, 'mesh', 'tokens', 'unslop'))
    mode = 'slow'
    const r = await run(dir, ['--kind', 'pr'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toBe(EDITED)
    expect(r.err).toContain('the stream dropped')
    expect(methods).toContain('GetTask')
    expect(spawns).toBe(1)
  }, 40_000)

  it('on its deadline it cancels the task, which stops the backend call, and exits 13', async () => {
    const dir = meshHome(`http://127.0.0.1:${await freePort()}`)
    mode = 'hold'
    const r = await run(dir, ['--kind', 'pr', '--timeout', '60'], INPUT, { deadlineMs: 2000 })
    expect(r.code).toBe(13)
    expect(r.err).toContain('no result within 60 s; the task was cancelled')
    expect(backendCalls).toHaveLength(1)
    // CancelTask aborts the agent's backend request
    await expect(Promise.race([backendCalls[0]!.closed.then(() => 'closed'), new Promise((done) => setTimeout(() => done('open'), 5000))])).resolves.toBe('closed')
  }, 40_000)
})
