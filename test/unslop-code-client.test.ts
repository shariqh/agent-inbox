// `meshctl unslop-code`, the unslop-code agent's client (#652, step 3b): the change it collects
// from git (in scratch repositories), the gate and identity proof before anything is sent, and
// the task end to end against a real A2A server (packages/mesh's startServer with the
// unslop-code skill and a fake run), plus one on-demand start of the real agent with a fake
// OpenAI-compatible backend on loopback. Every non-zero exit is checked for an empty stdout,
// except an apply the client refused, which still prints the patch.
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from '../packages/mesh/src/a2a.js'
import type { A2AServer } from '../packages/mesh/src/a2a.js'
import { codeSkill } from '../packages/mesh/src/skills.js'
import { patchFor, removeLines } from '../packages/mesh/src/code-slop.js'
import type { CodeSlopResult, CodeSlopTask } from '../packages/mesh/src/unslop-code.js'
import { runClient } from '../src/meshctl.js'
import { collectChange, patchFiles, runUnslopCode } from '../src/unslop-code-client.js'
import type { UnslopCodeIo } from '../src/unslop-code-client.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const REPO = new URL('..', import.meta.url).pathname
const TSX = pathToFileURL(join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const WRAP = join(REPO, 'packages', 'mesh', 'src', 'wrap.ts')
const TOKEN = 'c4'.repeat(32)
const SLOP = '// slop: set the value'

const servers: Array<Server | A2AServer> = []
const children: ChildProcess[] = []
let spawns = 0
const spy = ((...args: Parameters<typeof spawn>) => {
  spawns++
  const child = spawn(...args)
  children.push(child)
  return child
}) as typeof spawn

beforeEach(() => { spawns = 0 })
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((done) => child.once('exit', done))
    try { process.kill(-child.pid!, 'SIGTERM') } catch { /* gone */ }
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))])
  }
  for (const server of servers.splice(0)) {
    if ('idleMs' in server) await server.close()
    else {
      server.closeAllConnections?.()
      await new Promise((done) => server.close(done))
    }
  }
  removeScratchDirs()
})

// ── scratch repositories ────────────────────────────────────────────────────

const HOME = (): string => scratchDir('code-home-')
/** git's environment: a scratch HOME, no system or global config of this Mac's */
function gitEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' }
}

function repo(files: Record<string, string> = {}) {
  const dir = scratchDir('code-repo-')
  const home = HOME()
  const env = gitEnv(home)
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const write = (path: string, text: string | Buffer): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  for (const [path, text] of Object.entries(files)) write(path, text)
  if (Object.keys(files).length) {
    git('add', '-A')
    git('commit', '-q', '-m', 'start')
  }
  return { dir, home, env, git, write, read: (path: string) => readFileSync(join(dir, path), 'utf8') }
}

const BASE = 'export function f(x: number): number {\n  return x + 1\n}\n'
const SLOPPED = `export function f(x: number): number {\n  ${SLOP}\n  const y = x + 1\n  return y\n}\n`

describe('the change it collects (D4)', () => {
  it('tracked (staged or not), staged new and untracked files; ignored, deleted, binary, symlinked and other files are not sent', () => {
    const r = repo({ 'a.ts': BASE, 'b.js': 'const b = 1\n', 'gone.ts': 'x\n', 'old.ts': 'const o = 1\n', 'notes.md': 'old\n', '.gitignore': 'ignored.ts\n' })
    r.write('a.ts', SLOPPED)
    r.write('b.js', 'const b = 1\n// added\nconst c = 2\n')
    r.git('add', 'b.js')
    r.write('staged-new.tsx', 'export const S = 1\n')
    r.git('add', 'staged-new.tsx')
    r.write('untracked.mjs', 'one\ntwo\n')
    r.write('ignored.ts', 'secret\n')
    r.write('notes.md', 'new\n')
    unlinkSync(join(r.dir, 'gone.ts'))
    r.git('mv', 'old.ts', 'renamed.ts')
    r.write('bin.js', Buffer.from([0x63, 0x00, 0x01, 0x0a]))
    symlinkSync('a.ts', join(r.dir, 'link.ts'))
    const index = readFileSync(join(r.dir, '.git', 'index'))
    const indexTime = statSync(join(r.dir, '.git', 'index')).mtimeMs
    const c = collectChange({ cwd: r.dir, paths: [], env: r.env })
    if ('refused' in c) throw new Error(c.refused)
    expect(c.files.map((f) => [f.path, f.added])).toEqual([
      ['a.ts', [2, 3, 4]], ['b.js', [2, 3]], ['renamed.ts', [1]], ['staged-new.tsx', [1]], ['untracked.mjs', [1, 2]],
    ])
    expect(c.files[0]!.text).toBe(SLOPPED)
    expect(c.files[0]!.bytes.equals(Buffer.from(SLOPPED))).toBe(true)
    expect(c.leftOut).toEqual(['link.ts: left out (a symlink)', 'bin.js: left out (binary)'])
    // it never changes the index
    expect(readFileSync(join(r.dir, '.git', 'index')).equals(index)).toBe(true)
    expect(statSync(join(r.dir, '.git', 'index')).mtimeMs).toBe(indexTime)
  })

  it('CRLF, a BOM and a path with a space are read as they are; a subfolder finds the repository', () => {
    const r = repo({ 'src/crlf.ts': 'a\r\nb\r\n', 'src/with space.ts': '\uFEFFx\n' })
    r.write('src/crlf.ts', 'a\r\n// c\r\nb\r\n')
    r.write('src/with space.ts', '﻿x\n// y\n')
    const c = collectChange({ cwd: join(r.dir, 'src'), paths: [], env: r.env })
    if ('refused' in c) throw new Error(c.refused)
    expect(c.top).toBe(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, env: r.env, encoding: 'utf8' }).stdout.trim())
    expect(c.files.map((f) => [f.path, f.added, f.text])).toEqual([['src/crlf.ts', [2], 'a\r\n// c\r\nb\r\n'], ['src/with space.ts', [2], '﻿x\n// y\n']])
  })

  it('--base takes everything beyond the merge base; paths after -- limit it, and one outside the repository is left out', () => {
    const r = repo({ 'a.ts': BASE, 'b.ts': BASE })
    r.git('checkout', '-q', '-b', 'work')
    r.write('a.ts', SLOPPED)
    r.git('commit', '-q', '-am', 'work')
    r.write('b.ts', `${BASE}// more\n`)
    const head = collectChange({ cwd: r.dir, paths: [], env: r.env })
    expect('files' in head && head.files.map((f) => f.path)).toEqual(['b.ts'])
    const main = r.git('rev-parse', 'HEAD~1').trim()
    const based = collectChange({ cwd: r.dir, base: main, paths: [], env: r.env })
    expect('files' in based && based.files.map((f) => [f.path, f.added])).toEqual([['a.ts', [2, 3, 4]], ['b.ts', [4]]])
    const outside = scratchDir('code-outside-')
    const limited = collectChange({ cwd: r.dir, base: main, paths: ['a.ts', join(outside, 'x.ts'), '../'], env: r.env })
    expect('files' in limited && limited.files.map((f) => f.path)).toEqual(['a.ts'])
    expect('leftOut' in limited && limited.leftOut).toEqual([`${join(outside, 'x.ts')}: left out (outside the repository)`, '../: left out (outside the repository)'])
    // a glob is a literal path
    expect(collectChange({ cwd: r.dir, paths: ['*.ts'], env: r.env })).toEqual({ refused: expect.stringContaining('no JavaScript or TypeScript file') })
    expect(collectChange({ cwd: r.dir, base: 'no-such-ref', paths: [], env: r.env })).toEqual({ refused: expect.stringContaining('--base') })
    expect(collectChange({ cwd: r.dir, paths: [outside], env: r.env })).toEqual({ refused: 'every path given is outside the repository' })
  })

  it('refuses outside a repository, with nothing changed, and with more than 40 files; an oversized file is left out and named', () => {
    expect(collectChange({ cwd: scratchDir('code-plain-'), paths: [], env: gitEnv(HOME()) })).toEqual({ refused: expect.stringContaining('not inside a git repository') })
    const r = repo({ 'a.ts': BASE })
    expect(collectChange({ cwd: r.dir, paths: [], env: r.env })).toEqual({ refused: expect.stringContaining('no JavaScript or TypeScript file') })
    for (let i = 0; i < 41; i++) r.write(`many/f${i}.ts`, `// ${i}\n`)
    const many = collectChange({ cwd: r.dir, paths: [], env: r.env })
    expect(many).toEqual({ refused: expect.stringMatching(/^41 JavaScript and TypeScript files changed .* at most 40: pass the paths to look at after --$/) })
    const some = collectChange({ cwd: r.dir, paths: ['many/f1.ts', 'many/f2.ts'], env: r.env })
    expect('files' in some && some.files.map((f) => f.path)).toEqual(['many/f1.ts', 'many/f2.ts'])
    r.write('big.ts', `${'// x\n'.repeat(60_000)}`)
    const big = collectChange({ cwd: r.dir, paths: ['big.ts', 'a.ts', 'many/f1.ts'], env: r.env })
    expect('leftOut' in big && big.leftOut).toEqual(['big.ts: left out (over 256 KiB)'])
    // a repository with no commit yet: everything is new
    const fresh = repo()
    fresh.write('n.ts', 'a\nb\n')
    const c = collectChange({ cwd: fresh.dir, paths: [], env: fresh.env })
    expect('files' in c && c.files.map((f) => [f.path, f.added])).toEqual([['n.ts', [1, 2]]])
  })
})

describe('patchFiles: only a deletions-only patch of files that were sent', () => {
  it('takes the agent\'s patches and refuses anything else', () => {
    const sent = new Set(['a.ts', 'b.ts'])
    const a = patchFor('a.ts', SLOPPED, removeLines(SLOPPED, [2]))
    const b = patchFor('b.ts', 'x\n// y', 'x\n')
    expect(patchFiles('', sent)).toEqual([])
    expect(patchFiles(a + b, sent)).toEqual(['a.ts', 'b.ts'])
    expect(patchFiles(patchFor('c.ts', SLOPPED, removeLines(SLOPPED, [2])), sent)).toBeUndefined()
    expect(patchFiles(a.replace(`-  ${SLOP}`, '+  evil()'), sent)).toBeUndefined()
    expect(patchFiles(a.replace(`-  ${SLOP}`, `-  ${SLOP}\n+  evil()`), sent)).toBeUndefined()
    expect(patchFiles(a + a, sent)).toBeUndefined()
    for (const path of ['../a.ts', './a.ts', 'x//a.ts']) expect(patchFiles(a.replaceAll('a.ts', path), new Set([path])), path).toBeUndefined()
    expect(patchFiles(a.slice(0, -1), sent)).toBeUndefined()
    expect(patchFiles('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n', sent)).toBeUndefined()
  })
})

// ── the client ──────────────────────────────────────────────────────────────

type Run = (task: CodeSlopTask) => Promise<CodeSlopResult> | CodeSlopResult
/** The fake run: removes each added line that holds `// slop`, suggests `cast` on each added `as` line. */
const slopRun: Run = (task) => {
  const files = task.files.map((f) => {
    const lines = f.text.split('\n')
    const removed = f.added.filter((n) => lines[n - 1]?.trim().startsWith('// slop'))
    const suggestions = f.added.filter((n) => / as /.test(lines[n - 1] ?? '')).map((line) => ({ line, kind: 'cast' as const }))
    return { path: f.path, status: removed.length ? 'cleaned' as const : 'unchanged' as const, removed, dropped: [], suggestions }
  })
  const patch = files.map((r, i) => (r.removed.length ? patchFor(r.path, task.files[i]!.text, removeLines(task.files[i]!.text, r.removed)) : '')).join('')
  return { code: 0, status: files.some((f) => f.removed.length) ? 'cleaned' : 'unchanged', patch, files, model: 'coder-next', calls: 2, ms: { queued: 1.5, load: 0, model: 20.25 } }
}

async function agent(run: Run = slopRun) {
  const tasks: CodeSlopTask[] = []
  const server = await startServer({
    host: '127.0.0.1', port: 0, tokens: [TOKEN], version: '0.0.0-test',
    skill: codeSkill({ run: async (task) => { tasks.push(task); return run(task) } }),
  })
  servers.push(server)
  return { port: server.port, tasks }
}

function privateFile(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, text)
  chmodSync(path, 0o600)
}

/** A mesh dir as `meshctl enable --unslop-code` leaves it, the endpoint as given (null: no mesh.json). */
function meshHome(endpoint: string | null, profile: Record<string, unknown> = {}): string {
  const dir = scratchDir('code-mesh-')
  if (endpoint !== null) writeFileSync(join(dir, 'mesh.json'), JSON.stringify({ schema: 1, agents: { 'unslop-code': { endpoint, profile: 'unslop-code' } } }))
  privateFile(join(dir, 'mesh', 'tokens', 'unslop-code'), `${TOKEN}\n`)
  privateFile(join(dir, 'mesh', 'wrappers', 'unslop-code.json'), JSON.stringify({
    baseUrl: 'http://127.0.0.1:9', start: [process.execPath, '--import', TSX, WRAP, '--agent', 'openai-compatible', '--profile', 'unslop-code'], ...profile,
  }))
  return dir
}

async function run(r: ReturnType<typeof repo>, mesh: string, args: string[], extra: Partial<UnslopCodeIo> = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runUnslopCode(args, {
    env: { ...r.env, AGENT_INBOX_MESH_DIR: mesh }, home: r.home, cwd: r.dir,
    out: (text) => out.push(text), err: (text) => err.push(text), spawn: spy, pollMs: 100, ...extra,
  })
  return { code, out: out.join(''), err: err.join('') }
}

function proof(req: IncomingMessage, label = 'unslop-code'): Record<string, string> {
  const nonce = req.headers['a2a-mesh-challenge']
  return typeof nonce === 'string' ? { 'a2a-mesh-proof': createHmac('sha256', TOKEN).update(`${label}/v1\n${nonce}`).digest('base64url') } : {}
}

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

const sloppy = () => {
  const r = repo({ 'src/a.ts': BASE, 'src/b.ts': 'export const b = 1\n' })
  r.write('src/a.ts', SLOPPED)
  r.write('src/b.ts', 'export const b = 1\nexport const c = b as number\n')
  return r
}

describe('before anything is sent', () => {
  it('off, a non-loopback endpoint, no token: exit 14, nothing spawned or connected; refusals of the change come first', async () => {
    let connections = 0
    const counting = createNetServer((socket) => { connections++; socket.destroy() })
    const port = await listen(counting)
    servers.push(counting as unknown as Server)
    const r = sloppy()
    for (const endpoint of [null, `http://localhost:${port}`, `http://0.0.0.0:${port}`, `https://127.0.0.1:${port}`]) {
      const res = await run(r, meshHome(endpoint), [])
      expect([endpoint, res.code, res.out], res.err).toEqual([endpoint, 14, ''])
      expect(res.err).toMatch(/^unslop-code: off: /)
    }
    const noToken = meshHome(`http://127.0.0.1:${port}`)
    unlinkSync(join(noToken, 'mesh', 'tokens', 'unslop-code'))
    expect((await run(r, noToken, [])).err).toContain('the caller token is missing')
    // not a git repository: 11 before the switch is read
    const plain = { ...r, dir: scratchDir('code-plain-') }
    expect((await run(plain, meshHome(null), [])).code).toBe(11)
    expect([spawns, connections]).toEqual([0, 0])
  })

  it('a process that does not prove the token, or proves unslop\'s label, gets only the card request', async () => {
    for (const label of [undefined, 'unslop']) {
      const received: Buffer[] = []
      const methods: string[] = []
      const fake = createServer((req, res) => {
        methods.push(req.method!)
        req.resume()
        res.writeHead(200, { 'content-type': 'application/json', ...(label ? proof(req, label) : {}) }).end('{}')
      })
      fake.on('connection', (socket) => socket.on('data', (chunk: Buffer) => received.push(chunk)))
      servers.push(fake)
      const r = sloppy()
      const res = await run(r, meshHome(`http://127.0.0.1:${await listen(fake)}`), [])
      expect([res.code, res.out]).toEqual([14, ''])
      expect(res.err).toContain('another process holds the unslop-code port')
      expect(methods).toEqual(['GET'])
      const bytes = Buffer.concat(received).toString('latin1').toLowerCase()
      for (const secret of [TOKEN, 'authorization', 'slop: set', 'sendstreamingmessage']) expect(bytes).not.toContain(secret)
    }
    expect(spawns).toBe(0)
  })

  it('a proven agent whose card is not unslop-code\'s (unslop\'s, for one) is exit 14 and nothing is sent', async () => {
    const unslop = await startServer({
      host: '127.0.0.1', port: 0, tokens: [TOKEN], version: '0.0.0-test',
      rules: () => ({ rulesSha256: '0'.repeat(64), bytes: 1, loadedAt: new Date(0).toISOString() }), run: () => new Promise(() => {}),
    })
    servers.push(unslop)
    // unslop's card behind unslop-code's proof
    const card = await (await fetch(`http://127.0.0.1:${unslop.port}/.well-known/agent-card.json`)).text()
    let posts = 0
    const fake = createServer((req, res) => {
      if (req.method === 'POST') posts++
      res.writeHead(200, { 'content-type': 'application/json', ...proof(req) }).end(card)
    })
    servers.push(fake)
    const res = await run(sloppy(), meshHome(`http://127.0.0.1:${await listen(fake)}`), [])
    expect([res.code, res.out, posts]).toEqual([14, '', 0])
    expect(res.err).toContain("the agent's card does not match this meshctl (not the unslop-code agent's card)")
  })
})

describe('end to end against the agent\'s server', () => {
  it('exit 0: the patch on stdout, nothing written without --apply, the summary, suggestions and left-out files on stderr, a private report', async () => {
    const a = await agent()
    const r = sloppy()
    symlinkSync('a.ts', join(r.dir, 'src', 'link.ts'))
    const mesh = meshHome(`http://127.0.0.1:${a.port}`)
    const report = 'report.json'
    const res = await run(r, mesh, ['--report', report])
    expect(res.code, res.err).toBe(0)
    expect(res.out).toBe(patchFor('src/a.ts', SLOPPED, removeLines(SLOPPED, [2])))
    expect(r.read('src/a.ts')).toBe(SLOPPED)
    expect(res.err).toBe([
      'unslop-code: looked at 2 of 2 files: removed 1 comment line, 1 suggestion.',
      'src/b.ts:2 cast',
      'unslop-code: src/link.ts: left out (a symlink)', '',
    ].join('\n'))
    // what the agent received: the files, their added lines, suggest on by default
    expect(a.tasks[0]!.files.map((f) => [f.path, f.added])).toEqual([['src/a.ts', [2, 3, 4]], ['src/b.ts', [2]]])
    expect(a.tasks[0]!.suggest).toBeUndefined()
    const file = join(r.dir, report)
    expect((lstatSync(file).mode & 0o777).toString(8)).toBe('600')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ code: 0, status: 'cleaned', model: 'coder-next', patch: res.out, files: [{ path: 'src/a.ts', removed: [2] }, { path: 'src/b.ts', suggestions: [{ line: 2, kind: 'cast' }] }] })
    expect(r.git('status', '--porcelain')).toBe(' M src/a.ts\n M src/b.ts\n?? report.json\n?? src/link.ts\n')

    // --no-suggest reaches the agent; nothing removed is an empty patch, still exit 0
    r.write('src/a.ts', BASE.replace('x + 1', 'x + 2'))
    const none = await run(r, mesh, ['--no-suggest', '--', 'src/a.ts'])
    expect([none.code, none.out]).toEqual([0, ''])
    expect(a.tasks[1]!.suggest).toBe(false)
    expect(none.err).toBe('unslop-code: looked at 1 of 1 file: removed 0 comment lines, 0 suggestions.\n')
    // a symlinked report is refused before anything is sent
    symlinkSync(join(r.dir, 'elsewhere'), join(r.dir, 'link.json'))
    expect((await run(r, mesh, ['--report', 'link.json'])).code).toBe(4)
    expect(a.tasks).toHaveLength(2)
  })

  it('--apply applies the patch to the working tree, never the index', async () => {
    const a = await agent()
    const r = sloppy()
    r.git('add', 'src/b.ts')
    const staged = r.git('diff', '--cached')
    const res = await run(r, meshHome(`http://127.0.0.1:${a.port}`), ['--apply'])
    expect(res.code, res.err).toBe(0)
    expect(res.err).toContain('removed 1 comment line, 1 suggestion; applied to 1 file.')
    expect(r.read('src/a.ts')).toBe(removeLines(SLOPPED, [2]))
    expect(r.git('diff', '--cached')).toBe(staged)
  })

  it('--apply refuses when a file changed after it was sent: the patch is printed, nothing applied, exit 13', async () => {
    let r!: ReturnType<typeof repo>
    const a = await agent((task) => {
      // someone edits the file while the agent works
      writeFileSync(join(r.dir, 'src', 'a.ts'), `${SLOPPED}// later\n`)
      return slopRun(task)
    })
    r = sloppy()
    const res = await run(r, meshHome(`http://127.0.0.1:${a.port}`), ['--apply'])
    expect(res.code).toBe(13)
    expect(res.out).toBe(patchFor('src/a.ts', SLOPPED, removeLines(SLOPPED, [2])))
    expect(res.err).toContain('nothing was applied: src/a.ts changed after it was sent.')
    expect(r.read('src/a.ts')).toBe(`${SLOPPED}// later\n`)
  })

  it('a patch that is not deletions only, or touches a file not sent, is exit 13 with an empty stdout', async () => {
    for (const bad of [(p: string) => p.replace(`-  ${SLOP}`, '+  evil()'), (p: string) => p.replaceAll('src/a.ts', 'src/other.ts')]) {
      const a = await agent((task) => { const res = slopRun(task) as CodeSlopResult; return { ...res, patch: bad(res.patch) } })
      const r = sloppy()
      const res = await run(r, meshHome(`http://127.0.0.1:${a.port}`), ['--apply'])
      expect([res.code, res.out]).toEqual([13, ''])
      expect(res.err).toContain('not a deletions-only patch of the files sent')
      expect(r.read('src/a.ts')).toBe(SLOPPED)
    }
  })

  it('the agent\'s 11, 12 and 13 are the exit codes, with an empty stdout; usage is 4', async () => {
    const results: Array<[number, Partial<CodeSlopResult> & { retryAfterMs?: number }]> = [[11, { code: 11, status: 'rejected', reason: 'all-skipped' }], [12, { code: 12, status: 'busy', reason: 'backend-5xx' }], [13, { code: 13, status: 'failed', reason: 'unreachable' }]]
    for (const [exit, result] of results) {
      const a = await agent(() => ({ patch: '', files: [], model: 'coder-next', calls: 0, ms: { queued: 0, load: 0, model: 0 }, ...result }) as CodeSlopResult)
      const res = await run(sloppy(), meshHome(`http://127.0.0.1:${a.port}`), [])
      expect([res.code, res.out], res.err).toEqual([exit, ''])
      expect(res.err).toContain(`(${result.reason})`)
    }
    const r = sloppy()
    for (const args of [['--bogus'], ['--base'], ['--timeout', '0'], ['--timeout', '601'], ['--apply', '--apply'], ['--report', '--apply'], ['--', '']]) {
      expect((await run(r, meshHome(null), args)).code, args.join(' ')).toBe(4)
    }
  })

  it('the meshctl entry records one run with counts only: never a path, a line of code or the patch', async () => {
    const a = await agent()
    const r = sloppy()
    const mesh = meshHome(`http://127.0.0.1:${a.port}`)
    const out: string[] = []
    const code = await runClient('unslop-code', ['--report', 'r.json'], {
      env: { ...r.env, AGENT_INBOX_MESH_DIR: mesh }, home: r.home, cwd: r.dir, stdin: Readable.from([]), out: (t) => out.push(t), err: () => {},
    })
    expect(code).toBe(0)
    const runs = join(mesh, 'mesh', 'runs')
    const [file] = readdirSync(runs)
    expect(file).toMatch(/^unslop-code-\d{4}-\d{2}-\d{2}\.jsonl$/)
    const text = readFileSync(join(runs, file!), 'utf8')
    const record = JSON.parse(text.trim())
    expect(record).toMatchObject({ agent: 'unslop-code', op: 'clean', exit: 0, outcome: 'ok', status: 'cleaned', files: 2, removed: 1, suggestions: 1, model: 'coder-next', timing: { queued: 2, load: 0, model: 20 } })
    expect(record.bytesIn).toBe(Buffer.byteLength(SLOPPED) + Buffer.byteLength('export const b = 1\nexport const c = b as number\n'))
    expect(text).not.toMatch(/src\/|a\.ts|\/\/ slop|cast|diff|export/)
    // off writes nothing
    const off = meshHome(null)
    await runClient('unslop-code', [], { env: { ...r.env, AGENT_INBOX_MESH_DIR: off }, home: r.home, cwd: r.dir, stdin: Readable.from([]), out: () => {}, err: () => {} })
    expect(readdirSync(join(off, 'mesh'))).not.toContain('runs')
  })
})

describe('on demand, as unslop\'s client does', () => {
  it('starts the real agent from its profile, logs to unslop-code-agent.log, and the next call reuses it', async () => {
    // a fake OpenAI-compatible backend: removes nothing, suggests nothing
    const backend = createServer((req, res) => {
      req.resume()
      req.on('end', () => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"remove":[],"keep":[],"suggest":[]}' } }],
      })))
    })
    servers.push(backend)
    const baseUrl = `http://127.0.0.1:${await listen(backend)}`
    const free = createServer()
    const port = await listen(free)
    await new Promise((done) => free.close(done))
    const mesh = meshHome(`http://127.0.0.1:${port}`, { baseUrl })
    const r = sloppy()
    const first = await run(r, mesh, [])
    expect([first.code, first.out], first.err).toEqual([0, ''])
    expect(first.err).toContain('starting the agent')
    expect(first.err).toContain('looked at 2 of 2 files: removed 0 comment lines, 0 suggestions.')
    const log = join(mesh, 'mesh', 'logs', 'unslop-code-agent.log')
    expect(readFileSync(log, 'utf8')).toContain('unslop-code listening')
    expect((lstatSync(log).mode & 0o777).toString(8)).toBe('600')
    expect(readdirSync(join(mesh, 'mesh', 'logs')).sort()).toEqual([expect.stringMatching(/^unslop-code-\d{4}-\d{2}-\d{2}\.log$/), 'unslop-code-agent.log'])
    const second = await run(r, mesh, [])
    expect(second.code).toBe(0)
    expect(second.err).not.toContain('starting the agent')
    expect(spawns).toBe(1)
  }, 60_000)
})
