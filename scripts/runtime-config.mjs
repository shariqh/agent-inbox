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
//            it resolves to has no valid manifest. Retain rather than assume.
//
// mergeJsonAtomic() is the paired write primitive: read-modify-write a JSON
// config file through a same-directory temp file + rename, so a reader never
// observes a half-written settings.json, and a destination that is itself a
// symlink keeps pointing at its real target rather than being replaced by a
// plain file. No jq, no dependency — this has to run from the bundled Node
// runtime itself and be trivially callable from Bash.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DEFAULT_MANIFEST_FILE, isMainModule, verifyPayload } from './runtime-payload.mjs'

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
      return { status: 'unknown', reason: `runtime directory has no valid ownership manifest: ${err.message}` }
    }

    return { status: 'owned', runtimeId: manifest.runtimeId, version: manifest.packageVersion, path: runtimeDir }
  } catch (err) {
    return { status: 'unknown', reason: err.message }
  }
}

/**
 * Recursively walk an arbitrary parsed-JSON value looking for every object
 * shaped like `{command: <string>, args: [<string entry>, ...]}` — the
 * launcher shape shared by both this project's hook-settings entries
 * (docs/hooks.md) and a host's MCP server registration (`mcpServers.<name>`
 * in a Claude/Copilot config). This is deliberately more general than
 * collectCandidateHookEntries() below: a runtime-reference gate has to look
 * across whatever host config files exist, not just the one hooks shape.
 */
function findCommandArgsPairs(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findCommandArgsPairs(item, out)
  } else if (isPlainObject(node)) {
    if (typeof node.command === 'string' && Array.isArray(node.args) && typeof node.args[0] === 'string') {
      out.push({ command: node.command, entry: node.args[0] })
    }
    for (const value of Object.values(node)) findCommandArgsPairs(value, out)
  }
  return out
}

/**
 * Does ANY `{command, args}` launcher pair found anywhere inside `--file`s
 * still resolve (structurally, via classifyRuntimeConfig) to the exact
 * `runtimeId` under `runtimeRoot`? This is the gate a prune/rollback must
 * consult before deleting a runtime directory — see pruneRuntime() in
 * runtime-payload.mjs, which only ever deletes what this says is safe.
 *
 * Never throws. Per file:
 *   · missing            — skipped; contributes nothing either way.
 *   · unreadable/invalid  JSON — contributes 'unknown' (retain): we could not
 *     rule out a reference, so pruning is not provably safe.
 *   · valid JSON, no pair classifies 'owned' with a matching runtimeId — a
 *     'custom'/'split' classification (or no candidate pairs at all) is NOT
 *     evidence of reference and does not itself force 'unknown'.
 *
 * Overall status, in precedence order:
 *   'referenced'   — at least one pair resolves to this exact runtimeId.
 *   'unknown'      — no match found, but at least one file could not be read
 *                    or parsed (retain — do not prune).
 *   'unreferenced' — every given file was either missing or readable/valid
 *                    JSON with no reference to this runtimeId (safe to prune).
 */
export function classifyRuntimeReference({ runtimeRoot, runtimeId, files, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  const checked = []
  const matches = []
  let sawUnknownFile = false

  for (const file of files) {
    if (!existsSync(file)) {
      checked.push({ file, status: 'missing' })
      continue
    }
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      sawUnknownFile = true
      checked.push({ file, status: 'unreadable', reason: err.message })
      continue
    }
    let parsed
    try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw)
    } catch (err) {
      sawUnknownFile = true
      checked.push({ file, status: 'invalid-json', reason: err.message })
      continue
    }

    const pairs = findCommandArgsPairs(parsed)
    let fileMatched = false
    for (const { command, entry } of pairs) {
      const result = classifyRuntimeConfig({
        nodeBinPath: command,
        entryPath: entry,
        runtimeRoot,
        manifestFileName,
      })
      if (result.status === 'owned' && result.runtimeId === runtimeId) {
        fileMatched = true
        matches.push({ file, command, entry })
      }
    }
    checked.push({ file, status: fileMatched ? 'referenced' : 'checked', pairCount: pairs.length })
  }

  const status = matches.length > 0 ? 'referenced' : sawUnknownFile ? 'unknown' : 'unreferenced'
  return { status, runtimeId, matches, files: checked }
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
// "unknown" split into dead and unknown; test/agent-hosts.test.ts holds the
// two to agreement.

const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024

/** The source checkout whose dist/hook-cli.js the canonical `file` is: beside a package.json named agent-inbox, with no runtime manifest. */
function checkoutRootOf(file, manifestFileName) {
  if (basename(file) !== 'hook-cli.js' || basename(dirname(file)) !== 'dist') return null
  const root = dirname(dirname(file))
  if (existsSync(join(root, manifestFileName))) return null
  try {
    const st = lstatSync(join(root, 'package.json'))
    if (!st.isFile() || st.size > MAX_PACKAGE_JSON_BYTES) return null
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return isPlainObject(pkg) && pkg.name === 'agent-inbox' ? root : null
  } catch {
    return null
  }
}

/**
 * Which Agent Inbox install the hook launcher {command, entry} runs. Never throws.
 *   runtime  — node and entry in one verified runtime directory under runtimeRoot
 *   checkout — a source checkout's dist/hook-cli.js (checkoutRootOf)
 *   other    — identifiably something else, such as another tool's look-alike
 *   dead     — the entry, or a command given as a path, no longer resolves: it cannot run
 *   unknown  — it runs, but from a split pair or a runtime that does not verify
 */
function classifyHookLauncher({ command, entry, runtimeRoot, manifestFileName = DEFAULT_MANIFEST_FILE }) {
  if (typeof command !== 'string' || typeof entry !== 'string') return { kind: 'unknown' }
  // an entry that is not a path (`npx tsx src/…`) is somebody's own command
  if (!isAbsolute(entry)) return { kind: 'other' }
  const file = tryCanonicalize(entry)
  // a command looked up on PATH is never inside a runtime directory
  const node = isAbsolute(command) ? tryCanonicalize(command) : null
  if (!file || (isAbsolute(command) && !node)) return { kind: 'dead' }
  const root = runtimeRoot ? tryCanonicalize(runtimeRoot) : null
  const nodeIn = root !== null && node !== null && isUnder(root, node)
  const fileIn = root !== null && isUnder(root, file)
  if (nodeIn || fileIn) {
    if (!nodeIn || !fileIn) return { kind: 'unknown' }
    const owned = classifyRuntimeConfig({ nodeBinPath: node, entryPath: file, runtimeRoot: root, manifestFileName })
    return owned.status === 'owned'
      ? { kind: 'runtime', runtimeId: owned.runtimeId, version: owned.version, path: owned.path }
      : { kind: 'unknown' }
  }
  const checkout = checkoutRootOf(file, manifestFileName)
  return checkout ? { kind: 'checkout', path: checkout } : { kind: 'other' }
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
 *   replaceable  — another Agent Inbox install's (a verified runtime, a checkout),
 *                  or a dead dist/hook-cli.js: only --replace-existing removes these
 *   unverifiable — a dist/hook-cli.js that runs but cannot be verified: never removed
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
    else if (!runtimeRoot) sorted.unverifiable.push(entry)
    else if (owner.kind === 'runtime' || owner.kind === 'checkout') {
      sorted.replaceable.push({ entry, owner: { ...owner, path: installDirAsWritten(entry.args[0], owner.path) } })
    } else if (owner.kind === 'dead' && hookCli) {
      sorted.replaceable.push({ entry, owner: { kind: 'dead', path: dirname(dirname(entry.args[0])) } })
    } else if (owner.kind === 'unknown' && hookCli) sorted.unverifiable.push(entry)
    else sorted.others.push(entry)
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
  if (owner.kind === 'runtime') return `the ${owner.version ? `v${owner.version} ` : ''}Setup runtime at ${owner.path}`
  if (owner.kind === 'checkout') return `the source checkout at ${owner.path}`
  return `the install at ${owner.path}, which can no longer run`
}

const hookCount = (count) => `${count} hook${count === 1 ? '' : 's'}`

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function listEntries(entries) {
  const subcommands = new Map()
  for (const entry of entries) subcommands.set(entry.args[0], new Set([...(subcommands.get(entry.args[0]) ?? []), entry.args[1]]))
  return [...subcommands].map(([entry, subs]) => `  - ${entry} (${[...subs].sort().join(', ')})`)
}

// Whether `owner`'s own installer can remove its hooks from these settings
// right now: a checkout's removes exactly its entries; a runtime's (any
// version) refuses while anything shaped like ours is not a verified runtime's.
function ownUninstallWorks(owner, sorted) {
  if (owner.kind === 'dead' || !existsSync(join(owner.path, 'scripts', 'install-hooks.sh'))) return false
  return owner.kind === 'checkout' || (sorted.own.length + sorted.unverifiable.length + sorted.others.length === 0
    && sorted.replaceable.every((r) => r.owner.kind === 'runtime'))
}

/** A refusal whose message is complete as written: what is in the way, then the one fix to try first. */
class HookRefusal extends Error {}

/**
 * The refusal for `sorted` (sortHookEntries). What no installer command can
 * clear is named first, to remove by hand. Otherwise the one-step
 * --replace-existing comes first, then each other install's own uninstall
 * that can succeed in this state. `others` lists the look-alikes that block.
 */
function hookRefusal({ settingsPath, sorted, others, installer, uninstall }) {
  const notDone = uninstall ? 'nothing was removed' : 'nothing was written'
  const byHand = [...sorted.unverifiable, ...(uninstall ? others : [])]
  if (byHand.length > 0) {
    return new HookRefusal([
      `install-hooks: ${settingsPath} has hooks shaped like Agent Inbox's that this installer cannot attribute to an install:`,
      ...listEntries(byHand),
      `They may be another set of Agent Inbox hooks, so ${notDone}. Remove them from ${settingsPath} by hand, then run this installer again.`,
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
    lines.push(...listEntries(others))
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
 * (sortHookEntries, where every verified runtime's are this install's own)
 * and return the NEW settings object — stripped of our old entries, plus
 * (unless `uninstall`) the fresh block built from `node`/`entry`. Anything
 * else shaped like ours refuses with a HookRefusal unless `force`, as before,
 * except that `replaceExisting` also replaces another Agent Inbox install's
 * hooks and dead ones (telling `onReplace` whose they were) and leaves other
 * tools' look-alikes in place. Never writes anything; the caller decides how
 * (and whether) to persist the result.
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
    const sorted = sortHookEntries({ settings: base, isOwn: (_, owner) => owner.kind === 'runtime', runtimeRoot, manifestFileName })
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
 * `references` — the prune/rollback safety gate: is `--runtime-id` still
 * referenced by anything structurally recognizable in one or more host
 * config `--file`s (repeatable)?
 *
 *   runtime-config.mjs references --runtime-root <abs> --runtime-id <id>
 *     --file <path> [--file <path> ...] [--manifest-file <name>]
 *
 * stdout: `{status, runtimeId, matches, files}` JSON — always, on success.
 * exit 0: always, for any combination of missing/valid/invalid input files;
 *   `status` (not the exit code) carries the referenced/unreferenced/unknown
 *   verdict, exactly like `classify`'s status field.
 * exit 2: a required flag is missing/empty (no --runtime-root, --runtime-id,
 *   or not at least one --file).
 */
function runReferencesCmd(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'runtime-root': { type: 'string' },
      'runtime-id': { type: 'string' },
      file: { type: 'string', multiple: true },
      'manifest-file': { type: 'string' },
    },
  })
  const runtimeRoot = resolve(requireString(values, 'runtime-root', 'references'))
  const runtimeId = requireString(values, 'runtime-id', 'references')
  const files = values.file ?? []
  if (files.length === 0) {
    throw new UsageError('references: at least one --file <path> is required')
  }
  const result = classifyRuntimeReference({
    runtimeRoot,
    runtimeId,
    files: files.map((f) => resolve(f)),
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
 *   shaped entries are not a verified runtime's and neither --force nor (when
 *   installing, and only for what sortHookEntries calls replaceable or
 *   another tool's) --replace-existing was given. stderr names what is in the
 *   way and the one fix to try first.
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
 *   {command, args, owner: {kind, path, runtimeId?, version?}}; [] when none.
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
      case 'registration': runRegistrationCmd(rest); break
      case 'merge-json': runMergeJsonCmd(rest); break
      case 'hooks': runHooksCmd(rest); break
      case 'foreign-hooks': runForeignHooksCmd(rest); break
      default:
        throw new UsageError('usage: runtime-config.mjs <classify|references|registration|merge-json|hooks|foreign-hooks> [flags]')
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
