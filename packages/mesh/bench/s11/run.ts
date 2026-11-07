// Bench S11's runner and command line (#483, unslop design §9.1). `run` writes
// the fixtures to a run folder (0700, files 0600, never inside this checkout),
// the in-session folder a person or an assistant fills by hand, and runs each
// fixture through the real client with --report, recording the exit code, the
// time and the report. The fictional deny-list customer is in the deny list only
// while the private set runs (a marker lets the next run undo a killed one). `score` writes
// summary.md and the blind sheet. Node core only; nothing here ships.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendPrivate, readPrivate, writePrivate } from '../../src/files.js'
import { meshDir } from '../../src/mesh-config.js'
import { DEFAULT_SEED, DENY_ENTRY, generate } from './fixtures.js'
import type { Fixture } from './fixtures.js'
import { scoreRun } from './score.js'
import type { Row } from './score.js'

const USAGE = `usage: npm run bench -- run [--run <dir>] [--seed <n>] [--unslop <shim or meshctl.js>] [--mesh-dir <dir>]
                            [--pass agent|sampling] [--only <id,...>] [--no-deny]
       npm run bench -- score --run <dir> [--new-blind]`
const CALL_LIMIT_MS = 330_000

export type Call = { code: number; ms: number; stdout: string; stderr: string }
/** One call through the real client: a shim, or a meshctl.js run as `node meshctl.js unslop`. */
export function callClient(command: string, kind: string, report: string, text: string, env: NodeJS.ProcessEnv): Promise<Call> {
  const [cmd, args] = command.endsWith('.js') ? [process.execPath, [command, 'unslop']] : [command, []]
  const start = performance.now()
  return new Promise((done) => {
    const child = spawn(cmd, [...args, '--kind', kind, '--report', report], { stdio: ['pipe', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), CALL_LIMIT_MS)
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    child.stdin.on('error', () => {})
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, ms: performance.now() - start, stdout: '', stderr: String(error) }) })
    child.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, ms: performance.now() - start, stdout, stderr }) })
    child.stdin.end(text)
  })
}

/** Written before the entry is added, so the next run removes a line a killed run left behind. */
const markerOf = (file: string): string => `${file}.s11-added`

function removeEntry(file: string, created: boolean): void {
  const lines = readPrivate(file, true)?.split('\n')
  const at = lines?.lastIndexOf(DENY_ENTRY) ?? -1
  if (!lines || at < 0) return
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n')
  if (created && !rest.trim()) rmSync(file, { force: true })
  else writePrivate(file, rest)
}

/** Adds the fictional customer to the deny list; the returned function puts the file back as it was. */
export function addDenyEntry(file: string): () => void {
  const marker = markerOf(file)
  const left = readPrivate(marker, true)
  if (left !== undefined) {
    let created = false
    try { created = (JSON.parse(left) as { created?: unknown }).created === true } catch { /* a torn marker: keep the file */ }
    removeEntry(file, created)
    rmSync(marker, { force: true })
  }
  const before = readPrivate(file, true)
  if (before?.split('\n').some((l) => l.trim().toLowerCase() === DENY_ENTRY.toLowerCase())) return () => {}
  const added = `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${DENY_ENTRY}\n`
  writePrivate(marker, JSON.stringify({ created: before === undefined }))
  writePrivate(file, added)
  let done = false
  return () => {
    if (done) return
    done = true
    // edited during the run: drop only the line this run added
    if (readPrivate(file, true) !== added) removeEntry(file, before === undefined)
    else if (before === undefined) rmSync(file, { force: true })
    else writePrivate(file, before)
    rmSync(marker, { force: true })
  }
}

function checkoutRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (dir !== dirname(dir)) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'agent-inbox-mesh') return resolve(dir, '../..')
    dir = dirname(dir)
  }
  return dir
}

/** Creates (or reuses) a run folder: fixtures.json and the in-session folder. */
export function prepare(run: string, seed: number): Fixture[] {
  const inside = relative(checkoutRoot(), resolve(run))
  if (inside.split(sep)[0] !== '..' && !isAbsolute(inside)) throw new Error(`${run} is inside the checkout: run folders stay outside the repository`)
  mkdirSync(run, { recursive: true, mode: 0o700 })
  const file = join(run, 'fixtures.json')
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Fixture[]
  const fixtures = generate(seed)
  writePrivate(file, `${JSON.stringify(fixtures, null, 2)}\n`)
  writePrivate(join(run, 'run.json'), `${JSON.stringify({ scenario: 'S11', seed, created: new Date().toISOString() })}\n`)
  const edits = fixtures.filter((f) => f.part !== 'private')
  writePrivate(join(run, 'in-session', 'README.md'), [
    '# S11 in-session pass', '',
    'Edit each `<id>.md` here in-session with unslop\'s `rules.md` (the same assistant that calls the agent, a fresh session per text).',
    'Save the result as `<id>.edited.md`, and note the seconds and the session tokens the edit took in `<id>.meta.json`:',
    '`{ "seconds": 41, "tokens": 5200 }`. Then run `npm run bench -- score --run <this run folder>`.', '',
    '| id | kind |', '|---|---|', ...edits.map((f) => `| ${f.id} | ${f.kind} |`), '',
  ].join('\n'))
  for (const f of edits) writePrivate(join(run, 'in-session', `${f.id}.md`), f.text)
  return fixtures
}

export async function runPass(run: string, fixtures: Fixture[], o: { unslop: string; env: NodeJS.ProcessEnv; pass: 'agent' | 'sampling' }): Promise<void> {
  const dir = join(run, o.pass === 'sampling' ? 'agent-sampling' : 'agent')
  for (const f of fixtures) {
    const report = join(dir, `${f.id}.report.json`)
    const out = join(dir, `${f.id}.out.md`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    rmSync(report, { force: true })
    rmSync(out, { force: true })
    const call = await callClient(o.unslop, f.kind, report, f.text, o.env)
    let rep: { attempts?: number; status?: string; reason?: string; screen?: string[]; ms?: { model?: number; load?: number } } = {}
    try { rep = JSON.parse(readFileSync(report, 'utf8')) as typeof rep } catch { /* no report on 4 and 14 */ }
    if (call.code === 0) writePrivate(out, call.stdout)
    writePrivate(join(dir, `${f.id}.stderr.txt`), call.stderr)
    const row: Row = {
      id: f.id, code: call.code, ms: Math.round(call.ms), cold: /starting the agent/.test(call.stderr) || (rep.ms?.load ?? 0) > 0,
      attempts: rep.attempts, modelMs: rep.ms?.model, status: rep.status, reason: rep.reason, screen: rep.screen,
    }
    appendPrivate(join(dir, 'results.jsonl'), JSON.stringify(row))
    process.stderr.write(`s11: ${f.id} exit ${call.code} in ${row.ms} ms\n`)
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const opts = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i]!
    if (['--no-deny', '--new-blind'].includes(name)) opts.set(name, '')
    else if (['--run', '--seed', '--unslop', '--mesh-dir', '--pass', '--only'].includes(name) && rest[i + 1] !== undefined) opts.set(name, rest[++i]!)
    else return (process.stderr.write(`${USAGE}\n`), 4)
  }
  if (command === 'score' && opts.has('--run')) {
    process.stdout.write(scoreRun(opts.get('--run')!, { newBlind: opts.has('--new-blind') }))
    return 0
  }
  const pass = opts.get('--pass') ?? 'agent'
  if (command !== 'run' || (pass !== 'agent' && pass !== 'sampling')) return (process.stderr.write(`${USAGE}\n`), 4)
  const env = { ...process.env, ...(opts.has('--mesh-dir') ? { AGENT_INBOX_MESH_DIR: resolve(opts.get('--mesh-dir')!) } : {}) }
  const mesh = meshDir(env)
  const run = opts.get('--run') ?? join(mesh, 'mesh', 'bench', `s11-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const fixtures = prepare(run, Number(opts.get('--seed') ?? DEFAULT_SEED))
  const only = opts.get('--only')?.split(',')
  // the sampling pass re-runs the edits only (design §9.1)
  const chosen = fixtures.filter((f) => (only ? only.includes(f.id) : pass === 'agent' || f.part === 'edit'))
  const call = { unslop: opts.get('--unslop') ?? join(mesh, 'bin', 'unslop'), env, pass } as const
  await runPass(run, chosen.filter((f) => f.part !== 'private'), call)
  const privates = chosen.filter((f) => f.part === 'private')
  if (privates.length) {
    // the deny entry exists only while the private texts run
    const restore = opts.has('--no-deny') ? () => {} : addDenyEntry(join(mesh, 'mesh', 'unslop-deny.txt'))
    const stop = (): never => { restore(); process.exit(130) }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop)
    try {
      await runPass(run, privates, call)
    } finally {
      restore()
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop)
    }
  }
  process.stdout.write(scoreRun(run))
  process.stderr.write(`s11: run folder ${run}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: Error) => {
    process.stderr.write(`s11: ${error.message}\n`)
    process.exitCode = 1
  })
}
