// Which Setup runtimes are installed, what still uses each one, and how much
// room each takes (issue #294). VIEWER-PROCESS-ONLY and read-only: no process,
// no network, no lock, no write.
//
// "Uses" is the rule scripts/runtime-config.mjs applies before
// prune-runtimes.sh removes a runtime (scanRuntimeReferences), mirrored here so
// Settings can say what Remove would do; test/runtime-inventory.test.ts runs the script's
// own helper over the same files and holds the two to agreement. The script
// decides again under the setup lock, and also keeps a runtime that a running
// process uses, which nothing here can see. Each host config is parsed in
// memory and dropped: only which runtimes it uses is kept, never a command, an
// argument or anything else in it.
//
// A runtime's size is its manifest's recorded total. The bounded walk only
// says whether the folder still matches that manifest, because the prune
// refuses one that does not, so it runs for an unused runtime alone: this
// app's runtime and one in use are kept whatever their folders hold. A walk
// lstats every file (about 40 ms for a 4,000-file runtime), so viewer.ts keeps
// both answers for as long as the folder's and its manifest's stamps hold.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

export type RuntimeStatus = 'current' | 'used' | 'unused' | 'changed' | 'not-a-runtime' | 'unchecked'

/**
 * current       — this app's own runtime
 * used          — a host config uses it (`usedBy` names which)
 * unused        — nothing does: Setup's prune removes it
 * changed       — no longer matches its manifest, so the prune leaves it
 * not-a-runtime — a folder without a manifest naming it, which the prune leaves
 * unchecked     — a host config could not be read, so nothing is offered
 */
export interface RuntimeEntry {
  runtimeId: string
  version: string | null
  /** what its manifest records, or null for a folder that is not a runtime */
  bytes: number | null
  status: RuntimeStatus
  usedBy: string[]
}

export interface RuntimeInventory {
  /** 'unknown' when a host config exists but proves nothing */
  state: 'ok' | 'unknown'
  /** that config, under `~/` when it is in the home folder */
  unreadable?: string
  /** why, in the prune's own words: "is not valid JSON" */
  reason?: string
  entries: RuntimeEntry[]
}

/** One runtime folder as its manifest describes it: null when no manifest names this folder. */
export interface RuntimeMeasure {
  version: string | null
  bytes: number
  /** every file there and nothing else, at its recorded size and mode; null when not walked */
  intact: boolean | null
}
/** measureRuntime, or a cached copy of it: `walk` asks for `intact` too. */
export type RuntimeMeasurer = (dir: string, runtimeId: string, walk: boolean) => RuntimeMeasure | null

const MANIFEST_FILE = 'runtime-manifest.json'
const PRODUCT = 'agent-inbox-runtime'
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
// A runtime holds about 4,000 files; a folder with this many entries is no runtime of ours.
const MAX_WALK_ENTRIES = 50_000
const MAX_CONFIG_BYTES = 64 * 1024 * 1024
const MAX_LAUNCHER_PATHS = 4096
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
// what a string splits into pieces at: the words of a command line and each side of KEY=value
const PIECE_SEPARATORS = /[\s'"=:;,]+/
// what a runtime id is made of: one of these on either side makes a longer name
const RUNTIME_ID_CHAR = /[0-9A-Za-z._+-]/
const LABELS = new Map([
  ['.claude.json', 'Claude Code'],
  ['settings.json', 'Claude Code settings'],
  ['settings.local.json', 'Claude Code settings'],
  ['mcp-config.json', 'Copilot CLI'],
  ['claude_desktop_config.json', 'Claude Desktop'],
])

/** The host config files whose launchers can use a runtime, under `home`: runtime-config.mjs referenceFiles. */
export function referenceFiles(home: string): string[] {
  return [
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.copilot', 'mcp-config.json'),
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  ]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnder(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/**
 * The folder `dir` as its own manifest describes it, when that manifest is a
 * plain file naming the folder as an Agent Inbox runtime; else null. Its size
 * is the manifest's recorded total; with `walk`, `intact` comes from one
 * bounded walk.
 */
export function measureRuntime(dir: string, runtimeId: string, walk = true): RuntimeMeasure | null {
  const path = join(dir, MANIFEST_FILE)
  let manifest: unknown
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(manifest) || manifest['product'] !== PRODUCT || manifest['runtimeId'] !== runtimeId) return null
  const listed = manifest['files']
  if (!Array.isArray(listed)) return null
  const files = new Map<string, { size: number; mode: number }>()
  let bytes = 0
  for (const file of listed) {
    if (!isPlainObject(file)) return null
    const { path: name, size, mode } = file
    if (typeof name !== 'string' || typeof size !== 'number' || typeof mode !== 'number') return null
    files.set(name, { size, mode })
    bytes += size
  }
  const version = manifest['packageVersion']
  return {
    version: typeof version === 'string' && version.length <= 64 && SEMVER.test(version) ? version : null,
    bytes,
    intact: walk ? matchesManifest(dir, files) : null,
  }
}

// Every entry under `dir` is a manifested regular file at its recorded size
// and mode, and every manifested file is there: what the prune's verification
// checks first, short of hashing. Bounded, so a folder that is no runtime
// costs a known amount.
function matchesManifest(dir: string, files: Map<string, { size: number; mode: number }>): boolean {
  let seen = 0
  let matched = 0
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(rel ? join(dir, rel) : dir)
    } catch {
      return false
    }
    for (const name of names) {
      seen += 1
      if (seen > MAX_WALK_ENTRIES) return false
      const path = rel ? `${rel}/${name}` : name
      if (path === MANIFEST_FILE) continue
      let st: import('node:fs').Stats
      try {
        st = lstatSync(join(dir, path))
      } catch {
        return false
      }
      if (st.isDirectory()) {
        stack.push(path)
        continue
      }
      const recorded = files.get(path)
      if (!st.isFile() || !recorded || recorded.size !== st.size || recorded.mode !== (st.mode & 0o777)) return false
      matched += 1
    }
  }
  return matched === files.size
}

// The deepest entry that exists on `path`'s way down, when it is a symlink whose target is gone.
function danglingLink(path: string): string | null {
  let current = path
  for (;;) {
    let entry: import('node:fs').Stats
    try {
      entry = lstatSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
      continue
    }
    if (!entry.isSymbolicLink()) return null
    try {
      statSync(current)
      return null
    } catch {
      return current
    }
  }
}

type Config = { state: 'missing' } | { state: 'unknown'; reason: string } | { state: 'ok'; value: unknown }

// A host config: missing (it says nothing), unknown (it exists but proves
// nothing, with why, as runtime-config.mjs says it), or its JSON.
function readConfig(file: string, home: string): Config {
  let st: import('node:fs').Stats
  try {
    st = statSync(file)
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return { state: 'unknown', reason: `cannot be read (${code ?? 'error'})` }
    const dangling = danglingLink(file)
    return dangling === null
      ? { state: 'missing' }
      : { state: 'unknown', reason: `cannot be read: ${shown(dangling, home)} is a symlink to something that is not there` }
  }
  if (!st.isFile()) return { state: 'unknown', reason: 'is not a regular file' }
  if (st.size > MAX_CONFIG_BYTES) return { state: 'unknown', reason: 'is larger than 64 MB' }
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { state: 'unknown', reason: `cannot be read (${errorCode(err) ?? 'error'})` }
  }
  try {
    return { state: 'ok', value: raw.trim() === '' ? {} : JSON.parse(raw) }
  } catch {
    // never the parser's message: it can quote the file, secrets and all
    return { state: 'unknown', reason: 'is not valid JSON' }
  }
}

function stringValues(value: unknown): string[] {
  const out: string[] = []
  const queue: unknown[] = [value]
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i]
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) for (const item of node) queue.push(item)
    else if (isPlainObject(node)) for (const item of Object.values(node)) queue.push(item)
  }
  return out
}

function findLaunchers(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const queue: unknown[] = [value]
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i]
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
    } else if (isPlainObject(node)) {
      if (typeof node['command'] === 'string') out.push(node)
      for (const item of Object.values(node)) queue.push(item)
    }
  }
  return out
}

// Each of `texts` whole, and each piece of it, without repeats.
function candidatesOf(texts: string[]): Set<string> {
  const out = new Set<string>()
  for (const text of texts) {
    out.add(text)
    for (const piece of text.split(PIECE_SEPARATORS)) if (piece) out.add(piece)
  }
  return out
}

// Rule (a) for one candidate: whether it names `id` as a whole name, other than
// at the end of a path to a folder that is not there. The text up to and
// including the id is that folder.
function namesById(candidate: string, id: string, home: string): boolean {
  for (let at = candidate.indexOf(id); at >= 0; at = candidate.indexOf(id, at + 1)) {
    const end = at + id.length
    if ((at > 0 && RUNTIME_ID_CHAR.test(candidate[at - 1]!)) || (end < candidate.length && RUNTIME_ID_CHAR.test(candidate[end]!))) continue
    const folder = placedPath(candidate.slice(0, end), home)
    if (folder === null || !isAbsence(statError(folder))) return true
  }
  return false
}

// `candidate` as a path to follow: absolute, or `~/` under `home`; else null.
function placedPath(candidate: string, home: string): string | null {
  if (candidate.startsWith('/')) return candidate
  if (candidate.startsWith('~/')) return join(home, candidate.slice(2))
  return null
}

// stat's error code for `path`, or null when it succeeds.
function statError(path: string): string | null {
  try {
    statSync(path)
    return null
  } catch (err) {
    return errorCode(err) ?? 'EUNKNOWN'
  }
}

const isAbsence = (code: string | null): boolean => code === 'ENOENT' || code === 'ENOTDIR'

// A file's identity, its (dev, ino), or null when stat fails.
function identityOf(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

// The identities of `path` resolved and of every folder above it; when `path`
// cannot be resolved, of the deepest folder above it that can.
function identitiesAbove(path: string): Set<string> {
  let real: string | null = null
  for (let at = path; real === null;) {
    try {
      real = realpathSync(at)
    } catch {
      const up = dirname(at)
      if (up === at) return new Set()
      at = up
    }
  }
  const out = new Set<string>()
  for (let at = real; ; at = dirname(at)) {
    const identity = identityOf(at)
    if (identity !== null) out.add(identity)
    if (dirname(at) === at) return out
  }
}

// Which of `ids` the host configs under `home` use, by label; or the first config that proves nothing, and why.
function scanUses(home: string, runtimeRoot: string, ids: string[]): { uses: Map<string, Set<string>> } | { unreadable: string; reason: string } {
  const rootIdentity = identityOf(runtimeRoot)
  const runtimes = ids.map((id) => ({ id, identity: identityOf(join(runtimeRoot, id)) }))
  const uses = new Map<string, Set<string>>()
  const use = (id: string, label: string) => uses.set(id, (uses.get(id) ?? new Set()).add(label))
  let paths = 0
  for (const file of referenceFiles(home)) {
    const config = readConfig(file, home)
    if (config.state === 'missing') continue
    if (config.state === 'unknown') return { unreadable: file, reason: config.reason }
    const label = LABELS.get(basename(file)) ?? file
    // (b) a launcher path that leads into a runtime, by identity
    for (const launcher of findLaunchers(config.value)) {
      const placed = [...candidatesOf(stringValues(launcher))].map((c) => placedPath(c, home)).filter((p): p is string => p !== null)
      paths += placed.length
      if (paths > MAX_LAUNCHER_PATHS) {
        return { unreadable: file, reason: `names more than ${MAX_LAUNCHER_PATHS} paths in its launchers, too many to check` }
      }
      for (const path of placed) {
        const code = statError(path)
        if (isAbsence(code)) continue
        const above = identitiesAbove(path)
        const inRoot = code !== null && rootIdentity !== null && above.has(rootIdentity)
        for (const { id, identity } of runtimes) {
          if (inRoot || (identity !== null && above.has(identity))) use(id, label)
        }
      }
    }
    // (a) the id as a whole name, anywhere in the config
    const values = stringValues(config.value)
    for (const { id } of runtimes) {
      if (values.some((text) => text.includes(id) && [...candidatesOf([text])].some((c) => namesById(c, id, home)))) use(id, label)
    }
  }
  return { uses }
}

function shown(file: string, home: string): string {
  return isUnder(home, file) ? `~${file.slice(home.length)}` : file
}

/**
 * Every folder directly in `runtimeRoot` — never a symlink (never followed),
 * never a `.`-name such as the `.trash-*` an interrupted prune leaves — with
 * what uses it. `current` is this app's runtime id (null in a checkout), and
 * `measure` describes one folder (measureRuntime, cached by the caller).
 */
export function readRuntimes({ home, runtimeRoot, current, measure }: {
  home: string
  runtimeRoot: string
  current: string | null
  measure: RuntimeMeasurer
}): RuntimeInventory {
  let names: string[]
  try {
    names = readdirSync(runtimeRoot).sort()
  } catch {
    return { state: 'ok', entries: [] }
  }
  const entries: RuntimeEntry[] = []
  const candidates: Array<{ runtimeId: string; dir: string; measured: RuntimeMeasure }> = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const dir = join(runtimeRoot, name)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const measured = measure(dir, name, false)
    if (measured === null) entries.push({ runtimeId: name, version: null, bytes: null, status: 'not-a-runtime', usedBy: [] })
    else if (name === current) entries.push({ runtimeId: name, version: measured.version, bytes: measured.bytes, status: 'current', usedBy: [] })
    else candidates.push({ runtimeId: name, dir, measured })
  }
  const scan = candidates.length > 0 ? scanUses(home, runtimeRoot, candidates.map((c) => c.runtimeId)) : { uses: new Map<string, Set<string>>() }
  for (const { runtimeId, dir, measured } of candidates) {
    const base = { runtimeId, version: measured.version, bytes: measured.bytes }
    if ('unreadable' in scan) {
      entries.push({ ...base, status: 'unchecked', usedBy: [] })
      continue
    }
    const usedBy = [...(scan.uses.get(runtimeId) ?? [])]
    if (usedBy.length > 0) {
      entries.push({ ...base, status: 'used', usedBy })
      continue
    }
    // removable only while the folder still matches its manifest
    const intact = measured.intact ?? measure(dir, runtimeId, true)?.intact === true
    entries.push({ ...base, status: intact ? 'unused' : 'changed', usedBy })
  }
  entries.sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0))
  return 'unreadable' in scan
    ? { state: 'unknown', unreadable: shown(scan.unreadable, home), reason: scan.reason, entries }
    : { state: 'ok', entries }
}
