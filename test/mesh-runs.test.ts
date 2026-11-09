// Run records (cards view V5 §5.3-§5.6, §8 slice V5a): the meshctl entry appends one record
// per client run under <mesh dir>/mesh/runs/. Real temp dirs, real child processes for the
// signals and the concurrent appends, fake agents on loopback; no fs mocks.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runClient, runMeshctl } from '../src/meshctl.js'
import { appendRun } from '../src/mesh-runs.js'
import type { RunCollector } from '../src/mesh-runs.js'
import { requestKey } from '../src/request-post-client.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

type Json = Record<string, any>
const REPO = new URL('..', import.meta.url).pathname
const TSX = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const MESHCTL = join(REPO, 'src', 'meshctl.ts')
const FIX = join(REPO, 'test', 'fixtures', 'a2a-request-post')
const fixture = (rel: string): Json => JSON.parse(readFileSync(join(FIX, rel), 'utf8'))
const UNSLOP_CARD = {
  name: 'unslop', skills: [{ id: 'unslop' }], supportedInterfaces: [{ url: 'http://127.0.0.1/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { extensions: [{ uri: 'urn:agent-inbox:ext:unslop:v1', params: { api: 1 } }] },
}
// each input carries its own canary; none may reach a runs file (§5.5)
const C = {
  draft: 'canary-draft-q1', brief: 'canary-brief-q2', title: 'canary-title-q3', url: 'https://canary-url-q4.example/x', page: 'https://www.notion.so/canary-page-q5',
  human: 'canary-human-q6', failure: 'canary-failure-q7', detail: 'canary-detail-q8', error: 'canary-error-q9',
}

const servers: Server[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise((done) => s.close(done))
  }
  removeScratchDirs()
})

async function serve(onPost: (body: Json, res: ServerResponse) => void, card: unknown): Promise<{ port: number; posted: Promise<void> }> {
  let posted!: () => void
  const seen = new Promise<void>((done) => { posted = done })
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card))
      posted()
      onPost(JSON.parse(Buffer.concat(chunks).toString('utf8')), res)
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { port: (server.address() as AddressInfo).port, posted: seen }
}

/** A fake unslop agent: one working event, then (after 120 ms) the final task, or nothing ('hold'). */
const unslopAgent = (final: { state: string; data: Json } | 'hold', card: unknown = UNSLOP_CARD) => serve((body, res) => {
  const event = (task: Json): void => void res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task } })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  event({ id: 'task-7', status: { state: 'TASK_STATE_WORKING' } })
  if (final === 'hold') return
  setTimeout(() => {
    const done = final.state === 'TASK_STATE_COMPLETED'
    event({
      id: 'task-7', status: { state: final.state, ...(done ? {} : { message: { parts: [{ text: 'no' }, { data: final.data }] } }) },
      ...(done ? { artifacts: [{ parts: [{ text: `edited ${C.draft}` }, { data: final.data }] }] } : {}),
    })
    res.end()
  }, 120)
}, card)

/** A fake request-post service answering with `data` (or an R1 fixture's response). */
const requestPostService = (answer: (body: Json) => Json, card: unknown = fixture('card.json')) => serve((body, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...answer(body), id: body.id }))
}, card)
const completed = (data: Json): Json => ({ jsonrpc: '2.0', result: { task: { id: 't', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'ok' }, { data }] }] } } })
const rejected = (data: Json): Json => ({ jsonrpc: '2.0', result: { task: { id: 't', status: { state: 'TASK_STATE_REJECTED', message: { parts: [{ text: `no ${C.error}` }, { data }] } } } } })

function privateFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, text)
  chmodSync(path, 0o600)
}

/** A mesh dir as enable --apply leaves it, with `agents` as given. */
function meshHome(agents: Json): string {
  const dir = scratchDir('runs-')
  writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents }))
  privateFile(join(dir, 'mesh', 'tokens', 'unslop'), `${'u'.repeat(64)}\n`)
  privateFile(join(dir, 'mesh', 'tokens', 'request-post'), `${'r'.repeat(40)}\n`)
  return dir
}

async function client(command: 'unslop' | 'request-post', dir: string, args: string[], input = 'x', o: { out?: (t: string) => void } = {}) {
  const out: string[] = []
  const err: string[] = []
  const before = Date.now()
  const code = await runClient(command, args, {
    env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', stdin: Readable.from([Buffer.from(input)]),
    out: o.out ?? ((t) => out.push(t)), err: (t) => err.push(t),
  })
  return { code, out: out.join(''), err: err.join(''), before, after: Date.now() }
}

const runsDir = (dir: string): string => join(dir, 'mesh', 'runs')
/** Every byte under runs/, every file's name included. */
function runBytes(dir: string): string {
  if (!existsSync(runsDir(dir))) return ''
  return readdirSync(runsDir(dir)).map((name) => `${name}\n${lstatSync(join(runsDir(dir), name)).isFile() ? readFileSync(join(runsDir(dir), name), 'latin1') : ''}`).join('\n')
}
function records(dir: string): Json[] {
  if (!existsSync(runsDir(dir))) return []
  return readdirSync(runsDir(dir)).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(runsDir(dir), n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}
const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const daysAgo = (n: number): string => { const d = new Date(); return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime()) }
const COMMON = ['v', 'id', 'agent', 'op', 'at', 'ms', 'exit', 'outcome']

describe('unslop: one record per exit (§5.3, §5.4)', () => {
  const RESULT = {
    rulesSha256: '3f9a1c0e7b22'.padEnd(64, '0'), model: 'chat-long', attempts: 1, hard: {}, ms: { queued: 1, load: 0, model: 90, check: 4 },
    warnings: [{ class: 'may', detail: C.detail }], failures: [{ class: 'numbers', kind: 'lost', lost: [C.failure], added: [] }],
  }
  const cases: Array<[string, { state: string; data: Json } | null, number, Json]> = [
    ['rewritten', { state: 'TASK_STATE_COMPLETED', data: { ...RESULT, code: 0, status: 'rewritten' } }, 0,
      { outcome: 'ok', status: 'rewritten', attempts: 1, model: 'chat-long', rules: '3f9a1c0e7b22', timing: { queued: 1, load: 0, model: 90, check: 4 }, warnings: ['may'], task: 'task-7' }],
    ['kept', { state: 'TASK_STATE_COMPLETED', data: { ...RESULT, code: 10, status: 'kept-original', reason: 'fidelity' } }, 10, { outcome: 'kept-original', reason: 'fidelity', status: 'kept-original' }],
    ['screen', { state: 'TASK_STATE_REJECTED', data: { ...RESULT, code: 11, status: 'rejected', reason: 'screen', screen: ['email', 'customer-path'] } }, 11,
      { outcome: 'refused', reason: 'screen', classes: ['email', 'customer-path'] }],
    ['busy', { state: 'TASK_STATE_REJECTED', data: { code: 12, status: 'busy', reason: 'queue-full', retryAfterMs: 1 } }, 12, { outcome: 'busy', reason: 'queue-full', status: 'busy' }],
    ['failed', { state: 'TASK_STATE_FAILED', data: { ...RESULT, code: 13, status: 'failed', reason: 'unreachable' } }, 13, { outcome: 'failed', reason: 'unreachable' }],
    ['card mismatch', null, 14, { outcome: 'unavailable' }],
  ]
  for (const [name, final, exit, fields] of cases) {
    it(`${name}: exit ${exit}, one record with the end time and the duration, no text`, async () => {
      const agent = await unslopAgent(final ?? 'hold', final ? UNSLOP_CARD : { ...UNSLOP_CARD, capabilities: {} })
      const dir = meshHome({ unslop: { endpoint: `http://127.0.0.1:${agent.port}` } })
      const draft = `A public draft about ${C.draft}.\n`
      const r = await client('unslop', dir, ['--kind', 'docs', '--report', join(scratchDir('report-'), 'r.json')], draft)
      expect(r.code, r.err).toBe(exit)
      const [rec, ...more] = records(dir)
      expect(more).toEqual([])
      expect(rec).toMatchObject({ v: 1, agent: 'unslop', op: 'docs', exit, bytesIn: Buffer.byteLength(draft), ...fields })
      expect(Object.keys(rec!)).toEqual(expect.arrayContaining(COMMON))
      expect(rec!.id).toMatch(/^[a-z2-7]{10}$/)
      const at = Date.parse(rec!.at)
      expect(at).toBeGreaterThanOrEqual(r.before)
      expect(at).toBeLessThanOrEqual(r.after)
      expect(at - rec!.ms).toBeGreaterThanOrEqual(r.before)
      if (final) expect(rec!.ms).toBeGreaterThanOrEqual(100)
      expect(readdirSync(runsDir(dir))).toEqual([`unslop-${localDate(at)}.jsonl`])
      expect(mode(runsDir(dir))).toBe('700')
      expect(mode(join(runsDir(dir), readdirSync(runsDir(dir))[0]!))).toBe('600')
      const bytes = runBytes(dir)
      for (const canary of [C.draft, C.failure, C.detail, 'canary', 'u'.repeat(16)]) expect(bytes).not.toContain(canary)
    })
  }

  it('an internal error after the key is armed exits 13 with one failed/internal record', async () => {
    const agent = await unslopAgent({ state: 'TASK_STATE_COMPLETED', data: { ...RESULT, code: 0, status: 'unchanged' } })
    const dir = meshHome({ unslop: { endpoint: `http://127.0.0.1:${agent.port}` } })
    const r = await client('unslop', dir, ['--kind', 'pr'], 'draft', { out: () => { throw new Error('boom') } })
    expect([r.code, r.err.split('\n').at(-2)]).toEqual([13, 'unslop: failed (internal error). Edit it in-session.'])
    expect(records(dir)).toEqual([expect.objectContaining({ op: 'pr', exit: 13, outcome: 'failed', reason: 'internal', status: 'unchanged' })])
  })
})

describe('request-post: one record per exit, and never a key, title or URL (§5.4, §5.5)', () => {
  const FILE = ['file', '--brand', 'example-brand', '--channels', 'x-standalone,blog', '--title', C.title, '--slug', 'canary-slug-q10', '--source-url', C.url]
  const fixtureData = (rel: string): Json => { const t = fixture(rel).response.result.task; return (t.artifacts?.[0] ?? t.status.message).parts.find((p: Json) => p.data).data }
  const cases: Array<[string, string[], Json, number, Json]> = [
    ['filed', FILE, completed({ ...fixtureData('file/02-created-social.json'), url: C.page, pageId: C.page }), 0,
      { op: 'file', outcome: 'ok', created: true, phase: 'queued', channels: ['x-standalone', 'blog'], brand: 'example-brand' }],
    ['refused fields', FILE, rejected(fixtureData('file/04-refused-invalid.json')), 11, { outcome: 'refused', reason: 'invalid', fields: ['category', 'sourceUrl'] }],
    ['refused screen', FILE, rejected(fixtureData('file/05-refused-screen.json')), 11, { outcome: 'refused', reason: 'screen', classes: ['letter-shape', 'private-address'] }],
    ['busy', FILE, rejected(fixtureData('file/06-busy.json')), 12, { outcome: 'busy', reason: 'daily-budget' }],
    ['outcome unknown', FILE, { jsonrpc: '2.0', result: { task: { id: 't', status: { state: 'TASK_STATE_FAILED', message: { parts: [{ data: fixtureData('file/07-uncertain.json') }] } } } } }, 13,
      { outcome: 'unknown', reason: 'create-timeout' }],
    ['conflict', FILE, rejected({ ...fixtureData('file/08-conflict.json'), conflict: { url: C.page, phase: 'drafting' } }), 16, { outcome: 'conflict', reason: 'conflict' }],
    ['status', ['status', '--key', 'acme-secret-x'], completed({ ...fixtureData('status/awaiting-go.json'), humanAction: C.human, error: { text: C.error } }), 0,
      { op: 'status', outcome: 'ok', phase: 'awaiting-go' }],
  ]
  for (const [name, args, answer, exit, fields] of cases) {
    it(`${name}: exit ${exit}`, async () => {
      const service = await requestPostService(() => answer)
      const dir = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${service.port}` } })
      const r = await client('request-post', dir, args, `The brief ${C.brief}\n`)
      expect(r.code, r.err).toBe(exit)
      const [rec, ...more] = records(dir)
      expect(more).toEqual([])
      expect(rec).toMatchObject({ v: 1, agent: 'request-post', exit, ...fields })
      if (exit !== 0) expect(rec).not.toHaveProperty('brand')
      if (exit !== 0) expect(rec).not.toHaveProperty('channels')
      expect(Object.keys(rec!).filter((k) => !COMMON.includes(k)).every((k) => ['reason', 'classes', 'phase', 'created', 'throughGo', 'channels', 'brand', 'fields'].includes(k))).toBe(true)
      const bytes = runBytes(dir)
      for (const canary of ['canary', 'acme', 'notion', 'http', 'r'.repeat(16)]) expect(bytes, canary).not.toContain(canary)
      // a derived key leaves no 8-character run of itself, nor does the key the service echoes
      const derived = requestKey({ brand: 'example-brand', channels: ['x-standalone', 'blog'], title: C.title, slug: 'canary-slug-q10', sourceUrl: C.url })
      for (const key of [derived, 'orl6k5iwi7vpgauxx4btsaikxb']) {
        for (let i = 0; i + 8 <= key.length; i++) expect(bytes).not.toContain(key.slice(i, i + 8))
      }
    })
  }

  it('file --key acme-secret-x leaves no acme; a refused brand or channel is not kept, a card mismatch is unavailable', async () => {
    const service = await requestPostService(() => rejected({ code: 11, status: 'rejected', reason: 'invalid', fields: ['brand', 'channels'] }))
    const dir = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${service.port}` } })
    expect((await client('request-post', dir, ['file', '--brand', 'acme-typo', '--channels', 'linkedin', '--title', 't', '--key', 'acme-secret-x'], 'brief')).code).toBe(11)
    const bad = await requestPostService(() => ({}), { ...fixture('card.json'), skills: [] })
    const off = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${bad.port}` } })
    expect((await client('request-post', off, ['status', '--key', 'acme-secret-x'])).code).toBe(15)
    expect(records(dir)).toEqual([expect.objectContaining({ op: 'file', outcome: 'refused', fields: ['brand', 'channels'] })])
    expect(records(off)).toEqual([expect.objectContaining({ op: 'status', exit: 15, outcome: 'unavailable' })])
    for (const d of [dir, off]) expect(runBytes(d)).not.toMatch(/acme|linkedin/)
  })

  it('a missing token with the key present is 14 and unavailable; an internal error is failed/internal', async () => {
    const service = await requestPostService(() => completed(fixtureData('status/queued.json')))
    const dir = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${service.port}` } })
    const r = await client('request-post', dir, ['status', '--page-id', 'p1'], 'x', { out: () => { throw new Error('boom') } })
    expect(r.code).toBe(13)
    chmodSync(join(dir, 'mesh', 'tokens', 'request-post'), 0o644)
    expect((await client('request-post', dir, ['status', '--page-id', 'p1'])).code).toBe(14)
    expect(records(dir)).toEqual([
      expect.objectContaining({ op: 'status', exit: 13, outcome: 'failed', reason: 'internal', phase: 'queued' }),
      expect.objectContaining({ op: 'status', exit: 14, outcome: 'unavailable' }),
    ])
  })
})

describe('off and usage write nothing (§5.3)', () => {
  it('no key, a key whose endpoint fails its rule, and usage errors leave no runs folder', async () => {
    const cases: Array<[Json, 'unslop' | 'request-post', string[]]> = [
      [{}, 'unslop', ['--kind', 'docs']], [{ unslop: { endpoint: 'http://example.com:4420' } }, 'unslop', ['--kind', 'docs']],
      [{}, 'request-post', ['status', '--key', 'k']], [{ 'request-post': { endpoint: 'https://example.com' } }, 'request-post', ['status', '--key', 'k']],
      [{ unslop: { endpoint: 'http://127.0.0.1:9' } }, 'unslop', ['--kind']], [{ 'request-post': { endpoint: 'http://127.0.0.1:9' } }, 'request-post', ['status']],
    ]
    for (const [agents, command, args] of cases) {
      const dir = meshHome(agents)
      const r = await client(command, dir, args)
      expect([4, 14], `${command} ${args.join(' ')}`).toContain(r.code)
      expect(existsSync(runsDir(dir))).toBe(false)
    }
  })

  it('enable then disable leaves the tree as before, with no runs folder', () => {
    const dir = scratchDir('runs-onoff-')
    const token = join(scratchDir('runs-token-'), 't')
    writeFileSync(token, 'x'.repeat(40))
    const script = join(scratchDir('runs-bin-'), 'meshctl.js')
    writeFileSync(script, '')
    const io = { env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', out: () => {}, err: () => {}, script }
    expect(runMeshctl(['enable', '--request-post', '--endpoint', 'https://box.tail1234.ts.net', '--token-file', token, '--apply'], io)).toBe(0)
    expect(runMeshctl(['disable', '--request-post', '--apply'], io)).toBe(0)
    expect(readdirSync(dir).filter((name) => !name.startsWith('mesh.json.bak-'))).toEqual([])
  })
})

/** The real client in its own process, as a shim runs it. */
function child(dir: string, args: string[], stdin?: string): { proc: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> } {
  const proc = spawn(process.execPath, ['--import', TSX, MESHCTL, ...args], { env: { AGENT_INBOX_MESH_DIR: dir, PATH: process.env['PATH'] }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(proc)
  let stderr = ''
  proc.stderr!.on('data', (c: Buffer) => { stderr += c })
  if (stdin !== undefined) proc.stdin!.end(stdin)
  return { proc, exited: new Promise((done) => proc.once('exit', (code, signal) => done({ code, signal, stderr }))) }
}

describe('signals (§5.3)', () => {
  it('SIGTERM, SIGHUP and SIGINT each end a held run by that signal, with one interrupted record', async () => {
    for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
      const agent = await unslopAgent('hold')
      const dir = meshHome({ unslop: { endpoint: `http://127.0.0.1:${agent.port}` } })
      const c = child(dir, ['unslop', '--kind', 'blog'], `draft ${C.draft}`)
      await agent.posted
      await new Promise((done) => setTimeout(done, 300))
      c.proc.kill(signal)
      const end = await c.exited
      expect([end.code, end.signal], end.stderr).toEqual([null, signal])
      expect(records(dir)).toEqual([expect.objectContaining({ agent: 'unslop', op: 'blog', exit: null, signal, outcome: 'interrupted', task: 'task-7' })])
      expect(runBytes(dir)).not.toContain('canary')
    }
  }, 60_000)

  it('an interrupted wait records the last phase it saw; a signal before the key is armed leaves nothing', async () => {
    const service = await requestPostService(() => completed(fixture('status/drafting.json').response.result.task.artifacts[0].parts[1].data))
    const dir = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${service.port}` } })
    const c = child(dir, ['request-post', 'wait', '--key', 'acme-secret-x', '--through-go'])
    await service.posted
    await new Promise((done) => setTimeout(done, 1000))
    c.proc.kill('SIGTERM')
    expect((await c.exited).signal).toBe('SIGTERM')
    expect(records(dir)).toEqual([expect.objectContaining({ op: 'wait', exit: null, signal: 'SIGTERM', outcome: 'interrupted', phase: 'drafting', throughGo: true })])
    expect(runBytes(dir)).not.toContain('acme')

    // still reading its draft: the key is not resolved yet
    const early = meshHome({ unslop: { endpoint: 'http://127.0.0.1:9' } })
    const e = child(early, ['unslop', '--kind', 'docs'])
    e.proc.stdin!.write('half a draft')
    await new Promise((done) => setTimeout(done, 1500))
    e.proc.kill('SIGTERM')
    expect((await e.exited).signal).toBe('SIGTERM')
    expect(existsSync(runsDir(early))).toBe(false)
  }, 60_000)
})

const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8)

describe('the writer refuses what it does not own (§5.6)', () => {
  async function statusRun(prepare: (dir: string, file: string) => void) {
    const service = await requestPostService(() => completed(fixture('status/queued.json').response.result.task.artifacts[0].parts[1].data))
    const dir = meshHome({ 'request-post': { endpoint: `http://127.0.0.1:${service.port}` } })
    prepare(dir, join(runsDir(dir), `request-post-${localDate(Date.now())}.jsonl`))
    const r = await client('request-post', dir, ['status', '--page-id', 'p1'])
    return { dir, seen: [r.code, r.out, r.err] }
  }

  it('a symlinked folder or day file, a group-writable folder, a foreign file or a read-only folder: nothing written, same exit and output', async () => {
    const baseline = (await statusRun(() => {})).seen
    expect(baseline[0]).toBe(0)
    const elsewhere = scratchDir('runs-elsewhere-')
    const target = join(elsewhere, 'target')
    writeFileSync(target, '')
    const cases: Array<[string, (dir: string, file: string) => void]> = [
      ['symlinked folder', (dir) => symlinkSync(elsewhere, runsDir(dir))],
      ['symlinked day file', (dir, file) => { mkdirSync(runsDir(dir), { mode: 0o700 }); symlinkSync(target, file) }],
      ['group-writable folder', (dir) => { mkdirSync(runsDir(dir)); chmodSync(runsDir(dir), 0o770) }],
      ['read-only folder', (dir) => { mkdirSync(runsDir(dir)); chmodSync(runsDir(dir), 0o500) }],
    ]
    for (const [name, prepare] of cases) {
      const r = await statusRun(prepare)
      expect(r.seen, name).toEqual(baseline)
      expect(records(r.dir).length + readdirSync(elsewhere).length + readFileSync(target, 'utf8').length, name).toBe(1)
      chmodSync(runsDir(r.dir), 0o700)
    }
    // a file another user owns: a hard link to a root-owned file, where the system allows one
    let linked = false
    const r = await statusRun((dir, file) => {
      mkdirSync(runsDir(dir), { mode: 0o700 })
      for (const source of ['/private/etc/hosts', '/etc/hosts', '/etc/passwd']) {
        try { if (statSync(source).uid !== process.getuid!()) { linkSync(source, file); linked = true; return } } catch { /* next */ }
      }
    })
    expect(r.seen).toEqual(baseline)
    if (linked) expect(readdirSync(runsDir(r.dir))).toHaveLength(1)
  })
})

describe('concurrent appends, torn lines and the cap (§5.6)', () => {
  const armed = (): RunCollector => ({ armed: Date.now() - 5, op: 'docs', data: { status: 'rewritten' } })

  it('eight processes append 50 records each into a missing runs folder: 400 lines that all parse', async () => {
    const dir = scratchDir('runs-race-')
    mkdirSync(join(dir, 'mesh'), { mode: 0o700 })
    const start = Date.now() + 2500
    const code = `const { appendRun } = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src', 'mesh-runs.ts')).href)})
while (Date.now() < ${start}) {}
for (let i = 0; i < 50; i++) appendRun(${JSON.stringify(dir)}, 'unslop', { armed: Date.now(), op: 'docs', data: { status: 'rewritten', model: 'chat-long' } }, { exit: 0 })`
    const runs = Array.from({ length: 8 }, () => {
      const proc = spawn(process.execPath, ['--import', TSX, '--input-type=module', '-e', code], { stdio: 'ignore' })
      children.push(proc)
      return new Promise<number | null>((done) => proc.once('exit', done))
    })
    expect(await Promise.all(runs)).toEqual(Array(8).fill(0))
    const files = readdirSync(runsDir(dir))
    expect(files).toHaveLength(1)
    const lines = readFileSync(join(runsDir(dir), files[0]!), 'utf8').split('\n')
    expect(lines.pop()).toBe('')
    expect(lines).toHaveLength(400)
    const parsed = lines.map((line) => JSON.parse(line))
    expect(new Set(parsed.map((r) => r.id)).size).toBe(400)
    expect(parsed.every((r) => r.v === 1 && r.outcome === 'ok')).toBe(true)
  }, 60_000)

  it('repairs a torn last line: the next record parses and the partial line is the only one skipped', () => {
    const dir = scratchDir('runs-torn-')
    const file = join(runsDir(dir), `unslop-${localDate(Date.now())}.jsonl`)
    privateFile(file, '{"v":1,"id":"aaaaaaaaaa"}\n{"v":1,"id":"part')
    appendRun(dir, 'unslop', armed(), { exit: 0 })
    appendRun(dir, 'unslop', armed(), { exit: 0 })
    const lines = readFileSync(file, 'utf8').split('\n')
    const bad = lines.filter((line) => { try { JSON.parse(line); return false } catch { return true } })
    expect(bad).toEqual(['{"v":1,"id":"part', ''])
    expect(lines.slice(2, 4).map((l) => JSON.parse(l).outcome)).toEqual(['ok', 'ok'])
  })

  it('the cap is size + line, and the largest record with its repair newline is at most 512 bytes', () => {
    const dir = scratchDir('runs-cap-')
    const big: RunCollector = {
      armed: Date.now() - 1e9, op: 'release-notes', task: 'T'.repeat(64), bytesIn: 12_289, internal: false,
      data: {
        reason: `r${'x'.repeat(39)}`, screen: Array.from({ length: 9 }, (_, i) => `${'c'.repeat(23)}${i}`), status: 'kept-original', attempts: 9, model: 'M'.repeat(64),
        rulesSha256: 'f'.repeat(64), ms: { queued: 1e12, load: 1e12, model: 1e12, check: 1e12 }, warnings: Array.from({ length: 9 }, (_, i) => ({ class: `${'w'.repeat(23)}${i}`, detail: C.detail })),
      },
    }
    const file = join(runsDir(dir), `unslop-${localDate(Date.now())}.jsonl`)
    privateFile(file, 'x')
    appendRun(dir, 'unslop', big, { exit: 10 })
    const line = readFileSync(file).subarray(1)
    expect(line.length).toBeGreaterThan(400)
    expect(line.length).toBeLessThanOrEqual(512)
    expect(JSON.parse(line.toString('utf8'))).toMatchObject({ outcome: 'kept-original', reason: `r${'x'.repeat(39)}`, status: 'kept-original' })

    // 300 bytes under the cap: a record over 300 bytes is refused, a shorter one fits
    privateFile(file, `${'x'.repeat(256 * 1024 - 301)}\n`)
    appendRun(dir, 'unslop', big, { exit: 10 })
    expect(statSync(file).size).toBe(256 * 1024 - 300)
    appendRun(dir, 'unslop', { armed: Date.now(), op: 'pr' }, { exit: 14 })
    expect(statSync(file).size).toBeGreaterThan(256 * 1024 - 300)
    expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('retention, purge and forget-runs (§5.6, §5.9)', () => {
  function seeded() {
    const dir = scratchDir('runs-keep-')
    const runs = runsDir(dir)
    const old = daysAgo(40)
    for (const agent of ['unslop', 'request-post', 'web-search']) {
      privateFile(join(runs, `${agent}-${old}.jsonl`), '{}\n')
      privateFile(join(runs, `${agent}-${daysAgo(29)}.jsonl`), '{}\n{}\n')
    }
    privateFile(join(runs, `unslop-${old}.txt`), '')
    const outside = join(scratchDir('runs-out-'), 'x')
    writeFileSync(outside, 'keep')
    symlinkSync(outside, join(runs, `unslop-${daysAgo(41)}.jsonl`))
    return { dir, runs, old, list: () => readdirSync(runs).sort() }
  }
  const sorted = (names: string[]): string[] => [...names].sort()
  const ctl = (dir: string, ...argv: string[]) => {
    const out: string[] = []
    const code = runMeshctl(argv, { env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', out: (t) => out.push(t), err: (t) => out.push(t) })
    return { code, out: out.join('') }
  }

  it('a new day file deletes only this agent’s expired files: never another agent’s, a symlink or another name', () => {
    const s = seeded()
    appendRun(s.dir, 'unslop', { armed: Date.now(), op: 'docs' }, { exit: 0 })
    expect(s.list()).toEqual(sorted([`request-post-${s.old}.jsonl`, `request-post-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(41)}.jsonl`,
      `unslop-${localDate(Date.now())}.jsonl`, `unslop-${s.old}.txt`, `web-search-${s.old}.jsonl`, `web-search-${daysAgo(29)}.jsonl`]))
  })

  it('a 40-day-old file of each agent is deleted by disable --request-post (dry run and --apply) and by enable --unslop', () => {
    const kept = (s: ReturnType<typeof seeded>) => sorted([`request-post-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(41)}.jsonl`, `unslop-${s.old}.txt`, `web-search-${daysAgo(29)}.jsonl`])
    for (const argv of [['disable', '--request-post'], ['disable', '--request-post', '--apply'], ['enable', '--unslop', '--checkout', '/nonexistent']]) {
      const s = seeded()
      ctl(s.dir, ...argv)
      expect(s.list(), argv.join(' ')).toEqual(kept(s))
    }
    const s = seeded()
    expect(ctl(s.dir, 'disable', '--request-post', '--bogus').code).toBe(2)
    expect(s.list()).toHaveLength(8)
  })

  it('disable --unslop --purge and disable --request-post --purge remove that agent’s run files only', () => {
    const s = seeded()
    const dry = ctl(s.dir, 'disable', '--request-post', '--purge')
    expect(dry.out).toContain(`Would delete ${join(s.runs, `request-post-${daysAgo(29)}.jsonl`)}.`)
    expect(ctl(s.dir, 'disable', '--request-post', '--purge', '--apply').code).toBe(0)
    expect(s.list()).toEqual(sorted([`unslop-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(41)}.jsonl`, `unslop-${s.old}.txt`, `web-search-${daysAgo(29)}.jsonl`]))
    expect(ctl(s.dir, 'disable', '--unslop', '--purge', '--apply').code).toBe(0)
    expect(s.list()).toEqual(sorted([`unslop-${daysAgo(41)}.jsonl`, `unslop-${s.old}.txt`, `web-search-${daysAgo(29)}.jsonl`]))
    // a folder left empty goes
    const e = scratchDir('runs-empty-')
    privateFile(join(runsDir(e), `request-post-${daysAgo(1)}.jsonl`), '{}\n')
    expect(ctl(e, 'disable', '--request-post', '--purge', '--apply').code).toBe(0)
    expect(readdirSync(e)).toEqual([])
  })

  it('forget-runs lists without --apply, deletes with it, leaves symlinks and other agents alone, and works with the agent off', () => {
    const s = seeded()
    const dry = ctl(s.dir, 'forget-runs', '--unslop')
    expect(dry).toEqual({ code: 0, out: 'Would delete 1 run file (2 runs) for unslop.\nNothing changed. Re-run with --apply.\n' })
    expect(s.list()).toHaveLength(5)
    expect(ctl(s.dir, 'forget-runs', '--unslop', '--apply')).toEqual({ code: 0, out: 'Deleted 1 run file (2 runs) for unslop.\n' })
    expect(s.list()).toEqual(sorted([`request-post-${daysAgo(29)}.jsonl`, `unslop-${daysAgo(41)}.jsonl`, `unslop-${s.old}.txt`, `web-search-${daysAgo(29)}.jsonl`]))
    const link = join(s.runs, `unslop-${daysAgo(41)}.jsonl`)
    expect([lstatSync(link).isSymbolicLink(), readFileSync(link, 'utf8')]).toEqual([true, 'keep'])
    expect(ctl(s.dir, 'forget-runs', '--all', '--apply').out).toBe('No run records for unslop.\nDeleted 1 run file (2 runs) for request-post.\nDeleted 1 run file (2 runs) for web-search.\n')
  })
})
