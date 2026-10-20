// Which Agent Inbox build each host's agents are registered to run (issue
// #197, part 2). VIEWER-PROCESS-ONLY and read-only: no process, no network, no
// lock, no write. It never asks the host CLIs (`claude mcp get` health-checks a
// server by starting it); it reads the same files the installer manages.
//
// What it reads, and the ONLY thing it keeps from each file:
//   ~/.claude.json               mcpServers['agent-inbox']  (Claude Code, user scope)
//   ~/.copilot/mcp-config.json   mcpServers['agent-inbox']  (Copilot CLI)
//   ~/.claude/settings.json      agent-inbox-shaped hook entries
// Each file is parsed in memory and dropped. Every other MCP server, its env
// and any secret beside it are never returned, logged or cached: a result is a
// closed `kind`, a strict-semver `version`, a runtime id, or (for a source
// checkout only) the checkout's root.
//
// A registration is Setup's runtime under exactly the rule the installer uses
// before it may replace one (scripts/runtime-config.mjs
// classifyRuntimeRegistration): its node binary and entry script both resolve,
// by real filesystem identity, into the SAME directory under the runtime root,
// and that directory is an intact runtime whose manifest names it.
// test/agent-hosts.test.ts runs the installer's helper over the same files and
// holds the two to agreement, so Setup never offers to update a registration
// the installer would refuse to replace. scripts/runtime-config.mjs mirrors the
// hooks half too (classifyHookLauncher, issue #218, which splits this rule's
// unknown into dead, elsewhere and unknown): both hook-install modes sort each
// entry by it before they refuse or replace another install's hook set.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'

export type HostKind = 'none' | 'runtime' | 'checkout' | 'other' | 'unknown'

/**
 * none     — no agent-inbox registration (or no agent-inbox hook entries)
 * runtime  — Setup's runtime: `runtimeId` under the runtime root, `version` its manifest's
 * checkout — a source checkout of this repo at `path`, which Setup does not manage
 * other    — some other command, which Setup does not manage (an MCP registration
 *            of a runtime outside the root included: the installer's `custom`)
 * unknown  — present but unreadable, malformed, split across builds, or not an
 *            intact runtime; for hooks, also a runtime outside the root (#232)
 */
export interface HostRegistration {
  kind: HostKind
  version?: string
  runtimeId?: string
  path?: string
}

export interface AgentHosts {
  claude: HostRegistration
  copilot: HostRegistration
  hooks: HostRegistration
}

/** electron/runtime-verify.cjs verifyRuntimePayload, injectable so tests can count the hashing. */
export type RuntimeVerifier = (opts: {
  root: string
  expectedManifestDigest?: string
  expectedPlatform?: string
  expectedArch?: string
  expectedPackageVersion?: string
  expectedProduct?: string
  expectedNodeMajor?: number
  expectedNodeModulesAbi?: string
  requiredEntrypoints?: string[]
  requiredFiles?: string[]
}) => { manifest: { runtimeId: string; packageVersion?: unknown } }

/** Verify one directory under the runtime root: its version, or null when it is not an intact runtime of ours. */
export type RuntimeCheck = (dir: string, runtimeId: string) => { version: string | null } | null

const SERVER = 'agent-inbox'
const MANIFEST_FILE = 'runtime-manifest.json'
const PRODUCT = 'agent-inbox-runtime'
// docs/hooks.md's subcommands — the same set scripts/runtime-config.mjs uses
// to recognize one of our hook entries by shape.
const HOOK_SUBCOMMANDS = new Set(['notification', 'session-start', 'session-end', 'prompt-submit', 'stop', 'watch'])
// ~/.claude.json carries per-project history and can grow large; anything past
// this is reported unknown rather than parsed on the viewer thread.
const MAX_CONFIG_BYTES = 64 * 1024 * 1024
const MAX_SMALL_FILE_BYTES = 4 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const RUNTIME_ID = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,159}$/
const CONTROL = /[\u0000-\u001f\u007f]/

/** The three host config files the installers manage under `home`. */
export function agentConfigFiles(home: string): string[] {
  return [join(home, '.claude.json'), join(home, '.copilot', 'mcp-config.json'), join(home, '.claude', 'settings.json')]
}

type Config = { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; value: unknown }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

// Absent exactly when the installer's existsSync() says so (a dangling symlink
// included); anything else that cannot be read and parsed is unreadable.
function readConfig(path: string): Config {
  let size: number
  try {
    const st = statSync(path)
    if (!st.isFile()) return { state: 'unreadable' }
    size = st.size
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'absent' } : { state: 'unreadable' }
  }
  if (size > MAX_CONFIG_BYTES) return { state: 'unreadable' }
  try {
    const raw = readFileSync(path, 'utf8')
    return { state: 'ok', value: raw.trim() === '' ? {} : JSON.parse(raw) }
  } catch {
    return { state: 'unreadable' }
  }
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function isUnder(root: string, child: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep)
}

function firstSegmentUnder(root: string, child: string): string {
  return child.slice(root.length).replace(/^[/\\]/, '').split(/[\\/]/)[0] ?? ''
}

function smallJson(path: string): unknown {
  const st = lstatSync(path)
  if (!st.isFile() || st.size > MAX_SMALL_FILE_BYTES) return null
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

// The install folder whose dist/<script> the canonical `file` is, or null.
function installDir(file: string, script: string): string | null {
  return basename(file) === script && basename(dirname(file)) === 'dist' ? dirname(dirname(file)) : null
}

// A source checkout of this repo: beside a package.json named agent-inbox.
function isCheckout(dir: string): boolean {
  try {
    const pkg = smallJson(join(dir, 'package.json'))
    return isPlainObject(pkg) && pkg['name'] === 'agent-inbox'
  } catch {
    return false
  }
}

function runtimeRegistration(runtimeId: string, version: string | null): HostRegistration {
  const out: HostRegistration = { kind: 'runtime' }
  if (version && version.length <= 64 && SEMVER.test(version)) out.version = version
  if (RUNTIME_ID.test(runtimeId)) out.runtimeId = runtimeId
  return out
}

function checkoutRegistration(root: string): HostRegistration {
  return root.length <= 4096 && !CONTROL.test(root) ? { kind: 'checkout', path: root } : { kind: 'checkout' }
}

// One {command, entry} launcher, by the installer's structural rule. A
// runtime's layout outside the root (`elsewhere`) is never Setup's; each caller
// says what it is to Setup.
type Launcher = HostRegistration | { kind: 'elsewhere' }

function classifyLauncher(command: string, entry: string, runtimeRoot: string, check: RuntimeCheck, script: string): Launcher {
  // an entry that is not a path (`npx tsx src/…`) is somebody's own command
  if (!isAbsolute(entry)) return { kind: 'other' }
  const file = canonical(entry)
  // a command looked up on PATH is never inside a runtime directory
  const node = isAbsolute(command) ? canonical(command) : null
  if (!file || (isAbsolute(command) && !node)) return { kind: 'unknown' }
  const root = canonical(runtimeRoot)
  const nodeIn = root !== null && node !== null && isUnder(root, node)
  const fileIn = root !== null && isUnder(root, file)
  if (root !== null && (nodeIn || fileIn)) {
    if (nodeIn !== fileIn) return { kind: 'unknown' }
    const runtimeId = firstSegmentUnder(root, file)
    if (!runtimeId || runtimeId !== firstSegmentUnder(root, node!)) return { kind: 'unknown' }
    const verified = check(join(root, runtimeId), runtimeId)
    return verified ? runtimeRegistration(runtimeId, verified.version) : { kind: 'unknown' }
  }
  const dir = installDir(file, script)
  if (dir === null) return { kind: 'other' }
  if (existsSync(join(dir, MANIFEST_FILE))) return { kind: 'elsewhere' }
  return isCheckout(dir) ? checkoutRegistration(dir) : { kind: 'other' }
}

function mcpRegistration(path: string, runtimeRoot: string, check: RuntimeCheck): HostRegistration {
  const config = readConfig(path)
  if (config.state === 'absent') return { kind: 'none' }
  if (config.state === 'unreadable') return { kind: 'unknown' }
  const servers = isPlainObject(config.value) ? own(config.value, 'mcpServers') : undefined
  const entry = isPlainObject(servers) ? own(servers, SERVER) : undefined
  if (entry === undefined) return { kind: 'none' }
  const command = isPlainObject(entry) ? own(entry, 'command') : undefined
  const args = isPlainObject(entry) ? own(entry, 'args') : undefined
  if (typeof command !== 'string' || !Array.isArray(args) || typeof args[0] !== 'string') return { kind: 'unknown' }
  const launcher = classifyLauncher(command, args[0], runtimeRoot, check, 'mcp-server.js')
  // the registration installer's `custom`, which it never replaces
  return launcher.kind === 'elsewhere' ? { kind: 'other' } : launcher
}

// Every hook entry shaped like ours ({command, args:[entry, subcommand]}),
// across every event and group; another tool's hooks are never collected.
function hookLaunchers(settings: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const hooks = isPlainObject(settings) ? own(settings, 'hooks') : undefined
  if (!isPlainObject(hooks)) return out
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const list = isPlainObject(group) ? own(group, 'hooks') : undefined
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const args = isPlainObject(entry) ? own(entry, 'args') : undefined
        if (Array.isArray(args) && args.length === 2 && HOOK_SUBCOMMANDS.has(args[1] as string)) {
          out.push(entry as Record<string, unknown>)
        }
      }
    }
  }
  return out
}

function hooksRegistration(path: string, runtimeRoot: string, check: RuntimeCheck): HostRegistration {
  const config = readConfig(path)
  if (config.state === 'absent') return { kind: 'none' }
  if (config.state === 'unreadable') return { kind: 'unknown' }
  const launchers = hookLaunchers(config.value)
  if (launchers.length === 0) return { kind: 'none' }
  const results = launchers.map((entry): HostRegistration => {
    const command = own(entry, 'command')
    const args = own(entry, 'args') as unknown[]
    if (typeof command !== 'string' || typeof args[0] !== 'string') return { kind: 'unknown' }
    const launcher = classifyLauncher(command, args[0], runtimeRoot, check, 'hook-cli.js')
    // another install's set to the hook installer, which refuses beside it (#232)
    return launcher.kind === 'elsewhere' ? { kind: 'unknown' } : launcher
  })
  const first = results[0]!
  const same = results.every((r) =>
    r.kind === first.kind && r.runtimeId === first.runtimeId && r.path === first.path && r.version === first.version)
  return same ? first : { kind: 'unknown' }
}

/** Each host's agent-inbox registration and Claude's hooks, read from the config files under `home`. */
export function readAgentHosts({ home, runtimeRoot, checkRuntime }: {
  home: string
  runtimeRoot: string
  checkRuntime: RuntimeCheck
}): AgentHosts {
  // one verification per runtime directory per read, however many entries name it
  const seen = new Map<string, { version: string | null } | null>()
  const check: RuntimeCheck = (dir, runtimeId) => {
    if (!seen.has(dir)) seen.set(dir, checkRuntime(dir, runtimeId))
    return seen.get(dir) ?? null
  }
  const [claude, copilot, settings] = agentConfigFiles(home) as [string, string, string]
  return {
    claude: mcpRegistration(claude, runtimeRoot, check),
    copilot: mcpRegistration(copilot, runtimeRoot, check),
    hooks: hooksRegistration(settings, runtimeRoot, check),
  }
}

// The registered runtime's own Node identity. Ownership is the question, not
// whether THIS app could run that build: a runtime built on another Node major
// (an app upgrade moved on) is still an intact runtime of ours, so the
// verifier is told to expect exactly what the manifest itself declares.
function declaredNode(dir: string): { major: number; abi: string } | null {
  try {
    const manifest = smallJson(join(dir, MANIFEST_FILE))
    if (!isPlainObject(manifest)) return null
    const match = /^v?(\d+)\.\d+\.\d+/.exec(String(manifest['nodeVersion'] ?? ''))
    const abi = manifest['nodeModulesAbi']
    return match && typeof abi === 'string' ? { major: Number(match[1]), abi } : null
  } catch {
    return null
  }
}

/**
 * The installer's ownership test for one directory under the runtime root:
 * every manifested file present and hashing to its record, nothing extra, no
 * symlink, and a manifest whose own digest and runtime id re-derive and name
 * this directory. Nothing this app requires of its OWN payload (version,
 * platform, Node ABI, the helper files a later release added) is asked of an
 * older build.
 */
export function registeredRuntimeVersion(dir: string, runtimeId: string, verify: RuntimeVerifier): { version: string | null } | null {
  const node = declaredNode(dir)
  if (!node) return null
  try {
    const { manifest } = verify({
      root: dir,
      expectedProduct: PRODUCT,
      expectedNodeMajor: node.major,
      expectedNodeModulesAbi: node.abi,
      requiredEntrypoints: [],
      requiredFiles: [],
    })
    if (manifest.runtimeId !== runtimeId) return null
    return { version: typeof manifest.packageVersion === 'string' ? manifest.packageVersion : null }
  } catch {
    return null
  }
}
