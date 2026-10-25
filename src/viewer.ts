import { Hono } from 'hono'
import type { Handler } from 'hono'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import type Database from 'better-sqlite3'
import {
  listItems, listItemsPage, listOpenQuestions, resolveItem, dismissItem, annotateItem, replyItem, snoozeItem,
  stopItemWatch, stopBoardRowWatch, pinItem, pinBoardRow, listArchivedSummary,
  listBoards, listBoardsWithBlockedRows, archiveBoard, unarchiveBoard, annotateBoardRow, snoozeBoardRow,
  markRowHandled, clearRowHandled, listActivity, listActivitySpans, listSourceLinks, defaultDbPath,
  closeProject, reopenProject, closedProjects, readSnapshotState, listIssueEntities, listIssueSnapshots,
} from './store.js'
import type { ExpectedAnswer, ResponseKind, SnapshotDomain, SnapshotReadState } from './store.js'
import { groupItems } from './group.js'
import { buildIssueGraph } from './issue-graph.js'
import { issueKeySets } from '../public/issue-key.js'
import { hooksSettingsBlock } from './hook.js'
import { agentConfigFiles, readAgentHosts, registeredRuntimeVersion } from './agent-hosts.js'
import type { AgentHosts, HostRegistration, RuntimeVerifier } from './agent-hosts.js'
import { measureRuntime, readRuntimes, referenceFiles } from './runtime-inventory.js'
import type { RuntimeInventory, RuntimeMeasure, RuntimeMeasurer } from './runtime-inventory.js'
import { buildStamp, readBakedInfo } from './stamp.js'
import type { BakedInfo, BuildStamp } from './stamp.js'
import { AGENT_INBOX_VERSION } from './version.js'

const require = createRequire(import.meta.url)
const {
  EXPECTED_NODE_MAJOR,
  EXPECTED_NODE_MODULES_ABI,
  EXPECTED_PRODUCT,
  MANIFEST_FILE,
  REQUIRED_ENTRYPOINTS,
  REQUIRED_FILES,
  verifyRuntimePayload,
} = require('../electron/runtime-verify.cjs') as {
  EXPECTED_NODE_MAJOR: number
  EXPECTED_NODE_MODULES_ABI: string
  EXPECTED_PRODUCT: string
  MANIFEST_FILE: string
  REQUIRED_ENTRYPOINTS: string[]
  REQUIRED_FILES: string[]
  verifyRuntimePayload: RuntimeVerifier
}

/** Seams, both test-only today — the production path passes neither. */
export interface ViewerOpts {
  /** where the packaged app's setup-info.json lives (a checkout has none) */
  setupInfoPath?: string
  /** the #40 build-stamp probe, injected so a test never shells out to git */
  stamp?: (baked: BakedInfo | null, cwd: string) => Promise<BuildStamp>
  /** Electron-only readiness capability; absent for browser/dev viewers. */
  ownerToken?: string
  /** issue #74: `${process.platform}-${process.arch}` override, so a test can
   *  pin a host key without touching the real process. */
  runtimeHostKey?: string
  /** issue #74: root directory a portable runtime gets installed under
   *  (an absolute AGENT_INBOX_RUNTIME_ROOT, else `~/.agent-inbox/runtime`, as
   *  Setup's installers use it, #294); overridable so a test never touches the
   *  real home directory. */
  runtimeRoot?: string
  /** issue #74: the app bundle root a release payload's contained relative
   *  path is resolved against (the directory setup-info.json itself lives
   *  in); overridable so a test never depends on cwd. Production derives it
   *  from `dirname(setupInfoPath)`. */
  appRoot?: string
  /** issue #197: the runtime payload verifier, injected so a test can count
   *  the whole-runtime hashing the shared runtime lookup exists to avoid. */
  runtimeVerifier?: RuntimeVerifier
  /** issue #197 part 2: the home directory whose ~/.claude.json,
   *  ~/.copilot/mcp-config.json and ~/.claude/settings.json say which build
   *  each host's agents are registered to run; overridable so a test never
   *  reads the real one. */
  agentHome?: string
  /** issue #294: how one runtime folder is measured, injected so a test can
   *  count the manifest reads and walks its cache exists to avoid. */
  runtimeMeasurer?: RuntimeMeasurer
}

/** Split a fixed `darwin-arm64`/`darwin-x64` runtime key into platform/arch —
 *  the same convention scripts/write-setup-info.mjs and electron/setup-
 *  runner.cjs use to validate a runtime-manifest.json against its map key. */
function platformArchOf(key: string): { platform: string; arch: string } {
  const i = key.indexOf('-')
  return { platform: key.slice(0, i), arch: key.slice(i + 1) }
}

/** A contained relative path: never absolute, never a `..` traversal segment —
 *  the exact same rule write-setup-info.mjs and setup-runner.cjs enforce. */
function isContainedRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p) return false
  if (isAbsolute(p)) return false
  const segments = p.split(/[\\/]+/)
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i
/**
 * Resolves and verifies the release's SOURCE runtime payload directory for
 * this exact host (issue #74). Containment is established here, then the same
 * trusted, Electron-independent verifier used immediately before spawn checks
 * every manifested file/hash/mode, rejects symlinks and extras, and re-derives
 * the payload digest/runtime ID before this API exposes a command.
 *
 * A payload verifying here means it is safe to REFERENCE in the one-click
 * install command (running that command is what installs it) — it does NOT
 * mean the runtime is already installed; that is `installedRuntime()` below.
 */
function resolveReleaseRuntimeSource(
  appRoot: string,
  hostKey: string,
  payload: { path: string; digest: string } | null | undefined,
  packageVersion: string,
  verify: RuntimeVerifier,
): ReleaseRuntime['source'] {
  if (!payload) return null
  if (!isContainedRelativePath(payload.path)) return null
  if (!DIGEST_RE.test(payload.digest)) return null
  if (!isAbsolute(appRoot) || !existsSync(appRoot)) return null
  const realRoot = realpathSync(appRoot)
  const resolved = resolve(appRoot, payload.path)
  if (resolved !== resolve(appRoot) && !resolved.startsWith(resolve(appRoot) + sep)) return null
  if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink()) return null
  const realResolved = realpathSync(resolved)
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + sep)) return null
  if (!lstatSync(realResolved).isDirectory()) return null

  const { platform, arch } = platformArchOf(hostKey)
  let runtimeId: string
  try {
    runtimeId = verify({
      root: realResolved,
      expectedManifestDigest: payload.digest,
      expectedPlatform: platform,
      expectedArch: arch,
      expectedProduct: EXPECTED_PRODUCT,
      expectedPackageVersion: packageVersion,
      expectedNodeMajor: EXPECTED_NODE_MAJOR,
      expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
      requiredEntrypoints: REQUIRED_ENTRYPOINTS,
      requiredFiles: REQUIRED_FILES,
    }).manifest.runtimeId
  } catch {
    return null
  }

  const installer = resolve(realResolved, 'scripts', 'install-agents.sh')
  if (!existsSync(installer)) return null
  // issue #294: the verified payload's own prune script, which Setup's
  // prune-runtimes target runs; a verified payload holds no file it does not list
  const prunable = existsSync(resolve(realResolved, 'scripts', 'prune-runtimes.sh'))
  return { dir: realResolved, installer, runtimeId, prunable }
}

/**
 * Whether a portable runtime matching THIS release's exact source payload for
 * THIS host is already installed under `runtimeRoot` (issue #74). Scans
 * `runtimeRoot`'s direct children (never symlinked — an installer contract,
 * not agent-authored text) for a `runtime-manifest.json` whose declared
 * `runtimeId` equals the child directory's OWN name, whose `platform`/`arch`/
 * `packageVersion` match this host's release, and whose manifest file is
 * byte-identical (SHA-256) to the SOURCE manifest digest baked into
 * setup-info.json — a valid identity check because the installer that copies
 * a verified payload into `runtimeRoot/<runtimeId>` copies the whole payload
 * tree, so the installed manifest is byte-for-byte the source manifest.
 *
 * The trusted verifier checks the complete installed file list as well; a
 * matching manifest alone can never make manual commands appear.
 */
function installedRuntime(
  runtimeRoot: string,
  version: string,
  hostKey: string,
  expectedDigest: string,
  verify: RuntimeVerifier,
): { dir: string; nodeBin: string; entry: string; hookEntry: string } | null {
  let entries: string[]
  try {
    entries = readdirSync(runtimeRoot)
  } catch {
    return null
  }
  const { platform, arch } = platformArchOf(hostKey)
  for (const name of entries) {
    const dir = resolve(runtimeRoot, name)
    let dirStat: import('node:fs').Stats
    try {
      dirStat = lstatSync(dir)
    } catch {
      continue
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue
    let verified: { manifest: { runtimeId: string } }
    try {
      verified = verify({
        root: dir,
        expectedManifestDigest: expectedDigest,
        expectedPlatform: platform,
        expectedArch: arch,
        expectedPackageVersion: version,
        expectedProduct: EXPECTED_PRODUCT,
        expectedNodeMajor: EXPECTED_NODE_MAJOR,
        expectedNodeModulesAbi: EXPECTED_NODE_MODULES_ABI,
        requiredEntrypoints: REQUIRED_ENTRYPOINTS,
        requiredFiles: REQUIRED_FILES,
      })
    } catch {
      continue
    }
    if (verified.manifest.runtimeId !== name) continue

    const nodeBin = resolve(dir, 'bin', 'node')
    const entry = resolve(dir, 'dist', 'mcp-server.js')
    const hookEntry = resolve(dir, 'dist', 'hook-cli.js')
    if (!existsSync(nodeBin) || !existsSync(entry)) continue
    return { dir, nodeBin, entry, hookEntry }
  }
  return null
}

interface SetupInfoResult {
  /** 'release' for a signed release build (setup-info schema 2, issue #74);
   *  'dev' for a source checkout or a pre-#74 packaged bundle. */
  mode: 'dev' | 'release'
  /** the released version, or null outside release mode */
  version: string | null
  /** `${process.platform}-${process.arch}`, or null outside release mode */
  runtimeKey: string | null
  /** whether an installed runtime matching this host's exact payload validated */
  runtimeAvailable: boolean
  agentInstallCommand: string
  claudeInstallCommand: string
  copilotInstallCommand: string
  claudeCommand: string
  copilotConfig: string
  snippet: string
  dbPath: string
  note: string
  hooksSettings: string
  hooksNote: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll(`'`, `'\\''`)}'`
}

function devSetupInfo(baked: BakedInfo | null): SetupInfoResult {
  let nodeBin = process.execPath
  let root = process.cwd()
  let note = ''
  // In a checkout the Node serving this request has demonstrably loaded
  // better-sqlite3 (it is holding the db open); in the packaged app the baked
  // path is whatever ran the packaging script and is NOT proven.
  let nodeProven = true
  // Both fields or neither: a half-written file would otherwise put `undefined`
  // into the very command the human is told to paste.
  if (baked?.repoRoot && baked.nodeBin) {
    root = baked.repoRoot
    nodeBin = baked.nodeBin
    nodeProven = false
    note = `Paths were captured when this app was packaged and assume the agent-inbox repo still lives at ${root} (agents run the MCP server from the repo, not from this app).`
  }
  const entry = resolve(root, 'dist', 'mcp-server.js')
  const snippetPath = resolve(process.cwd(), 'docs', 'reporting-snippet.md')
  const install = `cd ${shellQuote(root)} && npm run install:agents -- --apply`
  return {
    mode: 'dev',
    version: null,
    runtimeKey: null,
    runtimeAvailable: false,
    agentInstallCommand: install,
    claudeInstallCommand: `${install} --target claude`,
    copilotInstallCommand: `${install} --target copilot`,
    claudeCommand: `claude mcp add --scope user agent-inbox -- ${nodeBin} ${entry}`,
    copilotConfig: JSON.stringify(
      { mcpServers: { 'agent-inbox': { command: nodeBin, args: [entry] } } },
      null,
      2,
    ),
    snippet: existsSync(snippetPath) ? readFileSync(snippetPath, 'utf8') : '',
    dbPath: defaultDbPath(),
    note,
    hooksSettings: JSON.stringify(hooksSettingsBlock(nodeBin, resolve(root, 'dist', 'hook-cli.js')), null, 2),
    // This panel cannot run `selftest`, so it cannot prove the baked Node can
    // load better-sqlite3 — and a hook spawned under the wrong Node dies
    // silently, forever. Say so instead of implying safety.
    hooksNote:
      (nodeProven
        ? 'Optional. Merge into ~/.claude/settings.json, then restart Claude Code. '
        : '⚠ The Node path below was captured when this app was packaged and has NOT been verified against better-sqlite3. ') +
      'Prefer `npm run install:hooks` from the repo — it proves the Node binary with a selftest before writing anything, backs the file up, and is a dry run by default. See docs/hooks.md.',
  }
}

// A release build (issue #74) never bakes repoRoot/nodeBin at all — there is
// no checkout to `cd` into, so the shell one-liners that assume one are
// simply absent (empty string), never a fabricated command pointing at a
// path that does not exist. The one-click install commands become truthful
// as soon as this host's SOURCE runtime payload verifies (contained,
// non-symlink, digest+platform/arch-matched, installer present) — running
// that very command is what installs the runtime, so it does not need to be
// installed first. Direct MCP/hook registration commands are different: they
// name an ALREADY-INSTALLED runtime's exact paths, so they stay withheld
// until `installedRuntime()` validates a matching install — never a
// "success-shaped" command aimed at a runtime that is not there. Both verified
// lookups arrive in `lookup` (see `releaseRuntimeLookup`, issue #197).
function releaseSetupInfo(baked: BakedInfo, hostKey: string, lookup: ReleaseRuntime | null): SetupInfoResult {
  const version = baked.version ?? null
  const payload = baked.runtimePayloads?.[hostKey] ?? null
  const snippetPath = resolve(process.cwd(), 'docs', 'reporting-snippet.md')
  const snippet = existsSync(snippetPath) ? readFileSync(snippetPath, 'utf8') : ''
  const dbPath = defaultDbPath()

  const result: SetupInfoResult = {
    mode: 'release',
    version,
    runtimeKey: hostKey,
    runtimeAvailable: false,
    agentInstallCommand: '',
    claudeInstallCommand: '',
    copilotInstallCommand: '',
    claudeCommand: '',
    copilotConfig: '',
    snippet,
    dbPath,
    note: version
      ? `The portable MCP runtime for Agent Inbox v${version} (${hostKey}) has not been installed yet. Run setup from this panel to install it.`
      : 'This release build has no runtime metadata for this host — one-click and manual agent setup are unavailable.',
    hooksSettings: '',
    hooksNote: '',
  }
  if (!version || !payload) return result
  if (!DIGEST_RE.test(payload.digest)) return result

  // The embedded installer script lives INSIDE the verified source payload
  // directory — never a builder's own checkout path.
  const source = lookup?.source ?? null
  if (source) {
    const install = `bash ${shellQuote(source.installer)} --apply --runtime-source ${shellQuote(source.dir)} --runtime-digest ${shellQuote(payload.digest)}`
    result.agentInstallCommand = install
    result.claudeInstallCommand = `${install} --target claude`
    result.copilotInstallCommand = `${install} --target copilot`
    result.note = `Run setup below to install the portable MCP runtime for Agent Inbox v${version} (${hostKey}).`
  }

  const runtime = lookup?.runtime ?? null
  if (!runtime) return result

  return {
    ...result,
    runtimeAvailable: true,
    note: '',
    claudeCommand: `claude mcp add --scope user agent-inbox -- ${runtime.nodeBin} ${runtime.entry}`,
    copilotConfig: JSON.stringify(
      { mcpServers: { 'agent-inbox': { command: runtime.nodeBin, args: [runtime.entry] } } },
      null,
      2,
    ),
    hooksSettings: JSON.stringify(hooksSettingsBlock(runtime.nodeBin, runtime.hookEntry), null, 2),
    hooksNote: 'Optional. Merge into ~/.claude/settings.json, then restart Claude Code.',
  }
}

function setupInfo(baked: BakedInfo | null, hostKey: string, lookup: ReleaseRuntime | null): SetupInfoResult {
  if (baked?.schema === 2) return releaseSetupInfo(baked, hostKey, lookup)
  return devSetupInfo(baked)
}

// ── issue #197: one verified runtime lookup for /api/setup and /api/version ──
//
// Both routes need the same two answers for this host: does the bundled SOURCE
// payload verify (Setup can install it), and is that exact runtime INSTALLED.
// Each answer hashes a whole runtime (~166 MB) on the viewer thread, which is
// Electron's main process in the packaged app. So both routes share one cached
// lookup, recomputed only when something it examined changed: the runtime
// root's listing, each installed runtime directory and its manifest, and the
// source payload directory and its manifest — identity, size and change times.
// That catches an install, a removal, an atomic rename-over and any manifest
// edit on the next read. An edit deep inside an installed runtime changes none
// of them, so a long backstop re-verifies anyway; executing a runtime is still
// guarded separately, immediately before spawn, by electron/setup-runner.cjs.
interface ReleaseRuntime {
  source: { dir: string; installer: string; runtimeId: string; prunable: boolean } | null
  runtime: { dir: string; nodeBin: string; entry: string; hookEntry: string } | null
}

const RUNTIME_LOOKUP_BACKSTOP_MS = 10 * 60_000

function releaseRuntimeLookup(
  baked: BakedInfo,
  hostKey: string,
  runtimeRoot: string,
  appRoot: string,
  verify: RuntimeVerifier,
): ReleaseRuntime | null {
  const version = baked.version
  const payload = baked.runtimePayloads?.[hostKey]
  if (!version || !payload || !DIGEST_RE.test(payload.digest)) return null
  return {
    source: resolveReleaseRuntimeSource(appRoot, hostKey, payload, version, verify),
    runtime: installedRuntime(runtimeRoot, version, hostKey, payload.digest, verify),
  }
}

// Identity, size and both change times of one entry, without following a
// symlink or reading any content — or null when it is absent.
function entryStamp(path: string): string | null {
  try {
    const st = lstatSync(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch {
    return null
  }
}

// The same stamp for whatever a symlink points at: a host config file kept in
// a dotfiles repo changes there, not at the link.
function targetStamp(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch {
    return null
  }
}

// The runtime root and each installed runtime directory and its manifest.
function runtimeRootStamp(runtimeRoot: string): [string | null, Array<[string, string | null, string | null]> | null] {
  let installed: Array<[string, string | null, string | null]> | null
  try {
    installed = readdirSync(runtimeRoot).sort().map((name) => {
      const dir = resolve(runtimeRoot, name)
      return [name, entryStamp(dir), entryStamp(resolve(dir, MANIFEST_FILE))]
    })
  } catch {
    installed = null
  }
  return [entryStamp(runtimeRoot), installed]
}

function releaseRuntimeKey(baked: BakedInfo, hostKey: string, runtimeRoot: string, appRoot: string): string {
  const payload = baked.runtimePayloads?.[hostKey]
  const source = payload && isContainedRelativePath(payload.path) ? resolve(appRoot, payload.path) : null
  const [root, installed] = runtimeRootStamp(runtimeRoot)
  return JSON.stringify([
    baked.version ?? null,
    payload?.path ?? null,
    payload?.digest ?? null,
    source ? [entryStamp(source), entryStamp(resolve(source, MANIFEST_FILE))] : null,
    root,
    installed,
  ])
}

// What a restarted agent session would load, for Live's older-build hint. A
// release answers with its baked version, the one /api/setup and the build
// stamp report; anything else with the version this viewer's own code is,
// which a release bump keeps equal to package.json. `runtimeInstalled` comes
// from the shared lookup, so Live and Setup never disagree:
//   true  — this release's exact runtime is installed for this host
//   false — it is not, but Setup can install it (the source payload verifies)
//   null  — a checkout (not applicable), or nothing Setup could install here
// `hosts` (part 2) is what each host is REGISTERED to run, because that, not
// what is installed, is what a restarted session loads: its kind and, for
// Setup's runtime, its version. No path, runtime id or config content.
// `updatable` is whether Setup can move agents onto this release's runtime
// (see `canUpdateAgents`), so Live points at Setup only when Setup offers it.
interface AgentVersion {
  current: string | null
  mode: 'dev' | 'release'
  runtimeInstalled: boolean | null
  updatable: boolean
  hosts: { claude: HostVersion; copilot: HostVersion }
}

type HostVersion = Pick<HostRegistration, 'kind' | 'version'>

function hostVersion({ kind, version }: HostRegistration): HostVersion {
  return version ? { kind, version } : { kind }
}

// Whether Setup can move agents onto this release's runtime: a release with a
// version whose own runtime payload verifies for this host, installed or not.
// The ONE condition the Setup panel's action and Live's "update agents from
// Setup" advice share, so Live never points at an action Setup does not show.
function canUpdateAgents(baked: BakedInfo | null, lookup: ReleaseRuntime | null): boolean {
  return baked?.schema === 2 && !!baked.version && !!lookup?.source
}

// The Setup panel's per-host view (#197 part 2). `current` is the runtime
// version Setup installs, a release's baked one; a checkout has none to offer.
// `updatable` (`canUpdateAgents`) lets the panel offer its one action for a
// Setup-managed host whose runtime differs, older or newer.
// `hooksCommand` moves Claude's hooks onto the installed current runtime: the
// agent installer never touches hooks, so the panel can only hand this over.
// `checkoutHooksCommand` (#278) points them at the source checkout Claude Code
// runs from instead, present only while they are not that checkout's: Setup
// never switches a checkout, so it never installs this runtime on its behalf.
interface AgentsInfo {
  current: string | null
  updatable: boolean
  claude: HostRegistration
  copilot: HostRegistration
  hooks: HostRegistration
  hooksCommand: string
  checkoutHooksCommand?: string
}

// The checkout's own hook installer. `--replace-existing` because the hooks
// there belong to another install, which it otherwise refuses beside (#218).
function checkoutHooksCommand({ claude, hooks }: AgentHosts): string | null {
  if (claude.kind !== 'checkout' || !claude.path) return null
  if (hooks.kind === 'none' || (hooks.kind === 'checkout' && hooks.path === claude.path)) return null
  return `cd ${shellQuote(claude.path)} && npm run install:hooks -- --apply --replace-existing`
}

function agentsInfo(baked: BakedInfo | null, lookup: ReleaseRuntime | null, hosts: AgentHosts): AgentsInfo {
  const current = baked?.schema === 2 ? baked.version ?? null : null
  const installed = lookup?.runtime ?? null
  const hooksInstaller = installed ? resolve(installed.dir, 'scripts', 'install-hooks.sh') : null
  const moveHooks = hooksInstaller !== null && hosts.hooks.kind === 'runtime' &&
    hosts.hooks.runtimeId !== basename(installed!.dir) && existsSync(hooksInstaller)
  const fromCheckout = checkoutHooksCommand(hosts)
  return {
    current,
    updatable: canUpdateAgents(baked, lookup),
    claude: hosts.claude,
    copilot: hosts.copilot,
    hooks: hosts.hooks,
    hooksCommand: moveHooks ? `bash ${shellQuote(hooksInstaller)} --apply` : '',
    ...(fromCheckout ? { checkoutHooksCommand: fromCheckout } : {}),
  }
}

const UNKNOWN_HOSTS: AgentHosts = { claude: { kind: 'unknown' }, copilot: { kind: 'unknown' }, hooks: { kind: 'unknown' } }

// The Setup panel's Runtimes block (#294): each folder under the runtime root,
// its size and what uses it. `removable` is whether Setup can run its prune
// here: a release whose verified payload carries prune-runtimes.sh, the one
// script Setup's `prune-runtimes` target runs. That script decides again,
// under the setup lock, and also keeps a runtime a running process uses.
interface RuntimesInfo extends RuntimeInventory {
  removable: boolean
}

function canPrune(baked: BakedInfo | null, lookup: ReleaseRuntime | null): boolean {
  return baked?.schema === 2 && lookup?.source?.prunable === true
}

// A close/reopen body carries one agent-authored project name. An unparseable
// body arrives here as null (the caller's .catch) and is refused like any other
// missing name — a 400, never a 500.
function validProject(body: unknown): string | null {
  const project = (body as { project?: unknown } | null)?.project
  return typeof project === 'string' && project.trim() ? project : null
}

function responseKind(value: unknown): ResponseKind | null {
  return value === 'answer' || value === 'clarify' || value === 'decline' ? value : null
}

// The whole snooze instruction (issue #163): null wakes, a parseable date
// snoozes. A date is stored as UTC ISO with a 4-digit year because the store
// compares snoozed_until as TEXT (`> now`); a verbatim "tomorrow" or "" sorts
// wrongly there and reads as awake to the viewer's Date.parse — a silent wake
// answered with 200. undefined = invalid, refused before any store call.
function snoozeUntil(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return undefined
  const iso = new Date(ms).toISOString()
  return /^\d{4}-/.test(iso) ? iso : undefined
}

// #321: the answer a reply expects to replace, the one the page last showed.
// Optional (undefined: an unconditional reply, as from an older page); when
// present, all four fields are required with their stored types. null =
// invalid, refused before any store call.
function expectedAnswer(value: unknown): ExpectedAnswer | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { replied_at: at, reply_source: source, reply_kind: kind, reply } = value as Record<string, unknown>
  const textOrNull = (field: unknown): field is string | null => field === null || typeof field === 'string'
  if (!textOrNull(at) || !textOrNull(reply)) return null
  if (source !== null && source !== 'inbox' && source !== 'agent') return null
  if (kind !== null && responseKind(kind) === null) return null
  return { replied_at: at, reply_source: source, reply_kind: kind as ResponseKind | null, reply }
}

// #247: `defer` on the stop-waiting routes is optional and means "no" when
// absent; a present value must be a boolean. null = invalid, refused before any
// store call.
function deferField(value: unknown): boolean | null {
  if (value === undefined) return false
  return typeof value === 'boolean' ? value : null
}

// Issue #184: closed items the default /api/items snapshot carries, newest touch
// first. Fifty fill ten History pages (PAGE.done = 5) while bounding a changed
// tick at about a tenth of a long-lived hub's full history. Anything beyond is
// summarized in `history` and fetched from /api/items/history only while a
// surface needs it.
const RECENT_CLOSED_ITEMS = 50
// Plus the newest outcome-bearing closed items of open projects: the four the
// Dashboard lists, so its default lens never needs older history, however many
// closures without an outcome (Inbox resolve/dismiss, hook sweeps) fill the
// recently touched slots. The archived summary (#299) carries as many of each
// project's newest archived outcomes, for the same lens.
const RECENT_OUTCOMES = 4

// Issue #297: what each conditional snapshot's bytes are built from, as store
// domains (SNAPSHOT_DOMAINS in src/store.ts). A body is rebuilt only when one
// of its domains moved, or the schema did; a write anywhere else cannot change
// it, so presence, liveness and claim writes rebuild nothing.
// test/snapshot-domains.test.ts holds each list to the reads behind its route.
export const SNAPSHOT_SOURCES = {
  // listItemsPage: every item column, and closedProjects() for its outcome lens
  items: ['items', 'projects', 'boards_closure'],
  // listOpenQuestions: items alone. The dock's waiting/parked split reads
  // /api/activity, which is never retained, not this body.
  'attention-items': ['items'],
  'history-items': ['items'],
  boards: ['boards', 'board_rows'],
  'attention-boards': ['boards', 'board_rows'],
  'archived-boards': ['boards', 'board_rows'],
  // listArchivedSummary: archived plans and every one of their rows (#299)
  'archived-summary': ['boards', 'board_rows'],
  // listSourceLinks, and listLinkTargets() once a cached preview needs it
  links: ['source_links_by_head', 'items_links', 'boards_links', 'projects'],
  // buildIssueGraph over listIssueSnapshots, listIssueEntities and the links
  issues: ['issue_snapshots', 'source_links_by_head_issues', 'items_issues', 'boards_issues', 'board_rows_issues', 'projects'],
} as const satisfies Record<string, readonly SnapshotDomain[]>

type SnapshotName = keyof typeof SNAPSHOT_SOURCES

// Equal tokens of the snapshot's own domains, read outside any transaction
// under one schema, prove that no write that could change its bytes committed
// between the two reads. A domain whose version proves nothing (the hub has no
// row for it, or lacks one of its triggers) carries the commit token instead,
// so such a body is rebuilt after any commit, as every body was before #297.
function sameSnapshotState(domains: readonly SnapshotDomain[], a: SnapshotReadState, b: SnapshotReadState): boolean {
  return !a.inTransaction && !b.inTransaction && a.schemaVersion === b.schemaVersion
    && domains.every((domain) => a.domains[domain] === b.domains[domain])
}

// GET/HEAD use weak comparison, as in Hono's ETag middleware. Generated opaque
// tags contain no commas; trim list OWS before comparing members.
function etagMatches(requested: string | undefined, etag: string): boolean {
  return requested?.trim() === '*'
    || requested?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag) === true
}

function conditionalSnapshot(
  db: Database.Database,
  name: SnapshotName,
  read: () => object,
): Handler {
  const domains: readonly SnapshotDomain[] = SNAPSHOT_SOURCES[name]
  // One representation per registration, local to this viewer instance.
  let cached: { state: SnapshotReadState; body: string; etag: string } | undefined
  return (c) => {
    c.header('Cache-Control', 'no-store')
    const before = readSnapshotState(db)
    let current = cached
    if (!current || !sameSnapshotState(domains, current.state, before)) {
      cached = undefined
      const body = JSON.stringify(read())
      const after = readSnapshotState(db)
      current = {
        state: before,
        body,
        etag: `"${name}-${createHash('sha256').update(body).digest('hex')}"`,
      }
      // Never publish old bytes under a token read after a concurrent commit.
      // An unstable/transactional read retains the uncached response behavior.
      if (sameSnapshotState(domains, before, after)) cached = current
    }
    c.header('ETag', current.etag)
    if (etagMatches(c.req.header('If-None-Match'), current.etag)) return c.body(null, 304)
    return c.body(current.body, 200, { 'Content-Type': 'application/json' })
  }
}

// Where Setup's installers and prune keep runtimes: an absolute
// AGENT_INBOX_RUNTIME_ROOT, as electron/setup-runner.cjs setupRuntimeRoot
// reads it (a relative one is ignored here; Setup refuses it), else
// ~/.agent-inbox/runtime (#294).
function setupRuntimeRoot(): string {
  const configured = process.env['AGENT_INBOX_RUNTIME_ROOT']
  return configured && isAbsolute(configured) ? configured : resolve(homedir(), '.agent-inbox', 'runtime')
}

export function createViewer(db: Database.Database, opts: ViewerOpts = {}): Hono {
  const app = new Hono()
  const bakedPath = opts.setupInfoPath ?? resolve(process.cwd(), 'setup-info.json')
  const stamp = opts.stamp ?? buildStamp
  const runtimeHostKey = opts.runtimeHostKey ?? `${process.platform}-${process.arch}`
  const runtimeRoot = opts.runtimeRoot ?? setupRuntimeRoot()
  // A release payload's contained relative path is resolved against the app
  // bundle root — the same directory setup-info.json itself lives in.
  const appRoot = opts.appRoot ?? dirname(bakedPath)

  // Issue #197: the one cached runtime lookup /api/setup and /api/version share
  // (see releaseRuntimeKey). A lookup that throws is answered as unavailable and
  // never cached, so the next read tries again.
  const verify = opts.runtimeVerifier ?? verifyRuntimePayload
  let runtimeCache: { key: string; at: number; value: ReleaseRuntime | null } | undefined
  const releaseRuntime = (baked: BakedInfo): ReleaseRuntime | null => {
    const key = releaseRuntimeKey(baked, runtimeHostKey, runtimeRoot, appRoot)
    const now = Date.now()
    if (runtimeCache && runtimeCache.key === key && now - runtimeCache.at < RUNTIME_LOOKUP_BACKSTOP_MS) {
      return runtimeCache.value
    }
    try {
      const value = releaseRuntimeLookup(baked, runtimeHostKey, runtimeRoot, appRoot, verify)
      runtimeCache = { key, at: now, value }
      return value
    } catch {
      runtimeCache = undefined
      return null
    }
  }

  // Issue #197 part 2: what each host is REGISTERED to run (src/agent-hosts.ts),
  // shared by /api/setup and /api/version the same way. Re-read when one of the
  // three host config files (link or target) or the runtime root changes —
  // which every install does — and otherwise after the same backstop. Checking
  // a registered runtime hashes it, so each one is checked once per stamp of
  // its directory and manifest; the current runtime the release lookup above
  // already verified (more strictly) is not hashed again.
  const agentHome = opts.agentHome ?? homedir()
  const ownership = new Map<string, { key: string; at: number; value: { version: string | null } | null }>()
  let hostsCache: { key: string; at: number; value: AgentHosts } | undefined
  const agentHosts = (baked: BakedInfo | null): AgentHosts => {
    const lookup = baked?.schema === 2 ? releaseRuntime(baked) : null
    const installedDir = lookup?.runtime?.dir ?? null
    const key = JSON.stringify([
      agentConfigFiles(agentHome).map((file) => [entryStamp(file), targetStamp(file)]),
      runtimeRootStamp(runtimeRoot),
      installedDir,
      baked?.version ?? null,
    ])
    const now = Date.now()
    if (hostsCache && hostsCache.key === key && now - hostsCache.at < RUNTIME_LOOKUP_BACKSTOP_MS) {
      return hostsCache.value
    }
    try {
      let verifiedDir: string | null = null
      try {
        verifiedDir = installedDir ? realpathSync(installedDir) : null
      } catch {
        verifiedDir = null
      }
      const checked = new Set<string>()
      const value = readAgentHosts({
        home: agentHome,
        runtimeRoot,
        checkRuntime: (dir, runtimeId) => {
          if (dir === verifiedDir) return { version: baked?.version ?? null }
          checked.add(dir)
          const stamp = `${entryStamp(dir)}|${entryStamp(resolve(dir, MANIFEST_FILE))}`
          const hit = ownership.get(dir)
          if (hit && hit.key === stamp && now - hit.at < RUNTIME_LOOKUP_BACKSTOP_MS) return hit.value
          const verified = registeredRuntimeVersion(dir, runtimeId, verify)
          ownership.set(dir, { key: stamp, at: now, value: verified })
          return verified
        },
      })
      for (const dir of ownership.keys()) if (!checked.has(dir)) ownership.delete(dir)
      hostsCache = { key, at: now, value }
      return value
    } catch {
      hostsCache = undefined
      return UNKNOWN_HOSTS
    }
  }

  // Issue #294: what Setup's Runtimes block lists. Re-read when a host config
  // the prune gate reads (link or target) or the runtime root changes, and
  // otherwise after the same backstop. Each runtime folder's manifest is read
  // once per stamp of the folder and its manifest, and an unused one's folder
  // walked once (the only walk, about 40 ms for a 4,000-file runtime), so a
  // read with nothing changed reads stamps alone and a host config change
  // walks nothing. A read that throws is answered as unavailable and never
  // cached.
  const measureFolder = opts.runtimeMeasurer ?? measureRuntime
  const measures = new Map<string, { key: string; at: number; value: RuntimeMeasure | null }>()
  let runtimesCache: { key: string; at: number; value: RuntimeInventory } | undefined
  const runtimeInventory = (current: string | null): RuntimeInventory | null => {
    const key = JSON.stringify([
      referenceFiles(agentHome).map((file) => [entryStamp(file), targetStamp(file)]),
      runtimeRootStamp(runtimeRoot),
      current,
    ])
    const now = Date.now()
    if (runtimesCache && runtimesCache.key === key && now - runtimesCache.at < RUNTIME_LOOKUP_BACKSTOP_MS) {
      return runtimesCache.value
    }
    try {
      const seen = new Set<string>()
      const value = readRuntimes({
        home: agentHome,
        runtimeRoot,
        current,
        measure: (dir, runtimeId, walk) => {
          seen.add(dir)
          const stamp = `${entryStamp(dir)}|${entryStamp(resolve(dir, MANIFEST_FILE))}`
          const hit = measures.get(dir)
          if (hit && hit.key === stamp && now - hit.at < RUNTIME_LOOKUP_BACKSTOP_MS && (!walk || hit.value?.intact !== null)) {
            return hit.value
          }
          const measured = measureFolder(dir, runtimeId, walk)
          measures.set(dir, { key: stamp, at: now, value: measured })
          return measured
        },
      })
      for (const dir of measures.keys()) if (!seen.has(dir)) measures.delete(dir)
      runtimesCache = { key, at: now, value }
      return value
    } catch {
      runtimesCache = undefined
      return null
    }
  }

  // boot id lets a long-lived tab detect a server restart (= likely deploy)
  // and reload itself instead of polling forever with stale frontend code
  const boot = new Date().toISOString()
  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('x-inbox-boot', boot)
  })

  const allItems = conditionalSnapshot(db, 'items', () => {
    const page = listItemsPage(db, RECENT_CLOSED_ITEMS, RECENT_OUTCOMES)
    return { ...groupItems(page.items), history: page.history }
  })
  // Issue #184: the complete History list (closed items plus open milestones,
  // exactly the `done` group of the unpaged items), fetched only while a surface
  // needs older history. Its own representation and validator: it changes only
  // when closed history or a milestone does, and no other route can revalidate it.
  app.get('/api/items/history', conditionalSnapshot(db, 'history-items', () => ({ done: groupItems(listItems(db)).done })))
  // Issue #156: the Electron dock watcher polls every 3 seconds from the main
  // process and reads only needsYou. `?scope=attention` serves the same Grouped
  // shape built from the open questions alone. It is a separate cached
  // representation with its own validator, so neither can revalidate the other;
  // any other query string keeps the full response.
  const attentionItems = conditionalSnapshot(db, 'attention-items', () => groupItems(listOpenQuestions(db)))
  app.get('/api/items', (c, next) => (c.req.query('scope') === 'attention' ? attentionItems : allItems)(c, next))

  // The build stamp (#40) rides along here rather than on its own route: the
  // Setup panel is the one surface that asks "which build is this", and it is
  // fetched ONCE per page load, never on the 3s poll. The git probe behind it is
  // memoized for STAMP_TTL_MS, so a reload storm costs no extra processes.
  app.get('/api/setup', async (c) => {
    const baked = readBakedInfo(bakedPath)
    // The stamp is a nicety; the registration commands are the reason this panel
    // exists. A probe that throws must cost the human the ONE line, never the
    // whole panel — which is what a 500 here would do (renderSetup's catch
    // leaves the section empty).
    let build: BuildStamp | null = null
    try {
      build = await stamp(baked, process.cwd())
    } catch {
      build = null
    }
    const lookup = baked?.schema === 2 ? releaseRuntime(baked) : null
    const agents = agentsInfo(baked, lookup, agentHosts(baked))
    const inventory = runtimeInventory(lookup?.source?.runtimeId ?? null)
    const runtimes: RuntimesInfo | null = inventory && { ...inventory, removable: canPrune(baked, lookup) }
    return c.json({ ...setupInfo(baked, runtimeHostKey, lookup), agents, runtimes, build })
  })

  if (opts.ownerToken) {
    app.get('/api/owner', (c) => c.json({ token: opts.ownerToken }))
  }

  app.get('/api/activity', (c) => c.json(listActivity(db)))

  // Read by the Live bar at page load, whenever its drawer opens and after a
  // Setup install — never on the poll. Local reads only, no git, no network.
  app.get('/api/version', (c) => {
    const baked = readBakedInfo(bakedPath)
    const registered = agentHosts(baked)
    const hosts = { claude: hostVersion(registered.claude), copilot: hostVersion(registered.copilot) }
    if (baked?.schema !== 2) {
      return c.json({ current: AGENT_INBOX_VERSION, mode: 'dev', runtimeInstalled: null, updatable: false, hosts } satisfies AgentVersion)
    }
    const lookup = releaseRuntime(baked)
    return c.json({
      current: baked.version ?? null,
      mode: 'release',
      runtimeInstalled: lookup?.runtime ? true : lookup?.source ? false : null,
      updatable: canUpdateAgents(baked, lookup),
      hosts,
    } satisfies AgentVersion)
  })

  // Read-only, truthful claim-interval history for the dashboard: independent
  // of `/api/activity` and never imported into any attention/badge path.
  // `since_ms` is optional; when present it must be a finite number of epoch
  // milliseconds — a malformed value is a 400, not a silently-ignored filter.
  //
  // Conditional (issue #185), but never on database tokens: time alone changes
  // these bytes once an open span goes cold and gains its capped end. The tag
  // hashes the bytes plus the window and project that selected them, so a 304
  // means identical bytes and no two windows share a validator. Nothing is
  // cached; a failed read throws before any tag exists.
  app.get('/api/activity/history', (c) => {
    const project = c.req.query('project') || null
    const sinceParam = c.req.query('since_ms')
    let sinceMs: number | null = null
    if (sinceParam !== undefined) {
      const parsed = Number(sinceParam)
      if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) {
        return c.json({ ok: false, error: 'since_ms must be a valid epoch-millisecond date' }, 400)
      }
      sinceMs = parsed
    }
    c.header('Cache-Control', 'no-store')
    const body = JSON.stringify(listActivitySpans(db, { project: project ?? undefined, sinceMs: sinceMs ?? undefined }))
    // JSON.stringify never emits a raw newline, so the key cannot run into the body.
    const etag = `"activity-history-${createHash('sha256')
      .update(`${JSON.stringify([project, sinceMs])}\n`).update(body).digest('hex')}"`
    c.header('ETag', etag)
    if (etagMatches(c.req.header('If-None-Match'), etag)) return c.body(null, 304)
    return c.body(body, 200, { 'Content-Type': 'application/json' })
  })

  // issue #30 — the cached PR state, one row per (repo, branch). Deliberately
  // PURE: it never triggers a gh fetch, so the frontend's 3s poll can hit it
  // freely. The only writer is the poller src/viewer-server.ts starts.
  // Issue #288: its bytes depend on the database alone (the poller writes them
  // through store.ts, and the previews it keeps follow open items and active
  // plans), so it is a retained representation with its own validator.
  app.get('/api/links', conditionalSnapshot(db, 'links', () => listSourceLinks(db)))

  // Issue #103: the sub-issue graph, reconciled purely from cached GitHub
  // snapshots and the issues that open items and active or archived plans link
  // (src/issue-graph.ts). Its bytes depend on the database alone, so it is its
  // own retained representation with its own validator. /api/items and
  // /api/boards carry no GitHub data, so a snapshot write never changes their
  // bytes. Empty until the viewer's poller (PR1b) writes snapshots.
  app.get('/api/issues', conditionalSnapshot(db, 'issues', () =>
    buildIssueGraph(listIssueSnapshots(db), issueKeySets(listIssueEntities(db), listSourceLinks(db)))))

  app.post('/api/items/:id/resolve', (c) => {
    resolveItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/dismiss', (c) => {
    dismissItem(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/items/:id/annotate', async (c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => null)
    if (typeof body?.text !== 'string') return c.json({ ok: false, error: 'text must be a string' }, 400)
    const ok = annotateItem(db, c.req.param('id'), body.text)
    return c.json({ ok })
  })

  app.post('/api/items/:id/reply', async (c) => {
    const {
      text,
      context,
      kind,
      intent_client_id: intentClientId,
      intent_sequence: intentSequence,
      intent_action_id: intentActionId,
      expect_answer: expectAnswer,
    } = (await c.req.json<{
      text?: unknown
      context?: unknown
      kind?: unknown
      intent_client_id?: unknown
      intent_sequence?: unknown
      intent_action_id?: unknown
      expect_answer?: unknown
    }>().catch(() => null)) ?? {}
    // Invalid input is a 400 before any store call (issue #163); it used to
    // throw out as a 500. An explicit '' is still the clear.
    if (typeof text !== 'string') return c.json({ ok: false, error: 'text must be a string' }, 400)
    if (context !== undefined && typeof context !== 'string') {
      return c.json({ ok: false, error: 'context must be a string' }, 400)
    }
    const parsedKind = kind === undefined ? 'answer' : responseKind(kind)
    if (parsedKind === null) return c.json({ ok: false, error: 'invalid response kind' }, 400)
    const expected = expectedAnswer(expectAnswer)
    if (expected === null) return c.json({ ok: false, error: 'invalid expected answer' }, 400)
    const hasIntentClient = intentClientId !== undefined
    const hasIntentSequence = intentSequence !== undefined
    const hasIntentAction = intentActionId !== undefined
    if (new Set([hasIntentClient, hasIntentSequence, hasIntentAction]).size !== 1) {
      return c.json({ ok: false, error: 'reply intent metadata must be complete' }, 400)
    }
    const clientId = typeof intentClientId === 'string' ? intentClientId.trim() : ''
    const actionId = typeof intentActionId === 'string' ? intentActionId.trim() : ''
    if (hasIntentClient && (
      !clientId
      || clientId.length > 128
      || !actionId
      || actionId.length > 128
      || typeof intentSequence !== 'number'
      || !Number.isSafeInteger(intentSequence)
      || intentSequence < 1
    )) {
      return c.json({ ok: false, error: 'invalid reply intent metadata' }, 400)
    }
    // A refusal is ok:false (an already-picked-up reply cannot be silently
    // blanked out, src/store.ts). Issue #322 adds, additively, whether this
    // request wrote anything (an exact replay is answered from its record) and
    // the answer it left; a page that reads only `ok` sees what it always did.
    // Issue #321: a reply that expected another answer is refused with
    // reason 'answer_changed', still a 200.
    const result = replyItem(
      db,
      c.req.param('id'),
      text,
      context,
      parsedKind,
      clientId && actionId && typeof intentSequence === 'number'
        ? { clientId, sequence: intentSequence, actionId }
        : undefined,
      expected,
    )
    return c.json(result)
  })

  app.post('/api/items/:id/snooze', async (c) => {
    const body = await c.req.json<{ until?: unknown }>().catch(() => null)
    const until = snoozeUntil(body?.until)
    if (until === undefined) return c.json({ ok: false, error: 'until must be a date or null' }, 400)
    const ok = snoozeItem(db, c.req.param('id'), until)
    return c.json({ ok })
  })

  // Issue #217 — "I'll take a while". `until` is required: a date asks the
  // asking Copilot session's watcher to wait quietly until then, and an explicit
  // null stops it for good. A dropped field is a 400, never the final stop.
  // #247: an optional `defer: true` (the Later section) also pins the question
  // or snoozes it to the same time, in the same write.
  app.post('/api/items/:id/stop-waiting', async (c) => {
    const body = await c.req.json<{ until?: unknown; defer?: unknown }>().catch(() => null)
    const until = snoozeUntil(body?.until)
    if (until === undefined) return c.json({ ok: false, error: 'until must be a date or null' }, 400)
    const defer = deferField(body?.defer)
    if (defer === null) return c.json({ ok: false, error: 'defer must be a boolean' }, 400)
    const ok = stopItemWatch(db, c.req.param('id'), until, { defer })
    return c.json({ ok })
  })

  // Issue #247 — "Pin for later". `pinned` is the whole instruction: true sets
  // the question aside, false brings it back. There is no default, so a dropped
  // field is a 400 rather than a silent pin or unpin.
  app.post('/api/items/:id/later', async (c) => {
    const body = await c.req.json<{ pinned?: unknown }>().catch(() => null)
    const pinned = body?.pinned
    if (typeof pinned !== 'boolean') return c.json({ ok: false, error: 'pinned must be a boolean' }, 400)
    const ok = pinItem(db, c.req.param('id'), pinned)
    return c.json(ok ? { ok: true } : { ok: false, reason: 'not_pinnable' })
  })

  const allBoards = conditionalSnapshot(db, 'boards', () => listBoards(db))
  // Issue #287: the same dock watcher read every plan, every row and all of their
  // background every 3 seconds as well. `?scope=attention` serves the same shape
  // narrowed to the plans holding a blocked row and to those rows, as its own
  // cached representation with its own validator, so neither can revalidate or
  // evict the other; any other query string keeps the full response.
  const attentionBoards = conditionalSnapshot(db, 'attention-boards', () => listBoardsWithBlockedRows(db))
  app.get('/api/boards', (c, next) => (c.req.query('scope') === 'attention' ? attentionBoards : allBoards)(c, next))

  // Issue #299: the complete archived plans, every row with all of its
  // background, read only while a surface needs them (the archived fold, a plan
  // lingering after its agent archived it, search, a deep link, Handoffs or Plan
  // flow). The poll reads the summary below instead: each archived plan in
  // brief, so counts, the rail, issue activity and the Dashboard stay exact
  // without the list. Each is its own representation with its own validator.
  app.get('/api/boards/archived', conditionalSnapshot(db, 'archived-boards', () => listBoards(db, { status: 'archived' })))
  app.get('/api/boards/archived/summary', conditionalSnapshot(db, 'archived-summary', () => listArchivedSummary(db, RECENT_OUTCOMES)))

  app.post('/api/boards/:id/archive', async (c) => {
    const body = await c.req.json<{ expected_version?: number }>().catch(() => null)
    if (!Number.isInteger(body?.expected_version)) return c.json({ ok: false, error: 'expected_version required' }, 400)
    const ok = archiveBoard(db, c.req.param('id'), body!.expected_version!)
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/unarchive', async (c) => {
    const body = await c.req.json<{ expected_version?: number }>().catch(() => null)
    if (!Number.isInteger(body?.expected_version)) return c.json({ ok: false, error: 'expected_version required' }, 400)
    const ok = unarchiveBoard(db, c.req.param('id'), body!.expected_version!)
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/rows/:rowId/annotate', async (c) => {
    const { text, kind, expected_revision, expected_board_version } = (await c.req.json<{
      text?: unknown
      kind?: unknown
      expected_revision?: number
      expected_board_version?: number
    }>().catch(() => null)) ?? {}
    // As for an item reply (issue #163): invalid input is a 400, never a 500.
    if (typeof text !== 'string') return c.json({ ok: false, error: 'text must be a string' }, 400)
    const parsedKind = kind === undefined ? 'answer' : responseKind(kind)
    if (parsedKind === null) return c.json({ ok: false, error: 'invalid response kind' }, 400)
    if (!Number.isInteger(expected_revision) || !Number.isInteger(expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const ok = annotateBoardRow(
      db,
      c.req.param('rowId'),
      text,
      parsedKind,
      expected_revision,
      expected_board_version,
    )
    return c.json(ok ? { ok: true } : { ok: false, reason: 'version_mismatch' })
  })

  app.post('/api/boards/:id/rows/:rowId/snooze', async (c) => {
    const body = await c.req.json<{
      until?: unknown
      expected_revision?: number
      expected_board_version?: number
    }>().catch(() => null)
    if (!Number.isInteger(body?.expected_revision) || !Number.isInteger(body?.expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const until = snoozeUntil(body?.until)
    if (until === undefined) return c.json({ ok: false, error: 'until must be a date or null' }, 400)
    const rowId = c.req.param('rowId')
    const ok = snoozeBoardRow(
      db,
      rowId,
      until,
      body?.expected_revision,
      body?.expected_board_version,
    )
    if (ok) return c.json({ ok: true })
    // Refused against the caller's CURRENT snapshot ⇒ the row itself cannot be
    // snoozed (answered, handled, not blocked, or archived). Anything else, a moved
    // revision or a vanished row, is a stale snapshot (#160).
    const currentBoard = [
      ...listBoards(db),
      ...listBoards(db, { status: 'archived' }),
    ].find((board) => board.rows.some((row) => row.id === rowId))
    const current = currentBoard?.rows.find((row) => row.id === rowId)
    return c.json(
      current
        && current.revision === body?.expected_revision
        && currentBoard?.revision === body?.expected_board_version
        ? { ok: false, reason: 'not_snoozable' }
        : { ok: false, reason: 'version_mismatch' },
    )
  })

  // Issue #217 — the row twin of /api/items/:id/stop-waiting, pinned to the row
  // and board revisions like every other human row action. A refusal against
  // the caller's current pins means the row cannot be stopped (answered, handled,
  // no longer blocked, archived, or already stopped for good).
  app.post('/api/boards/:id/rows/:rowId/stop-waiting', async (c) => {
    const body = await c.req.json<{
      until?: unknown
      defer?: unknown
      expected_revision?: unknown
      expected_board_version?: unknown
    }>().catch(() => null)
    const revision = body?.expected_revision
    const boardRevision = body?.expected_board_version
    if (!Number.isInteger(revision) || !Number.isInteger(boardRevision)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    const until = snoozeUntil(body?.until)
    if (until === undefined) return c.json({ ok: false, error: 'until must be a date or null' }, 400)
    const defer = deferField(body?.defer)
    if (defer === null) return c.json({ ok: false, error: 'defer must be a boolean' }, 400)
    const rowId = c.req.param('rowId')
    if (stopBoardRowWatch(db, rowId, until, revision as number, boardRevision as number, { defer })) return c.json({ ok: true })
    const currentBoard = [
      ...listBoards(db),
      ...listBoards(db, { status: 'archived' }),
    ].find((board) => board.rows.some((row) => row.id === rowId))
    const current = currentBoard?.rows.find((row) => row.id === rowId)
    return c.json(
      current && current.revision === revision && currentBoard?.revision === boardRevision
        ? { ok: false, reason: 'not_stoppable' }
        : { ok: false, reason: 'version_mismatch' },
    )
  })

  // Issue #247 — the row twin of /api/items/:id/later, pinned to the row and
  // board revisions like every other human row action. A refusal against the
  // caller's current pins means the row cannot be pinned (answered, handled, no
  // longer blocked, archived, or nothing to unpin); anything else is stale (#160).
  app.post('/api/boards/:id/rows/:rowId/later', async (c) => {
    const body = await c.req.json<{
      pinned?: unknown
      expected_revision?: unknown
      expected_board_version?: unknown
    }>().catch(() => null)
    const pinned = body?.pinned
    const revision = body?.expected_revision
    const boardRevision = body?.expected_board_version
    if (!Number.isInteger(revision) || !Number.isInteger(boardRevision)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    if (typeof pinned !== 'boolean') return c.json({ ok: false, error: 'pinned must be a boolean' }, 400)
    const rowId = c.req.param('rowId')
    if (pinBoardRow(db, rowId, pinned, revision as number, boardRevision as number)) return c.json({ ok: true })
    const currentBoard = [
      ...listBoards(db),
      ...listBoards(db, { status: 'archived' }),
    ].find((board) => board.rows.some((row) => row.id === rowId))
    const current = currentBoard?.rows.find((row) => row.id === rowId)
    return c.json(
      current && current.revision === revision && currentBoard?.revision === boardRevision
        ? { ok: false, reason: 'not_pinnable' }
        : { ok: false, reason: 'version_mismatch' },
    )
  })

  // issue #36 — the human's OTHER answer on a blocked row: "I have done my part".
  // The annotate route above is the words; this is the deed, and it is what makes
  // a blocked TASK row clearable at all without the asking agent still being alive.
  //
  // `{ handled: false }` is the undo, and it is the ONE thing here that can be
  // REFUSED: clearRowHandled will not blank a mark an agent has already been
  // handed (un-marking cannot un-tell them). That refusal is a 200 with
  // `{ ok: false }`, never a 4xx — postJSON() in public/app.js keys on the HTTP
  // status to decide "the write never happened", so a refusal dressed as an error
  // would show the human WRITE_FAILED and invite a retry that can never succeed.
  // Exactly the /api/items/:id/reply precedent.
  //
  // A missing `handled` ⇒ MARK. The affirmative action is the default because it
  // is the one the human reaches for, and because a POST that quietly UN-marked
  // would be the most destructive possible reading of a dropped field. A PRESENT
  // non-boolean is no instruction either way (the string "false" must not
  // re-mark), so it is a 400 before any store call — as is an unparseable body,
  // which cannot carry the revision pins (issue #163).
  // `ok:false` also covers an unknown row id: both store writes report whether they
  // matched a row, so the route never claims a success that never touched the
  // database.
  //
  // What the HUMAN sees in that case is NOT a message, despite an earlier version of
  // this comment saying so. A stale click on a row an agent has since deleted is
  // refused here, and then `reloadAndPaint()` destroys the row — and the error slot
  // with it — so the row simply disappears. That is defensible (the row is genuinely
  // gone, and disappearing is the truth) but it is silent, and the client's refusal
  // branch renders the UN-MARK wording for it, which is the wrong sentence. Both are
  // cosmetic only because the frame is unreachable; fix them together if this route
  // ever gains a failure mode that leaves the row on screen.
  app.post('/api/boards/:id/rows/:rowId/handled', async (c) => {
    const body = await c.req.json<{
      handled?: unknown
      expected_revision?: number
      expected_board_version?: number
    }>().catch(() => null)
    if (!Number.isInteger(body?.expected_revision) || !Number.isInteger(body?.expected_board_version)) {
      return c.json({ ok: false, error: 'expected_revision and expected_board_version required' }, 400)
    }
    if (body?.handled !== undefined && typeof body.handled !== 'boolean') {
      return c.json({ ok: false, error: 'handled must be a boolean' }, 400)
    }
    const rowId = c.req.param('rowId')
    const ok = body?.handled === false
      ? clearRowHandled(db, rowId, body?.expected_revision, body?.expected_board_version)
      : markRowHandled(db, rowId, body?.expected_revision, body?.expected_board_version)
    if (ok) return c.json({ ok: true })
    const currentBoard = [
      ...listBoards(db),
      ...listBoards(db, { status: 'archived' }),
    ].find((board) => board.rows.some((row) => row.id === rowId))
    const current = currentBoard?.rows.find((row) => row.id === rowId)
    return c.json(
      current && (
        current.revision !== body?.expected_revision
        || currentBoard?.revision !== body?.expected_board_version
      )
        ? { ok: false, reason: 'version_mismatch' }
        : { ok: false },
    )
  })

  // ── project closure (issue #32) ───────────────────────────────────────────
  // The EFFECTIVE closed set — closures the derived reopen rule has not already
  // undone. Read by public/app.js (title badge, rail fold) AND by
  // electron/main.cjs (dock badge): tenet 3 says one attention set, and the main
  // process cannot see the renderer's localStorage, so this has to be server
  // state rather than a client-side toggle.
  app.get('/api/projects/closed', (c) => c.json(closedProjects(db)))

  // Project names are agent-authored free text and routinely contain '/' and
  // spaces, which Hono's :param will not match — hence a JSON body, never a path
  // param. The 400 matters: app.js's postJSON() keys on res.ok, so a rejected
  // close surfaces to the human instead of vanishing into an optimistic UI.
  app.post('/api/projects/close', async (c) => {
    const project = validProject(await c.req.json().catch(() => null))
    if (project === null) return c.json({ ok: false, error: 'project required' }, 400)
    closeProject(db, project)
    return c.json({ ok: true })
  })

  app.post('/api/projects/reopen', async (c) => {
    const project = validProject(await c.req.json().catch(() => null))
    if (project === null) return c.json({ ok: false, error: 'project required' }, 400)
    reopenProject(db, project)
    return c.json({ ok: true })
  })

  return app
}
