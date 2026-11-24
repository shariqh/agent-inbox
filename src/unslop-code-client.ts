// `meshctl unslop-code` (#652, step 3b): the client the `<mesh dir>/bin/unslop-code` shim runs
// inside a git repository. Node core only, and only meshctl imports it: never the stdio MCP
// server or the viewer. It collects the change (git, without a shell and without changing the
// index), applies unslop's gate and identity proof to `agents.unslop-code` before anything is
// sent, starts the agent on demand as unslop's client does (getCard and startAgent are shared
// with src/unslop-client.ts), streams one task and falls back to GetTask polling when the
// stream drops. The agent answers with a deletions-only patch; with --apply the client applies
// it with `git apply`, only to files that still hold the bytes that were sent. It never reads
// stdin or a terminal and never prompts.
//
// Exit codes: 0 the task ran (the patch is on stdout, empty when nothing was removed; applied
// with --apply), 11 refused (not a git repository, no file to send, more than 40 files, the
// agent's refusal), 12 busy, 13 failed, timed out or the apply was refused, 14 off, no agent,
// another process on the port or a card mismatch, 4 usage. The shim itself exits 18 when it is
// stale (meshctl.ts shimText).
import { spawnSync } from 'node:child_process'
import type { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { checkCard } from './agent-card.js'
import { loopbackPort, meshDir, meshFile, openPrivate, readMesh, readPrivate } from './mesh-config.js'
import { meshLink } from './mesh-identity.js'
import type { Exchange, MeshLink } from './mesh-identity.js'
import type { RunCollector } from './mesh-runs.js'
import { getCard, startAgent } from './unslop-client.js'

const EXTENSION = 'urn:agent-inbox:ext:unslop-code:v1'
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])
const MAX_FILES = 40
const FILE_MAX = 256 * 1024
// the agent's request limit is 4 MiB; the envelope and JSON's escapes are counted, with room to spare
const BODY_MAX = 4 * 1024 * 1024 - 16 * 1024
const START_WAIT_MS = 10_000
const POLL_MS = 5_000
const GIT_MS = 60_000
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_REJECTED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'])
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_TRUNC } = constants

export const UNSLOP_CODE_USAGE = `usage: <mesh dir>/bin/unslop-code [--base <ref>] [--apply] [--no-suggest] [--report <file>] [--timeout <s>] [-- <path>…]
       (the shim runs agent-inbox-meshctl unslop-code with the same arguments)
Run it inside a git repository. It sends the JavaScript and TypeScript files the change touched
(beyond HEAD, or beyond the merge base with --base) to the local unslop-code agent, which removes
the comments a coding agent added that a maintainer would not write. stdout: the patch (empty
when nothing is removed); --apply applies it to the working tree. Exit 0 ran, 11 refused, 12 busy,
13 failed or the apply was refused, 14 off, 4 usage; 18: the shim is stale (run meshctl enable
--unslop-code again). Default --timeout 280 s.
`

export interface UnslopCodeIo {
  env: NodeJS.ProcessEnv
  home: string
  /** the directory the command runs in: the repository is found from it */
  cwd: string
  out: (text: string) => void
  err: (text: string) => void
  spawn?: typeof nodeSpawn
  /** GetTask's interval after a dropped stream (tests shorten it) */
  pollMs?: number
  /** the local deadline only, when tests need it shorter than the --timeout sent to the agent */
  deadlineMs?: number
  /** the meshctl entry's run record: armed once the key passes its rule */
  run?: RunCollector
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
// paths and agent-supplied text reach an assistant's shell output: no control bytes but tab and newline
const clean = (text: string): string => text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, '')
const oneLine = (text: string): string => clean(text).replace(/[\t\n]/g, ' ')

// ── the change (D4) ─────────────────────────────────────────────────────────

/** One file to send: its path from the repository's top, its text, the 1-based lines the change added, and its bytes as read. */
export type ChangedFile = { path: string; text: string; added: number[]; bytes: Buffer }
export type Change = { top: string; files: ChangedFile[]; leftOut: string[] } | { refused: string }

type Git = (args: string[], cwd: string) => { ok: boolean; out: Buffer }

function gitRunner(env: NodeJS.ProcessEnv): Git {
  // no external diff, no pager, no prompt, no optional index write; the caller's own context setting goes
  const { GIT_EXTERNAL_DIFF: _diff, GIT_DIFF_OPTS: _opts, GIT_PAGER: _pager, ...rest } = env
  const gitEnv = { ...rest, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }
  return (args, cwd) => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: GIT_MS,
    })
    return { ok: !r.error && r.status === 0, out: r.stdout ?? Buffer.alloc(0) }
  }
}

const DIFF = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--no-relative']

/** The added line numbers in a `-U0` diff, from its hunk headers. */
function addedLines(diff: string): number[] {
  const added: number[] = []
  for (const line of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const from = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    for (let n = from; n < from + count; n++) added.push(n)
  }
  return added
}

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
const extensionOf = (path: string): string => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? ''

/** A regular file's bytes, never through a symlink; undefined when it is anything else or gone. */
function readRegular(path: string): Buffer | undefined {
  let fd: number
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch {
    return undefined
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd) : undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * What the working tree holds beyond HEAD (or beyond the merge base of `base` and HEAD), for
 * tracked files, staged or not, plus untracked files that are not ignored, each wholly added;
 * `paths` limit it. Only JavaScript and TypeScript files; deleted, binary, symlinked and
 * submodule entries and files outside the repository are left out. Never writes anything.
 */
export function collectChange(o: { cwd: string; base?: string; paths: string[]; env: NodeJS.ProcessEnv }): Change {
  const git = gitRunner(o.env)
  const shown = git(['rev-parse', '--show-toplevel'], o.cwd)
  const top = shown.out.toString('utf8').replace(/\n$/, '')
  if (!shown.ok || !isAbsolute(top)) return { refused: 'this is not inside a git repository (or git is missing)' }
  let base: string
  if (o.base !== undefined) {
    const commit = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${o.base}^{commit}`], top)
    const merge = commit.ok ? git(['merge-base', commit.out.toString('utf8').trim(), 'HEAD'], top) : commit
    if (!merge.ok) return { refused: '--base names no commit with a merge base with HEAD' }
    base = merge.out.toString('utf8').trim()
  } else {
    const head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top)
    // no commit yet: everything is beyond the empty tree
    base = (head.ok ? head : git(['hash-object', '-t', 'tree', '/dev/null'], top)).out.toString('utf8').trim()
  }
  if (!/^[0-9a-f]{40,64}$/.test(base)) return { refused: 'git did not name the base commit' }

  const leftOut: string[] = []
  let real: string
  let here: string
  try {
    real = realpathSync(top)
    here = realpathSync(o.cwd)
  } catch {
    return { refused: 'the repository folder cannot be read' }
  }
  const specs: string[] = []
  for (const path of o.paths) {
    const rel = relative(real, resolve(here, path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) leftOut.push(`${oneLine(path)}: left out (outside the repository)`)
    else specs.push(rel === '' ? '.' : rel)
  }
  if (o.paths.length && !specs.length) return { refused: 'every path given is outside the repository' }
  const limit = o.paths.length ? ['--', ...specs] : []

  const numstat = git(['--literal-pathspecs', 'diff', '--numstat', '-z', ...DIFF, base, ...limit], top)
  const untracked = git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--full-name', ...limit], top)
  if (!numstat.ok || !untracked.ok) return { refused: 'git could not list the change' }
  const changed = new Map<string, { binary: boolean; tracked: boolean }>()
  for (const record of numstat.out.toString('utf8').split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(record)
    if (m) changed.set(m[3]!, { binary: m[1] === '-', tracked: true })
  }
  for (const path of untracked.out.toString('utf8').split('\0')) if (path && !changed.has(path)) changed.set(path, { binary: false, tracked: false })

  const candidates: Array<{ path: string; tracked: boolean }> = []
  for (const [path, how] of [...changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!EXTENSIONS.has(extensionOf(path))) continue
    let stat
    try {
      stat = lstatSync(join(top, path))
    } catch {
      continue // deleted: nothing to look at
    }
    const why = stat.isSymbolicLink() ? 'a symlink' : stat.isDirectory() ? 'a submodule or folder' : !stat.isFile() ? 'not a regular file' : how.binary ? 'binary' : undefined
    if (why) leftOut.push(`${oneLine(path)}: left out (${why})`)
    else candidates.push({ path, tracked: how.tracked })
  }
  if (candidates.length > MAX_FILES) {
    return { refused: `${candidates.length} JavaScript and TypeScript files changed and one run takes at most ${MAX_FILES}: pass the paths to look at after --` }
  }

  const files: ChangedFile[] = []
  let body = 1024
  for (const { path, tracked } of candidates) {
    const bytes = readRegular(join(top, path))
    if (!bytes) {
      leftOut.push(`${oneLine(path)}: left out (not a regular file)`)
      continue
    }
    if (bytes.length > FILE_MAX) {
      leftOut.push(`${oneLine(path)}: left out (over ${FILE_MAX / 1024} KiB)`)
      continue
    }
    let text: string
    try {
      // the BOM stays, so the text is the bytes exactly
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      leftOut.push(`${oneLine(path)}: left out (not UTF-8 text)`)
      continue
    }
    let added: number[]
    if (tracked) {
      const diff = git(['--literal-pathspecs', 'diff', '-U0', '--inter-hunk-context=0', ...DIFF, base, '--', path], top)
      if (!diff.ok) {
        leftOut.push(`${oneLine(path)}: left out (git could not diff it)`)
        continue
      }
      added = addedLines(diff.out.toString('latin1'))
    } else added = Array.from({ length: lineCount(text) }, (_, i) => i + 1)
    if (!added.length) continue // only deletions: nothing added to look at
    const size = Buffer.byteLength(JSON.stringify({ path, text, added })) + 1
    if (body + size > BODY_MAX) {
      leftOut.push(`${oneLine(path)}: left out (does not fit in one request)`)
      continue
    }
    body += size
    files.push({ path, text, added, bytes })
  }
  if (!files.length) return { refused: 'no JavaScript or TypeScript file it can read has added lines in this change' }
  return { top, files, leftOut }
}

/**
 * The files a patch touches, when it is a deletions-only patch of files that were sent (the
 * agent's patchFor shape: one `diff --git`, `---`, `+++` header per file, then hunks of context
 * and removed lines only); undefined for anything else.
 */
export function patchFiles(patch: string, sent: ReadonlySet<string>): string[] | undefined {
  if (patch === '') return []
  if (!patch.endsWith('\n')) return undefined
  const lines = patch.slice(0, -1).split('\n')
  const files: string[] = []
  const NO_EOL = '\\ No newline at end of file'
  let i = 0
  while (i < lines.length) {
    const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i]!)
    if (!m || m[1] !== m[2] || !sent.has(m[1]!) || files.includes(m[1]!)) return undefined
    if (lines[i + 1] !== `--- a/${m[1]}` || lines[i + 2] !== `+++ b/${m[1]}`) return undefined
    files.push(m[1]!)
    i += 3
    let hunks = 0
    while (i < lines.length && !lines[i]!.startsWith('diff --git ')) {
      const h = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i]!)
      if (!h) return undefined
      hunks++
      i++
      let old = 0
      let kept = 0
      while (i < lines.length && (old < Number(h[2]) || lines[i] === NO_EOL)) {
        const line = lines[i]!
        if (line === NO_EOL) { i++; continue }
        if (line[0] === ' ') kept++
        else if (line[0] !== '-') return undefined
        old++
        i++
      }
      if (old !== Number(h[2]) || kept !== Number(h[4]) || kept === old) return undefined
    }
    if (!hunks) return undefined
  }
  return files
}

// ── the command ─────────────────────────────────────────────────────────────

type Outcome = { state?: string; data?: Json; text?: string }

export async function runUnslopCode(args: string[], io: UnslopCodeIo): Promise<number> {
  const links: MeshLink[] = []
  try {
    return await unslopCode(args, io, links)
  } finally {
    for (const link of links) link.close()
  }
}

async function unslopCode(args: string[], io: UnslopCodeIo, links: MeshLink[]): Promise<number> {
  const say = (text: string): void => io.err(`unslop-code: ${clean(text)}\n`)
  const usage = (): number => { io.err(UNSLOP_CODE_USAGE); return 4 }
  const values = new Map<string, string>()
  const flags = new Set<string>()
  let paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      paths = args.slice(i + 1)
      break
    }
    if (arg === '--apply' || arg === '--no-suggest') {
      if (flags.has(arg)) return usage()
      flags.add(arg)
    } else if (['--base', '--report', '--timeout'].includes(arg)) {
      const value = args[++i]
      if (value === undefined || value === '' || value.startsWith('-') || values.has(arg)) return usage()
      values.set(arg, value)
    } else return usage()
  }
  if (paths.some((path) => path === '')) return usage()
  const timeoutText = values.get('--timeout') ?? '280'
  if (!/^\d{1,3}$/.test(timeoutText) || +timeoutText < 1 || +timeoutText > 600) return usage()
  const apply = flags.has('--apply')
  const reportArg = values.get('--report')
  const report = reportArg === undefined ? undefined : resolve(io.cwd, reportArg)
  if (report !== undefined) {
    let isLink = false
    try { isLink = !lstatSync(report).isFile() } catch { /* absent: written later */ }
    if (isLink) {
      say(`--report ${reportArg} is a symlink or not a regular file`)
      return 4
    }
  }

  // the change comes first, as unslop's input checks do: a refusal here never reads the switch
  const change = collectChange({ cwd: io.cwd, base: values.get('--base'), paths, env: io.env })
  if ('refused' in change) {
    say(`refused: ${change.refused}. Nothing was sent.`)
    return 11
  }
  const { top, files, leftOut } = change
  const notes = (): void => { for (const line of leftOut) say(line) }
  const bytesIn = files.reduce((n, f) => n + f.bytes.length, 0)

  // off: nothing below runs without the key
  const dir = resolve(meshDir(io.env, io.home))
  const mesh = readMesh(meshFile(dir))
  const entry = mesh.kind === 'present' ? obj(obj(mesh.doc['agents'])['unslop-code']) : {}
  if (!('endpoint' in entry)) {
    say(`off: ${meshFile(dir)} ${mesh.kind === 'refused' ? mesh.reason : 'does not turn on unslop-code'}. Nothing was sent (meshctl enable --unslop-code turns it on).`)
    return 14
  }
  const port = loopbackPort(entry['endpoint'])
  if (!port) {
    say('off: agents.unslop-code.endpoint must be http://127.0.0.1:<port>. Run meshctl enable --unslop-code again.')
    return 14
  }
  if (io.run) Object.assign(io.run, { armed: Date.now(), op: 'clean', bytesIn, files: files.length })
  const unavailable = (why: string): number => {
    say(`${why}. Nothing was sent.`)
    return 14
  }

  // the agent proves it holds the token before the token or any file is sent (#492)
  let token: string
  try {
    token = readPrivate(join(dir, 'mesh', 'tokens', 'unslop-code')).trim()
  } catch {
    return unavailable('the caller token is missing or not private (0600): run meshctl enable --unslop-code again')
  }
  const link = meshLink(port, token, 'unslop-code')
  links.push(link)
  const squatter = (): number => unavailable(`another process holds the unslop-code port 127.0.0.1:${port}: it did not prove it holds the caller token, so neither the token nor a file was sent. ` +
    'An agent started before the last enable --unslop-code stops within a minute')

  let card = await getCard(link)
  if (card.kind === 'none') {
    const started = startAgent(dir, io, 'unslop-code')
    if (typeof started === 'string') return unavailable(`no agent at 127.0.0.1:${port} and cannot start one: ${started}`)
    say('starting the agent')
    for (const until = Date.now() + START_WAIT_MS; card.kind === 'none' && Date.now() < until;) {
      const gone = started.exited()
      await sleep(200)
      card = await getCard(link)
      if (gone) break
    }
    if (card.kind === 'none') return unavailable(`the agent did not start; see ${started.log}`)
  }
  if (card.kind === 'unproven') return squatter()
  if (card.kind === 'bad') return unavailable(`something other than the unslop-code agent answers at 127.0.0.1:${port}`)
  const mismatch = checkCard(card.card, 'unslop-code')
  if (mismatch) return unavailable(`the agent's card does not match this meshctl (${mismatch}): rebuild packages/mesh (npm ci && npm run build there) and stop the running agent`)

  const timeoutMs = +timeoutText * 1000
  const deadline = new AbortController()
  const begun = Date.now()
  const timer = setTimeout(() => deadline.abort(), io.deadlineMs ?? timeoutMs)
  const left = (): number => Math.max(1, (io.deadlineMs ?? timeoutMs) - (Date.now() - begun))
  const headers = { 'a2a-version': '1.0', 'content-type': 'application/json' }
  const rpc = (method: string, params: Json, timeout: number): Promise<Exchange> =>
    link.call({ method: 'POST', path: '/', headers, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), timeoutMs: timeout })

  let taskId: string | undefined
  const outcome: Outcome = {}
  const status = (s: Json): void => {
    outcome.state = String(s['state'] ?? '')
    const parts = Array.isArray(obj(s['message'])['parts']) ? obj(s['message'])['parts'] as unknown[] : []
    outcome.data = parts.map(obj).find((p) => p['data'])?.['data'] as Json | undefined ?? outcome.data
  }
  const artifact = (value: unknown): void => {
    const parts = Array.isArray(obj(value)['parts']) ? obj(value)['parts'] as unknown[] : []
    outcome.text = parts.map(obj).find((p) => typeof p['text'] === 'string')?.['text'] as string | undefined
    outcome.data = obj(parts.map(obj).find((p) => p['data'])?.['data'])
  }
  const take = (result: Json): void => {
    const task = obj(result['task'])
    if (typeof task['id'] === 'string') {
      taskId = task['id']
      status(obj(task['status']))
      if (Array.isArray(task['artifacts'])) artifact(task['artifacts'][0])
    }
    if (result['artifactUpdate']) artifact(obj(result['artifactUpdate'])['artifact'])
    if (result['statusUpdate']) status(obj(obj(result['statusUpdate'])['status']))
    if (io.run) Object.assign(io.run, { task: taskId, data: outcome.data })
  }

  const data: Json = { files: files.map(({ path, text, added }) => ({ path, text, added })), ...(flags.has('--no-suggest') ? { suggest: false } : {}) }
  let buffered = ''
  const streamed = await link.call({
    method: 'POST', path: '/', headers: { ...headers, accept: 'text/event-stream' }, timeoutMs: timeoutMs + 60_000, signal: deadline.signal,
    body: JSON.stringify({
      jsonrpc: '2.0', id: randomUUID(), method: 'SendStreamingMessage',
      params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data }], metadata: { [EXTENSION]: { timeoutMs } } } },
    }),
    onChunk: (chunk) => {
      buffered += chunk
      const events = buffered.split(/\r?\n\r?\n/)
      buffered = events.pop() ?? ''
      for (const event of events) {
        const text = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        try {
          if (text) take(obj(obj(JSON.parse(text))['result']))
        } catch { /* a malformed event: GetTask has the truth */ }
      }
    },
  })
  try {
    if (streamed === 'unproven') return squatter()
    if (typeof streamed !== 'string' && streamed.status === 401) {
      return unavailable('a running agent holds an older token; it stops within a minute, so run the command again shortly')
    }
    if (typeof streamed !== 'string' && streamed.status === 403) {
      return unavailable('the agent refused this call (HTTP 403): run meshctl enable --unslop-code again')
    }
    if (typeof streamed !== 'string' && !streamed.type.startsWith('text/event-stream')) {
      say(`failed: the agent answered HTTP ${streamed.status} without a task. Nothing was applied.`)
      return 13
    }
    // the stream dropped: GetTask every few seconds until a final state
    if (!TERMINAL.has(outcome.state ?? '') && taskId && !deadline.signal.aborted) {
      say('the stream dropped; checking the task every few seconds')
      for (let misses = 0; misses < 3 && !deadline.signal.aborted && !TERMINAL.has(outcome.state ?? '');) {
        await Promise.race([sleep(Math.min(io.pollMs ?? POLL_MS, left())), new Promise((done) => deadline.signal.addEventListener('abort', done, { once: true }))])
        if (deadline.signal.aborted) break
        const got = await rpc('GetTask', { id: taskId }, Math.min(10_000, left()))
        let result: Json = {}
        try {
          if (typeof got !== 'string') result = obj(JSON.parse(got.body))
        } catch { /* counted below */ }
        if (got === 'unproven') misses = 3
        else if (result['result']) {
          misses = 0
          take({ task: result['result'] })
        } else if (result['error']) misses = 3
        else misses++
      }
    }
    if (!TERMINAL.has(outcome.state ?? '')) {
      if (deadline.signal.aborted && taskId) await rpc('CancelTask', { id: taskId }, 2000)
      say(deadline.signal.aborted ? `failed: no result within ${timeoutText} s; the task was cancelled. Nothing was applied.` : 'failed: lost the agent. Nothing was applied.')
      return 13
    }
  } finally {
    clearTimeout(timer)
  }

  const result = outcome.data ?? {}
  const code = outcome.state === 'TASK_STATE_COMPLETED' ? (result['code'] === 0 ? 0 : 13)
    : outcome.state === 'TASK_STATE_REJECTED' ? (result['code'] === 12 ? 12 : 11) : 13
  const patch = code === 0 && typeof outcome.text === 'string' ? outcome.text : ''
  // only the result's own counts of files that were sent reach the record and stderr
  const sent = new Map(files.map((f) => [f.path, f]))
  const reports = (Array.isArray(result['files']) ? result['files'] : []).map(obj).filter((f) => typeof f['path'] === 'string' && sent.has(f['path']))
  const lines = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [])
  const suggestions = reports.flatMap((f) => (Array.isArray(f['suggestions']) ? f['suggestions'] : []).map(obj)
    .filter((s) => Number.isSafeInteger(s['line']) && typeof s['kind'] === 'string' && /^[a-z]{1,16}$/.test(s['kind']))
    .map((s) => `${oneLine(String(f['path']))}:${String(s['line'])} ${String(s['kind'])}`))
  const removed = reports.reduce((n, f) => n + lines(f['removed']).length, 0)
  if (io.run) Object.assign(io.run, { removed, suggestions: suggestions.length })
  if (report !== undefined && outcome.data) {
    try {
      const fd = openPrivate(report, O_TRUNC)
      try { writeSync(fd, `${JSON.stringify({ ...result, patch }, null, 2)}\n`) } finally { closeSync(fd) }
    } catch {
      say(`failed: cannot write the report ${reportArg}. Nothing was applied.`)
      return 13
    }
  }
  const reason = typeof result['reason'] === 'string' ? oneLine(result['reason']) : 'unknown'
  if (code !== 0) {
    if (code === 11) say(`refused (${reason}).`)
    else if (code === 12) say(`busy (${reason}): try again in about ${Math.round(Number(result['retryAfterMs'] ?? 60_000) / 1000)} s.`)
    else say(`failed (${reason}). Nothing was applied.`)
    notes()
    return code
  }

  const touched = patchFiles(patch, new Set(sent.keys()))
  if (touched === undefined) {
    say('failed: the agent\'s patch is not a deletions-only patch of the files sent. Nothing was applied.')
    return 13
  }
  const looked = reports.filter((f) => f['status'] === 'cleaned' || f['status'] === 'unchanged').length
  const summary = `looked at ${looked} of ${files.length} file${files.length === 1 ? '' : 's'}: removed ${removed} comment line${removed === 1 ? '' : 's'}, ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`
  const details = (): void => {
    for (const line of suggestions) io.err(`${line}\n`)
    for (const f of reports) {
      if (f['status'] === 'skipped' || f['status'] === 'not-reached') {
        io.err(`${oneLine(String(f['path']))}: ${f['status'] === 'skipped' ? 'skipped' : 'not reached'}${typeof f['reason'] === 'string' ? ` (${oneLine(f['reason'])})` : ''}\n`)
      }
    }
    notes()
  }

  if (apply && touched.length) {
    // only files that still hold the bytes that were sent
    const moved = touched.find((path) => !readRegular(join(top, path))?.equals(sent.get(path)!.bytes))
    const refusedApply = (why: string): number => {
      io.out(patch)
      say(`${summary}; nothing was applied: ${why}.`)
      details()
      return 13
    }
    if (moved !== undefined) return refusedApply(`${oneLine(moved)} changed after it was sent`)
    const git = (check: boolean) => spawnSync('git', ['apply', ...(check ? ['--check'] : []), '--whitespace=nowarn', '-'], {
      cwd: top, input: patch, env: { ...io.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_MS,
    })
    const checked = git(true)
    if (checked.error || checked.status !== 0) return refusedApply('git apply --check refused the patch')
    const applied = git(false)
    if (applied.error || applied.status !== 0) return refusedApply('git apply failed')
    io.out(patch)
    say(`${summary}; applied to ${touched.length} file${touched.length === 1 ? '' : 's'}.`)
    details()
    return 0
  }
  io.out(patch)
  say(`${summary}${apply ? '; nothing to apply' : ''}.`)
  details()
  return 0
}
