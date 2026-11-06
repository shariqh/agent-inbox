#!/usr/bin/env node
// agent-inbox-meshctl (Mesh M1, #397; design §2.1 and §2.5): the only writer of
// `mesh.json`, the mesh's root switch. It follows install-agents.sh's habits:
// a dry run by default, `--apply` to change anything, a timestamped backup, and
// nothing touched that it does not own (keys it does not know stay as they are).
// Node core only: it never opens the hub, so it imports nothing from store.ts.
//
// Since #454 the Agents view is always on, so `enable --agents-view` writes
// nothing and an `agentsView` key in an existing file is kept like any other.
// `enable --unslop` (#483, unslop design §4.2-§4.3) turns on the unslop agent:
// the `agents.unslop` key, its profile template, caller token and shim.
//
//   meshctl enable --agents-view [--apply]   says the Agents view is always on
//   meshctl enable --unslop [--port <n>] [--checkout <path>] [--apply]
//   meshctl disable [--apply]                turn every mesh piece off
//   meshctl disable --unslop [--purge] [--apply]
//   meshctl status                           say what mesh.json turns on
//   meshctl unslop                           the shim's command (U3b)
//
// Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage,
// 14 unslop unavailable.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MESH_FILE_MAX, MESH_REASONS, MESH_SCHEMA, meshDir, meshFile, parseMesh } from './mesh-config.js'
import type { MeshDocument } from './mesh-config.js'

const UNSLOP_PORT = 4420

const USAGE = `usage: agent-inbox-meshctl status
       agent-inbox-meshctl disable [--apply]
       agent-inbox-meshctl enable --agents-view [--apply]
       agent-inbox-meshctl enable --unslop [--port <n>] [--checkout <path>] [--apply]
       agent-inbox-meshctl disable --unslop [--purge] [--apply]

Without --apply, enable and disable are dry runs: they print what they would do.
The Agents view is always on, so enable --agents-view writes nothing.
enable --unslop needs packages/mesh built in the checkout (npm ci && npm run build there);
it listens on http://127.0.0.1:<port> only (default ${UNSLOP_PORT}). disable --unslop keeps the
profile, logs and deny list unless --purge.
mesh.json lives in AGENT_INBOX_MESH_DIR, else beside AGENT_INBOX_DB, else ~/.agent-inbox.
`

export interface MeshctlIo {
  env?: NodeJS.ProcessEnv
  home?: string
  now?: () => Date
  out?: (text: string) => void
  err?: (text: string) => void
  /** The Node binary and meshctl.js the shim and start command name (tests point them at scratch files). */
  node?: string
  script?: string
}

type Existing =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: string }
  | { kind: 'present'; doc: MeshDocument }

function readExisting(file: string): Existing {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  if (!stat.isFile()) return { kind: 'refused', reason: MESH_REASONS['not-regular'] }
  if (stat.size > MESH_FILE_MAX) return { kind: 'refused', reason: MESH_REASONS['too-large'] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { kind: 'refused', reason: MESH_REASONS.unreadable }
  }
  const parsed = parseMesh(text)
  return parsed.ok ? { kind: 'present', doc: parsed.doc } : { kind: 'refused', reason: MESH_REASONS[parsed.reason] }
}

// `~/…` for the home directory, so the output reads like the docs
function shown(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const pad = (n: number): string => String(n).padStart(2, '0')
function backupName(file: string, now: Date): string {
  const t = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${file}.bak-${t}`
}

/** Copies the current file aside, never through a symlink and never over another backup. */
function writeBackup(file: string, now: Date): string {
  const source = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  try {
    if (!fstatSync(source).isFile()) throw new Error('not a regular file')
    bytes = readFileSync(source)
  } finally {
    closeSync(source)
  }
  const base = backupName(file, now)
  for (let n = 0; n < 100; n++) {
    const target = n ? `${base}-${n}` : base
    let fd: number
    try {
      fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return target
  }
  throw new Error('no free backup name')
}

const ALWAYS_ON = 'The Agents view is always on; mesh.json no longer controls it.'

// ── unslop (#483, unslop design §4.2-§4.3) ──────────────────────────────────

/** The port of an `agents.unslop.endpoint`: only http://127.0.0.1:<port>, never port 80 (clients drop `:80` from Host). */
function loopbackPort(endpoint: unknown): number | undefined {
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(String(endpoint))?.[1])
  return port >= 1 && port <= 65535 && port !== 80 ? port : undefined
}

function unslopPaths(dir: string) {
  const root = join(dir, 'mesh')
  return {
    root, wrappers: join(root, 'wrappers'), profile: join(root, 'wrappers', 'unslop.json'),
    tokens: join(root, 'tokens'), token: join(root, 'tokens', 'unslop'), logs: join(root, 'logs'),
    deny: join(root, 'unslop-deny.txt'), budget: join(root, 'unslop-budget.json'),
    bin: join(dir, 'bin'), shim: join(dir, 'bin', 'unslop'),
  }
}

const exists = (path: string): boolean => { try { lstatSync(path); return true } catch { return false } }
const isFile = (path: string): boolean => { try { return statSync(path).isFile() } catch { return false } }
const removeIfEmpty = (dir: string): void => { try { rmdirSync(dir) } catch { /* not empty, or not ours */ } }

/** Creates `path` with exactly `mode`, through O_NOFOLLOW; `exclusive` refuses an existing file. */
function writeNew(path: string, text: string, mode: number, exclusive: boolean): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (exclusive ? constants.O_EXCL : constants.O_TRUNC), mode)
  try {
    fchmodSync(fd, mode)
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Writes through a temporary file and an atomic rename. */
function writeAtomic(path: string, text: string, mode: number): void {
  const temp = `${path}.tmp-${process.pid}`
  writeNew(temp, text, mode, true)
  try {
    renameSync(temp, path)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
}

// The agent refuses each placeholder: `skill` is not absolute, `baseUrl` is not a
// URL and the `env` name holds no key. Keys it does not read (`_about`, `start`) it ignores.
function profileTemplate(start: string[]): string {
  return `${JSON.stringify({
    _about: 'The unslop agent\'s profile (agent-inbox #483). Fill in skill, baseUrl and apiKey (or remove apiKey when the backend needs no key); the agent refuses to start until you do. start is what meshctl runs.',
    skill: 'FILL IN: the absolute path of the unslop skill folder, which holds rules.md',
    baseUrl: 'FILL IN: the https:// base URL of the OpenAI-compatible backend (http:// only on a loopback address)',
    apiKey: { env: 'FILL IN: the name of the environment variable holding the key, or use { "file": "/absolute/path" } (0600) or { "command": ["/absolute/path", "arg"] }' },
    model: 'chat-long',
    sampling: { temperature: 0.2, top_p: 0.9, presence_penalty: 0 },
    terms: [], allowEmails: [], customerPaths: [],
    start,
  }, null, 2)}\n`
}

const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

// The shim never reads a terminal: on a stale path it discards piped input only.
// It pins the mesh dir it was written for, so the caller's environment (no
// AGENT_INBOX_MESH_DIR, or an AGENT_INBOX_DB) cannot point it at another one.
function shimText(node: string, script: string, dir: string): string {
  return `#!/bin/sh
# agent-inbox unslop shim (#483), written by meshctl enable --unslop. Do not edit.
AGENT_INBOX_MESH_DIR=${shQuote(dir)}; export AGENT_INBOX_MESH_DIR
node=${shQuote(node)}
meshctl=${shQuote(script)}
if [ ! -x "$node" ] || [ ! -f "$meshctl" ]; then
  [ -t 0 ] || cat > /dev/null
  echo 'agent-inbox unslop: this shim is stale: run meshctl enable --unslop again' >&2
  exit 14
fi
exec "$node" "$meshctl" unslop "$@"
`
}

type Step = { dry: string; run: () => string }

function runSteps(steps: Step[], apply: boolean, out: (text: string) => void, err: (text: string) => void, failed: string): number {
  const n = steps.length
  if (!apply) {
    out(`Dry run.\n${steps.map((step, i) => `${i + 1}/${n} ${step.dry}`).join('\n')}\nNothing changed. Re-run with --apply.\n`)
    return 0
  }
  for (const [i, step] of steps.entries()) {
    try {
      out(`${i + 1}/${n} ${step.run()}\n`)
    } catch {
      err(`Failed at step ${i + 1}/${n}. ${failed}\n`)
      return 1
    }
  }
  return 0
}

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function runMeshctl(argv: string[], io: MeshctlIo = {}): number {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const now = io.now ?? (() => new Date())
  const out = io.out ?? ((text: string) => { process.stdout.write(text) })
  const err = io.err ?? ((text: string) => { process.stderr.write(text) })

  const [command, ...rest] = argv
  const usage = (): number => { err(USAGE); return 2 }
  if (command === 'help' || command === '--help' || command === '-h') { out(USAGE); return 0 }
  if (command === 'unslop') {
    // the shim's command: the client arrives in U3b (unslop design §10)
    err('agent-inbox-meshctl unslop is not built yet (#483 U3b): edit the text in-session.\n')
    return 14
  }
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (['--port', '--checkout'].includes(arg)) {
      const value = rest[++i]
      if (value === undefined || values.has(arg)) return usage()
      values.set(arg, value)
    } else if (flags.has(arg)) return usage()
    else flags.add(arg)
  }
  const apply = flags.delete('--apply')
  const unslop = flags.delete('--unslop')


  const dir = resolve(meshDir(env, home))
  const file = meshFile(dir)
  const name = shown(file, home)
  const paths = unslopPaths(dir)
  const show = (path: string): string => shown(path, home)
  const refuse = (reason: string): number => { err(`Refused: ${reason}. Nothing changed.\n`); return 1 }
  const writeMesh = (doc: MeshDocument, replacing: boolean): string => {
    const backup = replacing ? ` (backup: ${show(writeBackup(file, now()))})` : ''
    writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, 0o644)
    return backup
  }

  if (command === 'status') {
    if (flags.size || values.size || apply || unslop) return usage()
    out(`${ALWAYS_ON}\n`)
    const existing = readExisting(file)
    const entry = existing.kind === 'present' ? objectOf(existing.doc['agents'])?.['unslop'] : undefined
    const port = entry === undefined ? undefined : loopbackPort(objectOf(entry)?.['endpoint'])
    if (existing.kind === 'missing') out(`Mesh: off. No ${name}.\n`)
    else if (existing.kind === 'refused') out(`Mesh: off. ${name} ${existing.reason}, so it is read as off.\n`)
    else out(port ? `Mesh: on. ${name} turns on unslop.\n` : `Mesh: off. ${name} turns on no piece this build reads.\n`)
    const has = (path: string): string => (exists(path) ? 'present' : 'missing')
    const state = port ? `on at http://127.0.0.1:${port}` : entry === undefined ? 'off' : 'off (agents.unslop.endpoint is not http://127.0.0.1:<port>)'
    out(`Unslop: ${state}. Profile ${show(paths.profile)}: ${has(paths.profile)}; token: ${has(paths.token)}; shim ${show(paths.shim)}: ${has(paths.shim)}.\n`)
    return existing.kind === 'refused' ? 1 : 0
  }

  if (command === 'enable' && !unslop) {
    if (!flags.delete('--agents-view') || flags.size || values.size) return usage()
    out(`${ALWAYS_ON} Nothing written.\n`)
    return 0
  }

  if (command === 'enable') {
    if (flags.size) return usage()
    const portText = values.get('--port') ?? String(UNSLOP_PORT)
    const port = /^\d{1,5}$/.test(portText) ? loopbackPort(`http://127.0.0.1:${portText}`) : undefined
    if (!port) return refuse('the port must be a number from 1 to 65535 other than 80; the endpoint is always http://127.0.0.1:<port>')
    const existing = readExisting(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const doc: MeshDocument = existing.kind === 'present' ? existing.doc : { schema: MESH_SCHEMA }
    const agents = doc['agents'] === undefined ? {} : objectOf(doc['agents'])
    if (!agents) return refuse(`${name} has an "agents" value that is not an object`)
    const wanted = { endpoint: `http://127.0.0.1:${port}`, profile: 'unslop' }
    const next: MeshDocument = { ...doc, agents: { ...agents, unslop: wanted } }
    const current = existing.kind === 'present' && JSON.stringify(agents['unslop']) === JSON.stringify(wanted)

    const repo = fileURLToPath(new URL('..', import.meta.url))
    const checkout = resolve(values.get('--checkout') ?? repo)
    const wrap = join(checkout, 'packages', 'mesh', 'dist', 'wrap.js')
    if (!isFile(wrap)) {
      return refuse(isFile(join(checkout, 'packages', 'mesh', 'package.json'))
        ? `${show(wrap)} is missing: run npm ci && npm run build in ${show(join(checkout, 'packages', 'mesh'))} (Node 24)`
        : `${show(checkout)} is not an agent-inbox checkout: pass --checkout <path of one>`)
    }
    const node = io.node ?? process.execPath
    const self = fileURLToPath(import.meta.url)
    const script = io.script ?? (self.endsWith('.js') ? self : join(repo, 'dist', 'meshctl.js'))
    if (!isFile(script)) return refuse(`${show(script)} is missing: run npm run build in ${show(repo)}`)
    if ([node, wrap, script, dir].some((path) => /[\x00-\x1f\x7f]/.test(path))) return refuse('a path holds a control character')
    const start = [node, wrap, '--agent', 'openai-compatible', '--profile', 'unslop']
    const template = profileTemplate(start)
    const shim = shimText(node, script, dir)
    const json = `${JSON.stringify(next, null, 2)}\n`
    const dirs = (): void => {
      for (const d of [paths.wrappers, paths.tokens, paths.bin]) mkdirSync(d, { recursive: true, mode: 0o700 })
    }

    const steps: Step[] = [
      exists(paths.token)
        ? { dry: `Would keep the caller token ${show(paths.token)} (present).`, run: () => `Kept ${show(paths.token)}.` }
        : {
            dry: `Would write a new random caller token to ${show(paths.token)} (0600).`,
            run: () => { dirs(); writeNew(paths.token, `${randomBytes(32).toString('base64url')}\n`, 0o600, true); return `Wrote ${show(paths.token)}.` },
          },
      exists(paths.profile)
        ? {
            dry: `Would keep the profile ${show(paths.profile)} (present; never overwritten).`,
            run: () => `Kept ${show(paths.profile)}. If Node or the checkout moved, set its "start" by hand to ${JSON.stringify(start)}.`,
          }
        : {
            dry: `Would write the profile template ${show(paths.profile)} (0600):\n${template}`,
            run: () => { dirs(); writeNew(paths.profile, template, 0o600, true); return `Wrote ${show(paths.profile)}: fill in skill, baseUrl and apiKey.` },
          },
      {
        dry: `Would write the shim ${show(paths.shim)} (0755):\n${shim}`,
        run: () => { dirs(); writeAtomic(paths.shim, shim, 0o755); return `Wrote ${show(paths.shim)}.` },
      },
      current ? { dry: `Would keep ${name} (unslop is on at ${wanted.endpoint}).`, run: () => `Kept ${name}: unslop is on at ${wanted.endpoint}.` } : {
        dry: `Would ${existing.kind === 'present' ? 'replace' : 'create'} ${name}${existing.kind === 'present' ? ' (keeping a backup beside it)' : ''}:\n${json}`,
        run: () => `Wrote ${name}${writeMesh(next, existing.kind === 'present')}: unslop is on at http://127.0.0.1:${port}.`,
      },
    ]
    return runSteps(steps, apply, out, err, `Steps before it are done; ${name} was not changed.`)
  }

  if (command === 'disable' && unslop) {
    const purge = flags.delete('--purge')
    if (flags.size || values.size) return usage()
    const existing = readExisting(file)
    if (existing.kind === 'refused') return refuse(`${name} ${existing.reason}. Remove it by hand if you are sure`)
    const steps: Step[] = []
    const agents = existing.kind === 'present' ? objectOf(existing.doc['agents']) : undefined
    if (existing.kind === 'present' && agents && 'unslop' in agents) {
      const { unslop: _gone, ...others } = agents
      const next: MeshDocument = { ...existing.doc, agents: others }
      if (!Object.keys(others).length) delete next['agents']
      steps.push(Object.keys(next).length === 1
        ? {
            dry: `Would delete ${name}: agents.unslop was its only setting (keeping a backup beside it).`,
            run: () => { const backup = writeBackup(file, now()); unlinkSync(file); return `Deleted ${name} (backup: ${show(backup)}).` },
          }
        : {
            dry: `Would remove agents.unslop from ${name}, keeping every other key (and a backup beside it).`,
            run: () => `Removed agents.unslop from ${name}${writeMesh(next, true)}.`,
          })
    }
    const remove = (path: string, parent?: string): void => {
      if (exists(path)) steps.push({ dry: `Would delete ${show(path)}.`, run: () => { unlinkSync(path); if (parent) removeIfEmpty(parent); return `Deleted ${show(path)}.` } })
    }
    remove(paths.shim, paths.bin)
    remove(paths.token, paths.tokens)
    if (purge) {
      remove(paths.profile, paths.wrappers)
      remove(paths.deny)
      remove(paths.budget)
      let logs: string[] = []
      try {
        if (lstatSync(paths.logs).isDirectory()) logs = readdirSync(paths.logs).filter((entry) => /^unslop-/.test(entry)).sort()
      } catch { /* no logs */ }
      for (const log of logs) remove(join(paths.logs, log), paths.logs)
      if (steps.length) steps.push({ dry: `Would remove ${show(paths.root)} if it is then empty.`, run: () => { removeIfEmpty(paths.root); return `Tidied ${show(paths.root)}.` } })
    }
    if (!steps.length) {
      out(`Unslop is already off${purge ? ' and purged' : ' (its profile, logs and deny list stay; --purge removes them)'}. Nothing to do.\n`)
      return 0
    }
    return runSteps(steps, apply, out, err, 'Steps before it are done; nothing after it ran.')
  }

  if (command === 'disable') {
    if (flags.size || values.size) return usage()
    const existing = readExisting(file)
    if (existing.kind === 'missing') {
      out(`The mesh is already off: no ${name}. Nothing to do.\n`)
      return 0
    }
    if (existing.kind === 'refused') {
      err(`Refused: ${name} ${existing.reason}. Nothing changed. Remove it by hand if you are sure.\n`)
      return 1
    }
    // M1 has one step. Later phases put theirs before it (§2.5): pause the
    // registry, archive every active @mesh plan, then delete the file.
    return runSteps([
      {
        dry: `Would delete ${name} (keeping a backup beside it).`,
        run: () => {
          const backup = writeBackup(file, now())
          unlinkSync(file)
          return `Deleted ${name} (backup: ${shown(backup, home)}).`
        },
      },
    ], apply, out, err, `${name} was not removed.`)
  }

  return usage()
}

const entry = process.argv[1]
let isMain = false
try {
  isMain = Boolean(entry) && realpathSync(entry!) === realpathSync(fileURLToPath(import.meta.url))
} catch { /* not run directly */ }
if (isMain) process.exitCode = runMeshctl(process.argv.slice(2))
