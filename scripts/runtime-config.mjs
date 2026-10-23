#!/usr/bin/env node
// Structural ownership/reference checks + atomic JSON mutation for host
// config files (issue #74, Layer 1).
//
// Once a runtime payload is installed (see runtime-payload.mjs), some host
// config file — a Claude Code/Copilot MCP registration, a hooks settings.json
// — ends up pointing at TWO paths inside it: the node binary to run, and the
// entry script to run with it. Before an installer (install-agents.sh,
// install-hooks.sh) safely overwrites that pointer pair, it has to know
// whether the CURRENT config already points at one of OUR managed runtime
// directories, or at something the user set up themselves. Getting this
// wrong in either direction is bad: overwriting a user's own Node setup loses
// their intent; refusing to overwrite our own stale runtime blocks upgrades.
//
// classifyRuntimeConfig() answers exactly that, structurally — by resolving
// real filesystem identity (following symlinks and `..`), never by string
// comparison of the paths as configured:
//   owned  — both paths canonicalize into the SAME runtime directory under
//            runtimeRoot, and that directory carries a valid, matching
//            ownership manifest. Safe to manage/replace.
//   custom — neither path resolves under runtimeRoot at all. Not ours; leave
//            it alone.
//   split  — the two paths disagree (one managed + one not, or two DIFFERENT
//            runtime directories). However this happened, it is not a clean
//            "we own this" state — retain, don't guess.
//   unknown — a path does not exist, is unreadable, or the runtime directory
//            it resolves to has no valid manifest (its `path`, and the
//            verifier's `problem`, are returned). Retain rather than assume.
//
// mergeJsonAtomic() is the paired write primitive: read-modify-write a JSON
// config file through a same-directory temp file + rename, so a reader never
// observes a half-written settings.json, and a destination that is itself a
// symlink keeps pointing at its real target rather than being replaced by a
// plain file. No jq, no dependency — this has to run from the bundled Node
// runtime itself and be trivially callable from Bash.
//
// The prune gate (issue #294) lives here too, read-only: which runtimes any
// host config or running process still uses (`references` for the
// installer's own prune and rollback, `unused` for prune-runtimes.sh).
// Deleting stays in runtime-payload.mjs (`prune`).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DEFAULT_MANIFEST_FILE, isMainModule, readManifestFile, verifyPayload } from './runtime-payload.mjs'

/** Resolve a path to its real, canonical filesystem identity, or null if it cannot be resolved (missing, unreadable, a loop). */
function tryCanonicalize(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Is `child` the same directory as, or nested under, `root` (both already canonical)? */
function isUnder(root, child) {
  if (child === root) return true
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** First path segment of `child` directly under canonical `root`, i.e. the runtime-id directory name. */
function firstSegmentUnder(root, child) {
  const rest = child.slice(root.length).replace(/^[/\\]/, '')
  const [first] = rest.split(/[\\/]/)
  return first
}

/**
 * Classify whether (nodeBinPath, entryPath) point at a runtime this project
 * owns and can safely manage. Never throws — any failure to resolve or
 * verify collapses to {status:'unknown', reason}, which callers must treat
 * as "retain existing config, do not touch it".
 */
export function classifyRuntimeConfig({ nodeBinPath, entryPath, runtimeRoot, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  try {
    const canonicalNode = tryCanonicalize(nodeBinPath)
    const canonicalEntry = tryCanonicalize(entryPath)
    if (!canonicalNode || !canonicalEntry) {
      return { status: 'unknown', reason: 'node binary or entry path does not exist / cannot be resolved' }
    }

    const canonicalRoot = tryCanonicalize(runtimeRoot)
    if (!canonicalRoot) {
      return { status: 'custom', reason: 'runtime root does not exist; configured paths are not ours' }
    }

    const nodeUnderRoot = isUnder(canonicalRoot, canonicalNode)
    const entryUnderRoot = isUnder(canonicalRoot, canonicalEntry)

    if (!nodeUnderRoot && !entryUnderRoot) {
      return { status: 'custom', reason: 'neither path resolves under the managed runtime root' }
    }
    if (nodeUnderRoot !== entryUnderRoot) {
      return { status: 'split', reason: 'only one of node/entry resolves under the managed runtime root' }
    }

    const nodeRuntimeId = firstSegmentUnder(canonicalRoot, canonicalNode)
    const entryRuntimeId = firstSegmentUnder(canonicalRoot, canonicalEntry)
    if (!nodeRuntimeId || !entryRuntimeId || nodeRuntimeId !== entryRuntimeId) {
      return { status: 'split', reason: 'node and entry resolve under two different runtime directories' }
    }

    const runtimeDir = join(canonicalRoot, nodeRuntimeId)
    let manifest
    try {
      manifest = verifyPayload({ root: runtimeDir, manifestFileName, expect: { runtimeId: nodeRuntimeId } })
    } catch (err) {
      return { status: 'unknown', reason: `runtime directory has no valid ownership manifest: ${err.message}`, path: runtimeDir, problem: err.message }
    }

    return { status: 'owned', runtimeId: manifest.runtimeId, version: manifest.packageVersion, path: runtimeDir }
  } catch (err) {
    return { status: 'unknown', reason: err.message }
  }
}

// ── which runtimes the host configs still use (issue #294) ──────────────
//
// ONE rule decides whether a runtime may be pruned, for every prune: the
// installer's own (`references`, after an install and in its rollback) and
// Setup's prune-runtimes.sh (`unused`). It reads whole host config files, so
// every scope in them counts (Claude Code's per-project
// `projects.*.mcpServers` as much as its user `mcpServers`). Runtime R is in
// use by a config when
//   (a) any string value in it names R's id as a whole name
//       (runtimeIdInText), wherever it sits, unless that name ends a path
//       that leads somewhere else (another root's runtime with the same
//       content-derived id) or nowhere; or
//   (b) a `/`- or `~/`-path inside a LAUNCHER resolves into R's directory, so
//       a symlinked alias that does not name the id still counts. A launcher
//       is any object with a string `command`: the shape of every MCP server
//       registration (Claude Code, Copilot CLI, Claude Desktop) and every
//       Claude hook.
// That is a superset of the verified {command, args[0]} pair this gate used
// to require, which missed split pairs, `env` and `sh -c` wrappers, later
// arguments and hooks written as one command string. A file that exists but
// cannot be read (a symlink to nothing, not a regular file, over 64 MB, not
// JSON) proves nothing, so the answer becomes `unknown` and nothing is
// pruned. Project-scope configs (`<project>/.mcp.json`,
// `<project>/.claude/settings*.json`) are not read: Setup never writes them,
// and the running-process check below still keeps a runtime that a session
// started from one of them uses.

/** The host config files whose launchers can use a runtime, under `home`. */
export function referenceFiles(home) {
  return [
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.copilot', 'mcp-config.json'),
    // Claude Desktop: macOS, then where its Linux builds keep it
    join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    join(home, '.config', 'Claude', 'claude_desktop_config.json'),
  ]
}

const REFERENCE_LABELS = new Map([
  ['.claude.json', 'Claude Code'],
  ['settings.json', 'Claude Code settings'],
  ['settings.local.json', 'Claude Code settings'],
  ['mcp-config.json', 'Copilot CLI'],
  ['claude_desktop_config.json', 'Claude Desktop'],
])

const MAX_REFERENCE_FILE_BYTES = 64 * 1024 * 1024
// Paths canonicalized per check: realistic configs name a few dozen.
const MAX_LAUNCHER_PATHS = 4096
// What a runtime id is made of (product-version-platform-arch-digest).
const RUNTIME_ID_CHAR = /[0-9A-Za-z._+-]/
// What separates the paths inside one string: a whole command line (`sh -c`,
// a hook's single command string) or `KEY=/path`.
const PATH_SEPARATOR = /[\s'"=:;,]/
const PATH_SEPARATORS = /[\s'"=:;,]+/

// Each index at which `text` names `runtimeId` as a whole name.
function* wholeNames(text, runtimeId) {
  if (typeof text !== 'string' || typeof runtimeId !== 'string' || runtimeId === '') return
  for (let at = text.indexOf(runtimeId); at >= 0; at = text.indexOf(runtimeId, at + 1)) {
    const before = at > 0 ? text[at - 1] : ''
    const after = text[at + runtimeId.length] ?? ''
    if (!RUNTIME_ID_CHAR.test(before) && !RUNTIME_ID_CHAR.test(after)) yield at
  }
}

/**
 * Does `text` name `runtimeId` as a whole name: `/<id>/`, `/<id>` at its end,
 * or `<id>` with no runtime-id character on either side? Never as a prefix or
 * suffix of a longer name, so a runtime whose id begins (or ends) another's
 * is never mistaken for it.
 */
export function runtimeIdInText(text, runtimeId) {
  for (const _ of wholeNames(text, runtimeId)) return true
  return false
}

// Whether `text` names the runtime `runtimeId` whose canonical directory is
// `dir`. Each whole-name occurrence counts, unless it ends a path that leads
// somewhere else: another runtime root holding a runtime with the same
// content-derived id, or a path that no longer exists. A bare id, or a path
// this cannot place (`$HOME/…`, relative), counts.
function namesRuntime(text, runtimeId, dir, home) {
  for (const at of wholeNames(text, runtimeId)) {
    let start = at
    while (start > 0 && !PATH_SEPARATOR.test(text[start - 1])) start -= 1
    const named = text.slice(start, at + runtimeId.length)
    const path = named.startsWith('/') ? named : home && named.startsWith('~/') ? join(home, named.slice(2)) : null
    if (path === null || dir === null) return true
    try {
      if (realpathSync(path) === dir) return true
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return true
    }
  }
  return false
}

// The deepest entry that exists on `path`'s way down, when it is a symlink
// whose target is gone: whatever `path` should hold then cannot be read.
function danglingLink(path) {
  let current = path
  for (;;) {
    let entry
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

function errorText(err) {
  return err?.code ?? err?.message ?? String(err)
}

/** One host config: missing (it says nothing), unknown (it exists but proves nothing, with why), or its JSON. */
function readReferenceFile(file) {
  let st
  try {
    st = statSync(file)
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return { state: 'unknown', reason: `cannot be read (${errorText(err)})` }
    const dangling = danglingLink(file)
    return dangling === null
      ? { state: 'missing' }
      : { state: 'unknown', reason: `cannot be read: ${dangling} is a symlink to something that is not there` }
  }
  if (!st.isFile()) return { state: 'unknown', reason: 'is not a regular file' }
  if (st.size > MAX_REFERENCE_FILE_BYTES) return { state: 'unknown', reason: 'is larger than 64 MB' }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    return { state: 'unknown', reason: `cannot be read (${errorText(err)})` }
  }
  try {
    return { state: 'ok', value: raw.trim() === '' ? {} : JSON.parse(raw) }
  } catch {
    // never the parser's message: it can quote the file, secrets and all
    return { state: 'unknown', reason: 'is not valid JSON' }
  }
}

/** Every string value inside `value`, depth first; object keys are names, never values. */
function stringValues(value) {
  const out = []
  const queue = [value]
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i]
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) for (const item of node) queue.push(item)
    else if (isPlainObject(node)) for (const item of Object.values(node)) queue.push(item)
  }
  return out
}

/** Every launcher in a parsed config: any object with a string `command`, wherever it sits. */
function findLaunchers(value) {
  const out = []
  const queue = [value]
  for (let i = 0; i < queue.length; i += 1) {
    const node = queue[i]
    if (Array.isArray(node)) {
      for (const item of node) queue.push(item)
    } else if (isPlainObject(node)) {
      if (typeof node.command === 'string') out.push(node)
      for (const item of Object.values(node)) queue.push(item)
    }
  }
  return out
}

// The `/`- and `~/`-paths inside one launcher's strings.
function launcherPaths(launcher, home) {
  const out = []
  for (const text of stringValues(launcher)) {
    for (const token of text.split(PATH_SEPARATORS)) {
      if (token.startsWith('/')) out.push(token)
      else if (home && token.startsWith('~/')) out.push(join(home, token.slice(2)))
    }
  }
  return out
}

/**
 * Which of `runtimeIds` (directories directly under runtimeRoot) the host
 * configs in `files` use, by rules (a) and (b) above. Never throws. `uses`
 * maps each id in use to what uses it ({file, label, command, entry}; command
 * and entry are null when only a value outside a launcher names it);
 * `unknown` lists each file that exists but proves nothing, with why; `files`
 * says, per file, missing, unknown, checked or referenced.
 */
export function scanRuntimeReferences({ runtimeRoot, runtimeIds, files, home = null }) {
  const root = tryCanonicalize(runtimeRoot)
  const runtimes = runtimeIds.map((id) => ({ id, dir: root === null ? null : join(root, id) }))
  const uses = new Map()
  const unknown = []
  const checked = []
  const use = (id, found) => uses.set(id, [...(uses.get(id) ?? []), found])
  let paths = 0
  for (const file of files) {
    const config = readReferenceFile(file)
    if (config.state === 'missing') {
      checked.push({ file, status: 'missing' })
      continue
    }
    if (config.state === 'unknown') {
      unknown.push({ file, reason: config.reason })
      checked.push({ file, status: 'unknown', reason: config.reason })
      continue
    }
    const label = REFERENCE_LABELS.get(basename(file)) ?? file
    const found = new Set()
    const launchers = findLaunchers(config.value)
    let tooMany = false
    for (const launcher of launchers) {
      const strings = stringValues(launcher)
      const candidates = launcherPaths(launcher, home)
      paths += candidates.length
      if (paths > MAX_LAUNCHER_PATHS) {
        tooMany = true
        break
      }
      const resolved = candidates.map(tryCanonicalize).filter((path) => path !== null)
      for (const { id, dir } of runtimes) {
        const named = strings.some((text) => namesRuntime(text, id, dir, home))
        if (!named && !(dir !== null && resolved.some((path) => isUnder(dir, path)))) continue
        found.add(id)
        const entry = Array.isArray(launcher.args) && typeof launcher.args[0] === 'string' ? launcher.args[0] : null
        use(id, { file, label, command: launcher.command, entry })
      }
    }
    if (tooMany) {
      const reason = `names more than ${MAX_LAUNCHER_PATHS} paths in its launchers, too many to check`
      unknown.push({ file, reason })
      checked.push({ file, status: 'unknown', reason })
      continue
    }
    // (a) holds for a value outside any launcher too: a runtime named only there
    const values = stringValues(config.value)
    for (const { id, dir } of runtimes) {
      if (found.has(id) || !values.some((text) => namesRuntime(text, id, dir, home))) continue
      found.add(id)
      use(id, { file, label, command: null, entry: null })
    }
    checked.push({ file, status: found.size > 0 ? 'referenced' : 'checked' })
  }
  return { uses, unknown, files: checked }
}

/**
 * Is `runtimeId` still used by a host config in `files`? The gate the
 * installer consults before it prunes an older runtime after an install, or
 * removes the one a failed install published. Never throws. Status, in
 * precedence order:
 *   'referenced'   — a config uses it (scanRuntimeReferences)
 *   'unknown'      — none does, but a file exists that proves nothing: retain
 *   'unreferenced' — every file is missing or readable without using it
 */
export function classifyRuntimeReference({ runtimeRoot, runtimeId, files, home = null }) {
  const scan = scanRuntimeReferences({ runtimeRoot, runtimeIds: [runtimeId], files, home })
  const matches = (scan.uses.get(runtimeId) ?? []).map(({ file, command, entry }) => ({ file, command, entry }))
  const status = matches.length > 0 ? 'referenced' : scan.unknown.length > 0 ? 'unknown' : 'unreferenced'
  return { status, runtimeId, matches, files: scan.files }
}

// ── which runtimes a running process still uses (issue #294) ────────────
// A running MCP server keeps working after its runtime is deleted, but every
// Copilot answer watcher it hands out runs <its runtime>/dist/watch-cli.js,
// and a hook still running from it may spawn more of its files. So a runtime
// any running process names on its command line (runtimeIdInText) is kept.
// The checker and its own ancestors are not counted: a recheck names the id
// it checks. A process started through a symlinked alias, or with a path
// relative to the runtime, names no id and is not seen; a host config that
// launches it that way is caught by rule (b) above.

const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps']

/**
 * Every process, from `ps -A -ww -o pid=,ppid=,command=`. Never throws:
 * {ok:false, reason} when ps is missing, fails, or does not list this process
 * itself, which no complete listing can leave out.
 */
export function listProcesses({ psBin = PS_CANDIDATES.find((path) => existsSync(path)) } = {}) {
  if (!psBin) return { ok: false, reason: 'ps was not found' }
  let output
  try {
    output = execFileSync(psBin, ['-A', '-ww', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
    })
  } catch (err) {
    return { ok: false, reason: `ps failed (${errorText(err)})` }
  }
  const processes = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line)
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' })
  }
  if (!processes.some((p) => p.pid === process.pid)) return { ok: false, reason: 'ps did not list this process' }
  return { ok: true, processes }
}

/** The pids in `processes` whose command line names `runtimeId`, leaving out `selfPid` and its ancestors. */
export function processesUsingRuntime(processes, runtimeId, selfPid = process.pid) {
  const parents = new Map(processes.map((p) => [p.pid, p.ppid]))
  const own = new Set()
  for (let pid = selfPid; pid > 0 && !own.has(pid); pid = parents.get(pid) ?? 0) own.add(pid)
  return processes
    .filter((p) => !own.has(p.pid) && runtimeIdInText(p.command, runtimeId))
    .map((p) => p.pid)
    .sort((a, b) => a - b)
}

// The version a runtime folder's own manifest declares, when that manifest is
// a plain file naming this folder as an Agent Inbox runtime; else undefined.
function declaredVersion(dir, name, manifestFileName) {
  try {
    const manifest = readManifestFile(dir, manifestFileName)
    if (!isPlainObject(manifest) || manifest.product !== RUNTIME_PRODUCT || manifest.runtimeId !== name) return undefined
    return typeof manifest.packageVersion === 'string' ? manifest.packageVersion : null
  } catch {
    return undefined
  }
}

/**
 * Every runtime under runtimeRoot and whether prune-runtimes.sh may remove it
 * (issue #294). Read-only: it lists the root, reads manifests and host
 * configs and runs `ps`; it never writes, locks or cleans trash. A runtime is
 * a real directory directly in the root: never a symlink (never followed),
 * never a `.`-name (the `.trash-*` folders an interrupted prune leaves
 * included), never anything outside the root. `only` checks that one alone.
 * Each gets a verdict, in this order:
 *   current       — `current`, the runtime the caller runs from: kept
 *   not-a-runtime — no manifest naming this folder as a runtime: left alone
 *   used          — a host config uses it (`usedBy` names which): kept
 *   in-use        — a running process names it (`pids`): kept
 *   unused        — none of these: prune-runtimes.sh removes it
 * `status` is 'unknown', with `reason` and no runtimes, when a host config
 * exists but proves nothing or the process list cannot be read: nothing may
 * then be removed at all.
 */
export function findUnusedRuntimes({
  runtimeRoot,
  home,
  current = null,
  only = null,
  manifestFileName = DEFAULT_MANIFEST_FILE,
  processList = listProcesses,
}) {
  let names
  try {
    names = readdirSync(runtimeRoot)
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'ok', runtimes: [] }
    return { status: 'unknown', reason: `${runtimeRoot} cannot be listed (${errorText(err)})`, runtimes: [] }
  }
  const runtimes = []
  const candidates = []
  for (const name of names.sort()) {
    if (name.startsWith('.') || (only !== null && name !== only)) continue
    const dir = join(runtimeRoot, name)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const version = declaredVersion(dir, name, manifestFileName)
    if (name === current) runtimes.push({ runtimeId: name, version: version ?? null, verdict: 'current', usedBy: [], pids: [] })
    else if (version === undefined) runtimes.push({ runtimeId: name, version: null, verdict: 'not-a-runtime', usedBy: [], pids: [] })
    else candidates.push({ runtimeId: name, version })
  }
  if (candidates.length > 0) {
    const scan = scanRuntimeReferences({ runtimeRoot, runtimeIds: candidates.map((c) => c.runtimeId), files: referenceFiles(home), home })
    if (scan.unknown.length > 0) {
      return { status: 'unknown', reason: scan.unknown.map(({ file, reason }) => `${file} ${reason}`).join('; '), runtimes: [] }
    }
    const listed = processList()
    if (!listed.ok) return { status: 'unknown', reason: `the running processes cannot be listed: ${listed.reason}`, runtimes: [] }
    for (const { runtimeId, version } of candidates) {
      const usedBy = [...new Set((scan.uses.get(runtimeId) ?? []).map((found) => found.label))]
      const pids = processesUsingRuntime(listed.processes, runtimeId)
      const verdict = usedBy.length > 0 ? 'used' : pids.length > 0 ? 'in-use' : 'unused'
      runtimes.push({ runtimeId, version, verdict, usedBy, pids })
    }
  }
  runtimes.sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0))
  return { status: 'ok', runtimes }
}

/**
 * Classify a host's MCP server REGISTRATION (Claude/Copilot-style
 * `{mcpServers: {<server>: {command, args:[entry, ...]}}}` config) against a
 * managed runtime root — structurally, the same canonical-identity rules as
 * classifyRuntimeConfig(), but starting from the top-level `--file` +
 * `--server` name a packaged installer already knows, instead of two
 * already-resolved paths. This is the gate a packaged install/upgrade/
 * uninstall consults before ever touching (replacing OR removing) a host's
 * existing registration for `server` — it must never assume "no entry yet"
 * and "an entry we don't recognize" are the same thing.
 *
 * Never throws. Status precedence, distinguishing the two cases that would
 * otherwise both look like "there's nothing to work with":
 *   'absent'  — the file does not exist, OR it parses fine but has no
 *               `mcpServers.<server>` entry at all. Nothing to conflict
 *               with — safe to WRITE a fresh registration.
 *   'unknown' — the file exists but could not be read, or is not valid
 *               JSON, or `mcpServers.<server>` exists but is not a
 *               well-formed `{command, args:[entry, ...]}` shape. Retain:
 *               something is there, but it cannot be safely characterized.
 *   'owned' | 'custom' | 'split' — delegated to classifyRuntimeConfig() once
 *               a `{command, args[0]}` pair has actually been found; only
 *               'owned' is safe for an installer to replace or remove.
 * `node`/`entry` are included whenever a candidate pair was found (i.e. for
 * every status except 'absent' and the file-level 'unknown' cases).
 */
export function classifyRuntimeRegistration({ filePath, runtimeRoot, server = 'agent-inbox', manifestFileName = DEFAULT_MANIFEST_FILE }) {
  if (!existsSync(filePath)) {
    return { status: 'absent', server, reason: 'registration file does not exist' }
  }
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    return { status: 'unknown', server, reason: `registration file is unreadable: ${err.message}` }
  }
  let parsed
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch (err) {
    return { status: 'unknown', server, reason: `registration file is not valid JSON: ${err.message}` }
  }

  const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined
  const serverEntry = isPlainObject(servers) ? servers[server] : undefined
  if (serverEntry === undefined) {
    return { status: 'absent', server, reason: `no mcpServers.${server} entry` }
  }
  if (!isPlainObject(serverEntry) || typeof serverEntry.command !== 'string'
    || !Array.isArray(serverEntry.args) || typeof serverEntry.args[0] !== 'string') {
    return { status: 'unknown', server, reason: `mcpServers.${server} is not a well-formed {command, args:[entry, ...]} registration` }
  }

  const node = serverEntry.command
  const entry = serverEntry.args[0]
  const classified = classifyRuntimeConfig({ nodeBinPath: node, entryPath: entry, runtimeRoot, manifestFileName })
  return { ...classified, server, node, entry }
}

/**
 * Write `contents` (a string) to `filePath` atomically: a temp file in the
 * SAME directory, then a rename over the destination. If `filePath` is
 * itself a symlink, the write follows it and lands on the real target (the
 * symlink itself is left in place) — the same "preserve the symlink target"
 * rule scripts/install-agents.sh already applies to instruction files.
 */
export function writeFileAtomic(filePath, contents) {
  let target = filePath
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) {
    target = realpathSync(filePath)
  }
  mkdirSync(dirname(target), { recursive: true })
  const tempPath = join(dirname(target), `.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tempPath, contents)
  try {
    renameSync(tempPath, target)
  } catch (err) {
    try { unlinkSync(tempPath) } catch { /* best effort cleanup */ }
    throw err
  }
}

/**
 * Deep-merge `patch` into `base`. Plain objects merge key-by-key,
 * recursively; anything else in `patch` (arrays, strings, numbers, booleans,
 * null) REPLACES the corresponding value in `base` wholesale. This is a
 * deliberately simple, predictable contract for a Bash caller passing a
 * small JSON fragment — not a general-purpose JSON-patch implementation.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepMergeJson(base, patch) {
  if (!isPlainObject(patch)) return patch
  const out = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMergeJson(out[key], value) : value
  }
  return out
}

/**
 * Read the JSON file at `filePath` (or start from `{}` if it does not exist
 * and `createIfMissing` is true), deep-merge `patch` into it, and write the
 * result back atomically. Returns the final merged object.
 */
export function mergeJsonAtomic({ filePath, patch, createIfMissing = true }) {
  let base = {}
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf8')
    base = raw.trim() === '' ? {} : JSON.parse(raw)
  } else if (!createIfMissing) {
    throw new Error(`no such file: ${filePath}`)
  }
  const merged = deepMergeJson(base, patch)
  writeFileAtomic(filePath, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

// ── the Claude Code hook-settings transformation ───────────────────────
// A single, pure (read-only w.r.t. --settings) transformation that reproduces
// scripts/install-hooks.sh's jq pipeline in plain Node, so a Bash caller can
// get the merged settings.json body without jq. This function never touches
// disk itself — see runHooksCmd below for why that split is deliberate.
//
// The five hook events / six subcommands this project registers into
// ~/.claude/settings.json (docs/hooks.md's "Events → subcommands" table).
// Recognizing "one of ours" by this exact {args:[entry, subcommand]} shape —
// rather than by string-matching a specific entry path — is what lets a
// runtime upgrade (a NEW entry path, inside a new runtimeId directory) still
// find and replace an OLDER install's entries.
const HOOK_SUBCOMMANDS = new Set(['notification', 'session-start', 'session-end', 'prompt-submit', 'stop', 'watch'])
const LEGACY_HOOK_COMMAND_RE = /agent-inbox-(pending|watch)\.sh/

/** The exact hook-entry block this project installs, keyed by Claude Code event name. */
export function buildHooksSettingsBlock(nodeBinPath, entryPath) {
  const h = (sub, timeout, extra = {}) => ({ type: 'command', command: nodeBinPath, args: [entryPath, sub], timeout, ...extra })
  return {
    Notification: [{ hooks: [h('notification', 5)] }],
    SessionStart: [{ matcher: 'startup|resume', hooks: [h('session-start', 5)] }],
    SessionEnd: [{ hooks: [h('session-end', 5)] }],
    UserPromptSubmit: [{ hooks: [h('prompt-submit', 10)] }],
    Stop: [
      {
        hooks: [
          h('stop', 10, { statusMessage: 'Checking agent-inbox for answered questions…' }),
          h('watch', 1800, {
            statusMessage: 'Arming agent-inbox answer watcher…',
            asyncRewake: true,
            rewakeSummary: 'Agent Inbox: your answer arrived',
          }),
        ],
      },
    ],
  }
}

/** Is `entry` one of OUR hook entries — {command, args:[entryPath, subcommand]}? */
function isCandidateHookEntry(entry) {
  if (!isPlainObject(entry) || !Array.isArray(entry.args) || entry.args.length !== 2) return false
  return HOOK_SUBCOMMANDS.has(entry.args[1])
}

/** Is `entry` one of the two legacy, hand-written `.sh` Stop hooks (CLAUDE.md's "superseded" scripts)? */
function isLegacyHookEntry(entry) {
  return isPlainObject(entry) && typeof entry.command === 'string' && LEGACY_HOOK_COMMAND_RE.test(entry.command)
}

/** Every hook entry across every event/group that looks like ours, flattened. */
function collectCandidateHookEntries(settings) {
  const out = []
  const hooksObj = isPlainObject(settings) ? settings.hooks : undefined
  if (!isPlainObject(hooksObj)) return out
  for (const groups of Object.values(hooksObj)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const hooks = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : []
      for (const entry of hooks) {
        if (isCandidateHookEntry(entry)) out.push(entry)
      }
    }
  }
  return out
}

/**
 * Strip the hook entries `remove` picks (by default every one that looks like
 * ours by shape, see isCandidateHookEntry) from `settings.hooks`, plus — when
 * `migrate` is true — the two legacy `.sh` Stop hooks. Empty groups/event-keys/
 * the `hooks` key itself are pruned so a stripped-to-nothing settings.json
 * does not keep a trailing `"hooks": {}`. Never mutates its input.
 */
export function stripAgentInboxHookEntries(settings, { migrate = false, remove = isCandidateHookEntry } = {}) {
  const base = isPlainObject(settings) ? { ...settings } : {}
  const hooksObj = isPlainObject(base.hooks) ? base.hooks : {}
  const nextHooks = {}
  for (const [event, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups
      continue
    }
    const nextGroups = groups
      .map((group) => {
        const hooks = isPlainObject(group) && Array.isArray(group.hooks) ? group.hooks : []
        const kept = hooks.filter((entry) => !(remove(entry) || (migrate && isLegacyHookEntry(entry))))
        return { ...group, hooks: kept }
      })
      .filter((group) => group.hooks.length > 0)
    if (nextGroups.length > 0) nextHooks[event] = nextGroups
  }
  if (Object.keys(nextHooks).length > 0) base.hooks = nextHooks
  else delete base.hooks
  return base
}

/** Append `block`'s groups as SIBLINGS of whatever is already registered per event (never replaces another tool's hooks for the same event). */
export function appendHooksBlock(settings, block) {
  const base = isPlainObject(settings) ? { ...settings } : {}
  const hooksObj = isPlainObject(base.hooks) ? { ...base.hooks } : {}
  for (const [event, groups] of Object.entries(block)) {
    hooksObj[event] = [...(Array.isArray(hooksObj[event]) ? hooksObj[event] : []), ...groups]
  }
  base.hooks = hooksObj
  return base
}

// ── which Agent Inbox install a hook entry runs (issue #218) ─────────────
// Two installs' hook sets in one settings file run every hook twice: two
// nudges and two answer watchers per turn. Both install modes sort every
// agent-inbox-shaped entry by one rule (sortHookEntries) before adding their
// set. Its launcher classification is the one src/agent-hosts.ts applies when
// Setup reports Claude's hooks (classifyLauncher there), with Setup's
// "unknown" split into dead, elsewhere and unknown; test/agent-hosts.test.ts
// holds the two to agreement.

const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024
const RUNTIME_PRODUCT = 'agent-inbox-runtime'

/** The install folder whose dist/hook-cli.js the canonical `file` is, or null. */
function hookCliDir(file) {
  return basename(file) === 'hook-cli.js' && basename(dirname(file)) === 'dist' ? dirname(dirname(file)) : null
}

/** Is the install folder `dir` a source checkout: beside a package.json named agent-inbox? */
function isCheckout(dir) {
  try {
    const st = lstatSync(join(dir, 'package.json'))
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON_BYTES) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return isPlainObject(pkg) && pkg.name === 'agent-inbox'
  } catch {
    return false
  }
}

// realpathSync applies a `..` before it follows the symlink in front of it, and
// the OS does not, so a path realpathSync cannot resolve may still run (#228).
function statsAsWritten(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The runtime folder `dir`, outside the runtime root (copied or extracted
 * elsewhere, or installed under another root): another Agent Inbox install
 * when its manifest verifies and the command runs its own Node, else unknown.
 */
function runtimeElsewhere(dir, node, manifestFileName) {
  if (node === null || !isUnder(dir, node)) return { kind: 'unknown' }
  try {
    const manifest = verifyPayload({ root: dir, manifestFileName, expect: { product: RUNTIME_PRODUCT } })
    return { kind: 'elsewhere', runtimeId: manifest.runtimeId, version: manifest.packageVersion, path: dir }
  } catch (err) {
    return { kind: 'unknown', path: dir, problem: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Which Agent Inbox install the hook launcher {command, entry} runs. Never throws.
 *   runtime   — node and entry in one verified runtime directory under runtimeRoot
 *   elsewhere — node and entry in one verified runtime directory outside it (#232)
 *   checkout  — a source checkout's dist/hook-cli.js (isCheckout)
 *   other     — identifiably something else, such as another tool's look-alike
 *   dead      — the entry, or a command given as a path, can no longer be found, even by the OS
 *   unknown   — it runs, but from a split pair, a runtime folder that does not
 *               verify (its `path`, with the verifier's `problem`), or a path
 *               only the OS resolves
 */
function classifyHookLauncher({ command, entry, runtimeRoot, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  if (typeof command !== 'string' || typeof entry !== 'string') return { kind: 'unknown' }
  // an entry that is not a path (`npx tsx src/…`) is somebody's own command
  if (!isAbsolute(entry)) return { kind: 'other' }
  const file = tryCanonicalize(entry)
  // a command looked up on PATH is never inside a runtime directory
  const node = isAbsolute(command) ? tryCanonicalize(command) : null
  if (!file || (isAbsolute(command) && !node)) {
    const gone = (!file && !statsAsWritten(entry)) || (isAbsolute(command) && !node && !statsAsWritten(command))
    return { kind: gone ? 'dead' : 'unknown' }
  }
  const root = runtimeRoot ? tryCanonicalize(runtimeRoot) : null
  const nodeIn = root !== null && node !== null && isUnder(root, node)
  const fileIn = root !== null && isUnder(root, file)
  if (nodeIn || fileIn) {
    if (!nodeIn || !fileIn) return { kind: 'unknown' }
    const owned = classifyRuntimeConfig({ nodeBinPath: node, entryPath: file, runtimeRoot: root, manifestFileName })
    if (owned.status === 'owned') return { kind: 'runtime', runtimeId: owned.runtimeId, version: owned.version, path: owned.path }
    return owned.problem ? { kind: 'unknown', path: owned.path, problem: owned.problem } : { kind: 'unknown' }
  }
  const dir = hookCliDir(file)
  if (dir === null) return { kind: 'other' }
  // a runtime's layout is never another tool's, wherever it is (#232)
  if (existsSync(join(dir, manifestFileName))) return runtimeElsewhere(dir, node, manifestFileName)
  return isCheckout(dir) ? { kind: 'checkout', path: dir } : { kind: 'other' }
}

// The install directory as the settings file names it, when that is the
// install's own directory: the other checkout's installer matches its entries
// by that exact string, so its uninstall command must use it too.
function installDirAsWritten(entry, canonicalDir) {
  const dir = dirname(dirname(entry))
  return join(dir, 'dist', 'hook-cli.js') === entry && tryCanonicalize(dir) === canonicalDir ? dir : canonicalDir
}

/**
 * Sort every agent-inbox-shaped hook entry in `settings` (isCandidateHookEntry):
 *   own          — the installer's own (`isOwn`), replaced as before
 *   replaceable  — another Agent Inbox install's (a verified runtime under the
 *                  runtime root or outside it, a checkout), or a dead
 *                  dist/hook-cli.js: only --replace-existing removes these
 *   unverifiable — a dist/hook-cli.js that runs but cannot be verified: never
 *                  removed. Each is {entry, problem?}, the problem saying why
 *                  its runtime folder does not verify, when that is the reason.
 *   others       — another tool's hook that only looks like ours: never removed
 * Without a runtime root nothing can be verified, so nothing is replaceable.
 */
function sortHookEntries({ settings, isOwn, runtimeRoot, manifestFileName }) {
  const sorted = { own: [], replaceable: [], unverifiable: [], others: [] }
  const seen = new Map()
  for (const entry of collectCandidateHookEntries(settings)) {
    const key = JSON.stringify([entry.command, entry.args[0]])
    if (!seen.has(key)) seen.set(key, classifyHookLauncher({ command: entry.command, entry: entry.args[0], runtimeRoot, manifestFileName }))
    const owner = seen.get(key)
    const hookCli = typeof entry.args[0] === 'string' && entry.args[0].endsWith('/dist/hook-cli.js')
    if (isOwn(entry, owner)) sorted.own.push(entry)
    else if (!runtimeRoot) sorted.unverifiable.push({ entry })
    else if (owner.kind === 'runtime' || owner.kind === 'elsewhere' || owner.kind === 'checkout') {
      sorted.replaceable.push({ entry, owner: { ...owner, path: installDirAsWritten(entry.args[0], owner.path) } })
    } else if (owner.kind === 'dead' && hookCli) {
      sorted.replaceable.push({ entry, owner: { kind: 'dead', path: dirname(dirname(entry.args[0])) } })
    } else if (owner.kind === 'unknown' && hookCli) {
      sorted.unverifiable.push(owner.problem
        ? { entry, problem: `${installDirAsWritten(entry.args[0], owner.path)} does not verify as a runtime: ${owner.problem}` }
        : { entry })
    } else sorted.others.push(entry)
  }
  return sorted
}

/** The installs behind `replaceable` entries, first seen first, each with how many of its hooks are there. */
function hookOwners(replaceable) {
  const owners = new Map()
  for (const { owner } of replaceable) {
    const key = `${owner.kind}\0${owner.path}`
    const known = owners.get(key)
    if (known) known.count += 1
    else owners.set(key, { ...owner, count: 1 })
  }
  return [...owners.values()]
}

function describeOwner(owner) {
  const version = owner.version ? `v${owner.version} ` : ''
  if (owner.kind === 'runtime') return `the ${version}Setup runtime at ${owner.path}`
  if (owner.kind === 'elsewhere') return `the ${version}runtime at ${owner.path}, outside Setup's runtime folder`
  if (owner.kind === 'checkout') return `the source checkout at ${owner.path}`
  return `the install at ${owner.path}, which can no longer run`
}

const hookCount = (count) => `${count} hook${count === 1 ? '' : 's'}`

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** One line per launcher (its command, entry and subcommands), each followed by its problem, if any. */
function listEntries(items) {
  const launchers = new Map()
  for (const { entry, problem } of items) {
    const key = JSON.stringify([entry.command, entry.args[0]])
    const known = launchers.get(key) ?? { entry, problem, subcommands: new Set() }
    known.subcommands.add(entry.args[1])
    launchers.set(key, known)
  }
  return [...launchers.values()].flatMap(({ entry, problem, subcommands }) => [
    `  - ${typeof entry.command === 'string' ? `${entry.command} ` : ''}${entry.args[0]} (${[...subcommands].sort().join(', ')})`,
    ...(problem ? [`    ${problem}`] : []),
  ])
}

// Whether `owner`'s own installer can remove its hooks from these settings
// right now: a checkout's removes exactly its entries; a Setup runtime's (any
// version) refuses while anything shaped like ours is not a verified Setup
// runtime's. A dead install has none, and a runtime outside the runtime root
// may be 1.3.2 or older, whose uninstall refuses its own hooks there (#232).
function ownUninstallWorks(owner, sorted) {
  if (owner.kind !== 'checkout' && owner.kind !== 'runtime') return false
  if (!existsSync(join(owner.path, 'scripts', 'install-hooks.sh'))) return false
  return owner.kind === 'checkout' || (sorted.own.length + sorted.unverifiable.length + sorted.others.length === 0
    && sorted.replaceable.every((r) => r.owner.kind === 'runtime'))
}

/** A refusal whose message is complete as written: what is in the way, then the one fix to try first. */
class HookRefusal extends Error {}

/**
 * The refusal for `sorted` (sortHookEntries). What no installer command can
 * clear is named first, to remove by hand, or, when its runtime folder does
 * not verify, to fix in that folder (the verifier says what is wrong).
 * Otherwise the one-step --replace-existing comes first, then each other
 * install's own uninstall that can succeed in this state. `others` lists the
 * look-alikes that block.
 */
function hookRefusal({ settingsPath, sorted, others, installer, uninstall }) {
  const notDone = uninstall ? 'nothing was removed' : 'nothing was written'
  const byHand = [...sorted.unverifiable, ...(uninstall ? others.map((entry) => ({ entry })) : [])]
  if (byHand.length > 0) {
    const fixable = byHand.some((item) => item.problem)
    return new HookRefusal([
      `install-hooks: ${settingsPath} has hooks shaped like Agent Inbox's that this installer cannot attribute to an install:`,
      ...listEntries(byHand),
      ...(fixable ? [
        `They may be another set of Agent Inbox hooks, so ${notDone}.`,
        'To fix a runtime folder that does not verify, delete any file that was added to it (macOS Finder adds .DS_Store files) or reinstall that runtime, then run this installer again.',
        `Or remove them from ${settingsPath} by hand, then run this installer again.`,
      ] : [
        `They may be another set of Agent Inbox hooks, so ${notDone}. Remove them from ${settingsPath} by hand, then run this installer again.`,
      ]),
    ].join('\n'))
  }
  const owners = hookOwners(sorted.replaceable)
  const lines = []
  if (owners.length > 0) {
    lines.push(`install-hooks: ${settingsPath} ${uninstall ? 'also' : 'already'} has Claude hooks from another Agent Inbox install:`)
    lines.push(...owners.map((owner) => `  - ${describeOwner(owner)} (${hookCount(owner.count)})`))
  }
  if (others.length > 0) {
    lines.push(`install-hooks: ${settingsPath} has other tools' hooks that use Agent Inbox's subcommand names; --replace-existing leaves them in place:`)
    lines.push(...listEntries(others.map((entry) => ({ entry }))))
  }
  const live = owners.some((o) => o.kind !== 'dead')
  lines.push(uninstall || !live ? `${notDone[0].toUpperCase()}${notDone.slice(1)}.`
    : sorted.own.length > 0 ? "This install's hooks are there too, so every hook runs twice. Nothing was written."
      : "Adding this install's hooks beside them would run every hook twice, so nothing was written.")
  lines.push(`Recommended: replace every other Agent Inbox set with this install's hooks in one step${uninstall ? ', then run this uninstall again' : ''}:`)
  lines.push(installer ? `  bash ${shellQuote(installer)} --apply --replace-existing` : '  this installer again with --apply --replace-existing')
  const alternatives = owners.filter((owner) => ownUninstallWorks(owner, sorted))
  if (alternatives.length > 0) {
    lines.push('Or remove them with their own installer first, then run this one again:')
    lines.push(...alternatives.map((owner) => `  bash ${shellQuote(join(owner.path, 'scripts', 'install-hooks.sh'))} --apply --uninstall`))
  }
  return new HookRefusal(lines.join('\n'))
}

function reportReplaced(owners) {
  for (const owner of owners) process.stderr.write(`replacing ${hookCount(owner.count)} of ${describeOwner(owner)}\n`)
}

/**
 * The pure transformation behind the `hooks` CLI subcommand: given the
 * CURRENT settings object, sort its agent-inbox-shaped entries
 * (sortHookEntries, where every verified Setup runtime's are this install's
 * own, and so are those of this install's own runtime folder when it is
 * outside the runtime root) and return the NEW settings object — stripped of
 * our old entries, plus (unless `uninstall`) the fresh block built from
 * `node`/`entry`. Anything else shaped like ours refuses with a HookRefusal
 * unless `force`, as before, except that `replaceExisting` also replaces
 * another Agent Inbox install's hooks and dead ones (telling `onReplace` whose
 * they were) and leaves other tools' look-alikes in place. Never writes
 * anything; the caller decides how (and whether) to persist the result.
 */
export function transformHooksSettings({
  settings,
  node,
  entry,
  runtimeRoot = null,
  force = false,
  uninstall = false,
  migrate = false,
  replaceExisting = false,
  moveOnly = false,
  installer = null,
  settingsPath = 'the settings file',
  onReplace = () => {},
  manifestFileName = DEFAULT_MANIFEST_FILE,
}) {
  const base = isPlainObject(settings) ? settings : {}
  let remove = isCandidateHookEntry
  if (!force) {
    const self = runtimeRoot ? tryCanonicalize(dirname(dirname(entry))) : null
    const isOwn = (_, owner) => owner.kind === 'runtime' || (owner.kind === 'elsewhere' && owner.path === self)
    const sorted = sortHookEntries({ settings: base, isOwn, runtimeRoot, manifestFileName })
    const replace = replaceExisting && !uninstall
    if (sorted.unverifiable.length > 0 || (!replace && sorted.replaceable.length + sorted.others.length > 0)) {
      throw hookRefusal({ settingsPath, sorted, others: replace ? [] : sorted.others, installer, uninstall })
    }

    // Setup's `hooks` target (#206) moves a Setup runtime's set, never adds one.
    if (moveOnly && sorted.own.length === 0) {
      throw new HookRefusal(`install-hooks: ${settingsPath} has no Claude hooks from a Setup runtime to move, so nothing was written.`)
    }
    const removed = new Set([...sorted.own, ...(replace ? sorted.replaceable.map((r) => r.entry) : [])])
    if (replace) onReplace(hookOwners(sorted.replaceable))
    remove = (hook) => removed.has(hook)
  }

  const stripped = stripAgentInboxHookEntries(base, { migrate, remove })
  if (uninstall) return stripped

  return appendHooksBlock(stripped, buildHooksSettingsBlock(node, entry))
}

// ── CLI ─────────────────────────────────────────────────────────────────
// Simple, greppable stdout JSON — no jq required. Bash callers can match
// `"status":"owned"` etc. directly, or pipe through `node -e` for anything
// more structured.

/** A malformed invocation (missing/empty required flag, unknown subcommand) — exits 2, distinct from a runtime/data error (exits 1). */
export class UsageError extends Error {}

function requireString(values, key, command) {
  const value = values[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`${command}: --${key} <value> is required`)
  }
  return value
}

function runClassifyCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'node-bin': { type: 'string' },
      entry: { type: 'string' },
      'runtime-root': { type: 'string' },
      'manifest-file': { type: 'string' },
    },
  })
  const nodeBin = requireString(values, 'node-bin', 'classify')
  const entry = requireString(values, 'entry', 'classify')
  const runtimeRoot = requireString(values, 'runtime-root', 'classify')
  const result = classifyRuntimeConfig({
    nodeBinPath: resolve(nodeBin),
    entryPath: resolve(entry),
    runtimeRoot: resolve(runtimeRoot),
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/**
 * `references` — the installer's prune/rollback safety gate: is
 * `--runtime-id` still used by a host config (scanRuntimeReferences)?
 *
 *   runtime-config.mjs references --runtime-root <abs> --runtime-id <id>
 *     [--home <dir>] [--file <path> ...] [--manifest-file <name>]
 *
 * `--home` reads every host config Setup knows (referenceFiles) under that
 * directory, and expands `~/` paths against it; each `--file` adds one more.
 * stdout: `{status, runtimeId, matches, files}` JSON — always, on success.
 * exit 0: always, for any combination of missing/valid/invalid input files;
 *   `status` (not the exit code) carries the referenced/unreferenced/unknown
 *   verdict, exactly like `classify`'s status field.
 * exit 2: a required flag is missing/empty (no --runtime-root, --runtime-id,
 *   or neither --home nor a --file).
 */
function runReferencesCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-root': { type: 'string' },
      'runtime-id': { type: 'string' },
      home: { type: 'string' },
      file: { type: 'string', multiple: true },
      'manifest-file': { type: 'string' },
    },
  })
  const runtimeRoot = resolve(requireString(values, 'runtime-root', 'references'))
  const runtimeId = requireString(values, 'runtime-id', 'references')
  const home = values.home ? resolve(values.home) : null
  const files = [...(home ? referenceFiles(home) : []), ...(values.file ?? []).map((f) => resolve(f))]
  if (files.length === 0) {
    throw new UsageError('references: --home <dir> or at least one --file <path> is required')
  }
  const result = classifyRuntimeReference({ runtimeRoot, runtimeId, files, home })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/**
 * `unused` — Setup's prune gate (issue #294): every runtime under
 * --runtime-root, and whether anything still uses it (findUnusedRuntimes).
 * Read-only: no write, no lock, no trash cleanup.
 *
 *   runtime-config.mjs unused --runtime-root <abs> --home <abs>
 *     [--current <runtimeId>] [--runtime-id <runtimeId>] [--manifest-file <name>]
 *
 * --current is the runtime the caller runs from, always kept; --runtime-id
 * checks that one runtime alone, as prune-runtimes.sh does again just before
 * it removes one.
 * stdout: {status, reason?, runtimes: [{runtimeId, version, verdict, usedBy, pids}]}
 * exit 0: always, whatever the verdicts; `status` carries 'unknown'.
 * exit 2: a required flag is missing/empty, or a path is not absolute.
 */
function runUnusedCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-root': { type: 'string' },
      home: { type: 'string' },
      current: { type: 'string' },
      'runtime-id': { type: 'string' },
      'manifest-file': { type: 'string' },
    },
  })
  const runtimeRoot = requireString(values, 'runtime-root', 'unused')
  const home = requireString(values, 'home', 'unused')
  if (!isAbsolute(runtimeRoot) || !isAbsolute(home)) {
    throw new UsageError('unused: --runtime-root and --home must be absolute paths')
  }
  const result = findUnusedRuntimes({
    runtimeRoot,
    home,
    current: values.current ?? null,
    only: values['runtime-id'] ?? null,
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/**
 * `registration` — the install/upgrade/uninstall safety gate for a host's
 * MCP server registration:
 *
 *   runtime-config.mjs registration --file <host-config> --runtime-root <abs>
 *     [--server agent-inbox] [--manifest-file <name>]
 *
 * stdout: `{status, server, node?, entry?, ...}` JSON — always, on success.
 *   status is one of absent|owned|custom|split|unknown (see
 *   classifyRuntimeRegistration() above for the exact precedence rules).
 * exit 0: always, for any file/registration state — the verdict rides in
 *   `status`, never the exit code.
 * exit 2: a required flag is missing/empty (no --file or --runtime-root).
 */
function runRegistrationCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      'runtime-root': { type: 'string' },
      server: { type: 'string' },
      'manifest-file': { type: 'string' },
    },
  })
  const filePath = resolve(requireString(values, 'file', 'registration'))
  const runtimeRoot = resolve(requireString(values, 'runtime-root', 'registration'))
  const result = classifyRuntimeRegistration({
    filePath,
    runtimeRoot,
    server: values.server ?? 'agent-inbox',
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runMergeJsonCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string' },
      patch: { type: 'string' },
      'no-create': { type: 'boolean' },
    },
  })
  const file = requireString(values, 'file', 'merge-json')
  const patchJson = requireString(values, 'patch', 'merge-json')
  let patch
  try {
    patch = JSON.parse(patchJson)
  } catch (err) {
    throw new UsageError(`merge-json: --patch is not valid JSON (${err.message})`)
  }
  const merged = mergeJsonAtomic({
    filePath: resolve(file),
    patch,
    createIfMissing: !values['no-create'],
  })
  process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`)
}

/**
 * `hooks` — the packaged hook-settings transformation, callable from Bash
 * with no jq. Reads --settings (defaulting to `{}` if the file does not
 * exist), computes the merged/uninstalled result, and prints the fully
 * formatted JSON to stdout. It deliberately never writes --settings itself:
 * the caller (an installer script) owns backup + atomic write, exactly as
 * install-hooks.sh's own --apply step already does with its jq output — this
 * command only replaces the jq computation, not the write path.
 *
 *   runtime-config.mjs hooks --settings <path> --entry <abs>
 *     [--node <abs>]         required unless --uninstall
 *     [--runtime-root <abs>] enables ownership verification of any EXISTING
 *                            agent-inbox-shaped hook entries (ownership is
 *                            'unknown', and thus gated, without it)
 *     [--force]              replace/remove existing entries even when their
 *                            ownership is not provably ours
 *     [--uninstall]          strip agent-inbox entries instead of installing
 *     [--migrate]            also strip the two legacy hand-written .sh Stop
 *                            hooks (agent-inbox-pending.sh / agent-inbox-watch.sh)
 *     [--replace-existing]   also replace another Agent Inbox install's hooks
 *                            and dead ones, leaving other tools' look-alikes
 *                            in place (issue #218); not with --uninstall
 *     [--move-only]          Setup's move (#206): exit 1 and print nothing
 *                            unless a Setup runtime's hooks are there to
 *                            replace; not with --uninstall or --force
 *     [--installer <abs>]    the install-hooks.sh a refusal tells the human to re-run
 *     [--manifest-file <name>]
 *
 * stdout: the fully formatted (2-space, trailing-newline) merged settings
 *   JSON on success. Nothing else is ever written to stdout.
 * exit 0: success (including a --uninstall or fresh-install no-op).
 * exit 1: --settings exists but is not valid JSON, OR existing agent-inbox-
 *   shaped entries are neither a verified Setup runtime's nor this runtime
 *   folder's own, and neither --force nor (when installing, and only for what
 *   sortHookEntries calls replaceable or another tool's) --replace-existing
 *   was given. stderr names what is in the way and the one fix to try first.
 * exit 2: a required flag is missing/empty, or the subcommand is unknown.
 */
function runHooksCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      settings: { type: 'string' },
      node: { type: 'string' },
      entry: { type: 'string' },
      'runtime-root': { type: 'string' },
      'manifest-file': { type: 'string' },
      force: { type: 'boolean' },
      uninstall: { type: 'boolean' },
      migrate: { type: 'boolean' },
      'replace-existing': { type: 'boolean' },
      'move-only': { type: 'boolean' },
      installer: { type: 'string' },
    },
  })

  const settingsPath = resolve(requireString(values, 'settings', 'hooks'))
  const entry = resolve(requireString(values, 'entry', 'hooks'))
  const node = values.uninstall ? (values.node ? resolve(values.node) : null) : resolve(requireString(values, 'node', 'hooks'))
  const runtimeRoot = values['runtime-root'] ? resolve(values['runtime-root']) : null
  if (values.uninstall && values['replace-existing']) {
    throw new UsageError('hooks: --replace-existing installs one set in place of every other; it cannot be combined with --uninstall')
  }
  if (values['move-only'] && (values.uninstall || values.force)) {
    throw new UsageError('hooks: --move-only moves a Setup runtime\'s set; it cannot be combined with --uninstall or --force')
  }

  const result = transformHooksSettings({
    settings: readSettingsFile(settingsPath),
    node,
    entry,
    runtimeRoot,
    force: !!values.force,
    uninstall: !!values.uninstall,
    migrate: !!values.migrate,
    replaceExisting: !!values['replace-existing'],
    moveOnly: !!values['move-only'],
    installer: values.installer ?? null,
    settingsPath,
    onReplace: reportReplaced,
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

/** A settings file's JSON; a missing or blank file holds no settings. */
function readSettingsFile(settingsPath) {
  if (!existsSync(settingsPath)) return {}
  const raw = readFileSync(settingsPath, 'utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON — refusing to touch it (${err.message})`)
  }
}

/**
 * `foreign-hooks` — a source checkout's guard against adding a second hook
 * set (issue #218). install-hooks.sh merges in checkout mode with jq; this
 * sorts every agent-inbox-shaped entry in --settings by sortHookEntries, with
 * entries running --entry as this install's own.
 *
 *   runtime-config.mjs foreign-hooks --settings <path> --entry <this install's entry>
 *     --runtime-root <abs> [--installer <abs>] [--replace-existing] [--manifest-file <name>]
 *
 * stdout: a JSON array of the entries --replace-existing removes, each
 *   {command, args, owner: {kind, path, runtimeId?, version?}}, where kind is
 *   runtime, elsewhere (a verified runtime outside the runtime root), checkout
 *   or dead; [] when none.
 * exit 0: nothing stands in the way; another tool's look-alike never does.
 * exit 1: another Agent Inbox install's hooks, or dead ones, are there and
 *   --replace-existing was not given; an entry runs but cannot be verified
 *   (flag or not); or --settings is not valid JSON. stderr names what is in
 *   the way and the one fix to try first.
 * exit 2: a required flag is missing/empty.
 */
function runForeignHooksCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      settings: { type: 'string' },
      entry: { type: 'string' },
      'runtime-root': { type: 'string' },
      installer: { type: 'string' },
      'replace-existing': { type: 'boolean' },
      'manifest-file': { type: 'string' },
    },
  })
  const settingsPath = resolve(requireString(values, 'settings', 'foreign-hooks'))
  const selfEntry = requireString(values, 'entry', 'foreign-hooks')
  const runtimeRoot = resolve(requireString(values, 'runtime-root', 'foreign-hooks'))
  const replace = !!values['replace-existing']

  const sorted = sortHookEntries({
    settings: readSettingsFile(settingsPath),
    isOwn: (hook) => hook.args[0] === selfEntry,
    runtimeRoot,
    manifestFileName: values['manifest-file'] ?? DEFAULT_MANIFEST_FILE,
  })
  if (sorted.unverifiable.length > 0 || (!replace && sorted.replaceable.length > 0)) {
    throw hookRefusal({ settingsPath, sorted, others: [], installer: values.installer ?? null, uninstall: false })
  }
  const removed = replace ? sorted.replaceable : []
  reportReplaced(hookOwners(removed))
  process.stdout.write(`${JSON.stringify(removed.map(({ entry, owner }) => ({ command: entry.command, args: entry.args, owner })))}\n`)
}

function main(argv) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'classify': runClassifyCmd(rest); break
      case 'references': runReferencesCmd(rest); break
      case 'unused': runUnusedCmd(rest); break
      case 'registration': runRegistrationCmd(rest); break
      case 'merge-json': runMergeJsonCmd(rest); break
      case 'hooks': runHooksCmd(rest); break
      case 'foreign-hooks': runForeignHooksCmd(rest); break
      default:
        throw new UsageError('usage: runtime-config.mjs <classify|references|unused|registration|merge-json|hooks|foreign-hooks> [flags]')
    }
  } catch (err) {
    process.stderr.write(err instanceof HookRefusal ? `${err.message}\n` : `runtime-config: ${err.message}\n`)
    process.exitCode = err instanceof UsageError ? 2 : 1
  }
}

// See runtime-payload.mjs's isMainModule() doc comment: a naive
// fileURLToPath(import.meta.url) === resolve(process.argv[1]) breaks
// whenever only one side has been canonicalized through a symlinked
// ancestor directory (e.g. macOS's /var -> /private/var, under which every
// staged/installed runtime and os.tmpdir() live) — this helper compares
// realpathSync()-canonicalized paths on both sides instead.
const isMain = isMainModule(import.meta.url)
if (isMain) {
  main(process.argv.slice(2))
}
