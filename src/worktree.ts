// Issue #432 — a driven session in its own git worktree. Design:
// docs/superpowers/specs/2026-11-03-session-worktrees-design.md §1, §2, §5.
//
// Electron main derives the worktree's path and branch from what it already
// checks (the folder, the task, the launch id), shows both in its native
// confirmation, and sends them in the `new` spec's `worktree` field. The
// driver re-checks them here, then creates the worktree before its status
// line with `git worktree add --lock`, argv only, using the trusted `git` on
// the captured PATH. A refusal after creation undoes only what this launch
// made; nothing else is ever removed here, and a branch that moved is kept.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'

// The path as it is on disk. Node's realpathSync keeps the case it was given, so
// on a case-insensitive volume `/W/App/x` "resolves" to itself even when the
// folder is `/w/app/x`, and a root in another case would pass every string
// comparison with the checkout. The native call returns the on-disk case.
const realPath = (path: string): string => realpathSync.native(path)
import { basename, dirname, isAbsolute, normalize } from 'node:path'

/** What main planned and the confirmation showed: `<root>/<repo>/<slug>-<short>` on `agent-inbox/<slug>-<short>`. */
export interface WorktreePlan {
  path: string
  branch: string
}

/** A worktree this launch created: what the launch row records, and what an undo needs. */
export interface CreatedWorktree {
  checkout: string
  path: string
  branch: string
  baseSha: string
  /** The checkout's branch at the start, as a full ref; null on a detached HEAD. */
  baseRef: string | null
  /** The checkout's uncommitted and untracked entries, which stay there; null when unread. */
  dirty: number | null
}

const BRANCH = /^agent-inbox\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
// what Copilot's tool patterns would read (editsFolder refuses the same set)
const PATTERN_UNSAFE = /[()*?[\]{},\\\u0000-\u001f\u007f]/
const MAX_LEAF = 32 + 1 + 8
const ADD_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 30_000
const UNLOCK_TIMEOUT_MS = 10_000
// variables that would point git at another repository than the checkout
const REDIRECTS = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why a spec's `worktree` field is not a plan this launch may use, or null. Pure. */
export function worktreePlanError(value: unknown, launchId: string): string | null {
  if (!isRecord(value)) return 'worktree must be an object'
  for (const key of Object.keys(value)) if (key !== 'path' && key !== 'branch') return `unknown worktree field ${key}`
  const { path, branch } = value
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || normalize(path) !== path || path.endsWith('/')) {
    return 'worktree path must be a normalized absolute path'
  }
  if (PATTERN_UNSAFE.test(path)) return 'worktree path must have none of ( ) * ? [ ] { } , \\ or a control character'
  if (typeof branch !== 'string' || !BRANCH.test(branch)) return 'worktree branch must be agent-inbox/<slug>-<launch id>'
  const leaf = basename(path)
  const root = dirname(dirname(path))
  if (leaf.length > MAX_LEAF || branch !== `agent-inbox/${leaf}` || !leaf.endsWith(`-${launchId.slice(0, 8)}`)) {
    return 'worktree path and branch must both end in <slug>-<the launch id’s first 8 digits>'
  }
  if (!REPO_NAME.test(basename(dirname(path))) || root === '/') return 'worktree path must be <root>/<repo>/<slug>-<short>'
  return null
}

/** Git's environment: the session's own, minus anything that redirects the repository, never prompting. */
export function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !REDIRECTS.has(key)) out[key] = value
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  /** git's own message, one line, for a refusal */
  message: string
}

function runGit(git: string, env: NodeJS.ProcessEnv, dir: string, args: string[], timeoutMs: number): GitResult {
  const result = spawnSync(git, ['-C', dir, ...args], {
    env, cwd: '/', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
  const stderr = (result.stderr ?? '').trim()
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  const message = timedOut
    ? `git ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)} s`
    : result.error ? `git could not run (${(result.error as NodeJS.ErrnoException).code ?? 'error'})`
    : (stderr.split('\n').find((line) => line.trim()) ?? `git ${args[0]} failed`).slice(0, 300)
  return { ok: !result.error && result.status === 0, code: result.status, stdout: result.stdout ?? '', message }
}

function ownedPrivate(path: string): boolean {
  const info = statSync(path)
  const uid = process.getuid?.() ?? -1
  return info.uid === uid && (info.mode & 0o022) === 0
}

// A folder the driver may put worktrees under: a real directory (no symlink
// anywhere on its path), owned by this user and not writable by group or
// others. `create` makes it 0700 when only it is missing.
function checkFolder(dir: string, create: boolean, what: string): string | null {
  try {
    lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) return `${what} ${dir} does not exist`
    try {
      // never create anything through a symlink
      if (realPath(dirname(dir)) !== dirname(dir)) return `${what} ${dir} lies under a symlink, or is not written in its on-disk letter case`
      mkdirSync(dir, { mode: 0o700 })
    } catch (made) {
      return `cannot create ${what} ${dir} (${(made as NodeJS.ErrnoException).code ?? 'error'})`
    }
  }
  try {
    const info = lstatSync(dir)
    if (info.isSymbolicLink() || !info.isDirectory() || realPath(dir) !== dir) {
      return `${what} ${dir} is a symlink or lies under one, or is not written in its on-disk letter case`
    }
    if (!ownedPrivate(dir)) return `${what} ${dir} is not owned by you, or is writable by others`
  } catch {
    return `${what} ${dir} cannot be read`
  }
  return null
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`)

/**
 * Creates the launch's worktree from the checkout's current HEAD commit, locked
 * for as long as the session holds it (§2 steps 2–5). `checkout` is the
 * spec's folder as it resolves now, in its on-disk case (realpathSync.native). Refuses, creating nothing, on a folder that
 * is not a repository's top, an unborn HEAD, a root that is a symlink, not
 * yours, writable by others or inside the checkout, an existing path or branch.
 */
export function createWorktree(o: {
  git: string
  env: NodeJS.ProcessEnv
  checkout: string
  plan: WorktreePlan
  launchId: string
}): { ok: true; worktree: CreatedWorktree } | { ok: false; error: string } {
  const { git, env, checkout, plan } = o
  const planError = worktreePlanError(plan, o.launchId)
  if (planError) return { ok: false, error: planError }
  const top = runGit(git, env, checkout, ['rev-parse', '--show-toplevel'], READ_TIMEOUT_MS)
  let topReal: string | null = null
  try { topReal = top.ok ? realPath(top.stdout.trim()) : null } catch { /* gone */ }
  if (topReal !== checkout) return { ok: false, error: `${checkout} is not the top folder of a git repository with a working tree` }
  const head = runGit(git, env, checkout, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], READ_TIMEOUT_MS)
  const baseSha = head.stdout.trim()
  if (!head.ok || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseSha)) return { ok: false, error: 'This repository has no commits yet' }
  const symbolic = runGit(git, env, checkout, ['symbolic-ref', '-q', 'HEAD'], READ_TIMEOUT_MS)
  const baseRef = symbolic.ok && symbolic.stdout.trim().startsWith('refs/heads/') ? symbolic.stdout.trim() : null

  const repoDir = dirname(plan.path)
  const root = dirname(repoDir)
  // before anything is created; checkFolder then proves the root and <root>/<repo> are their own real
  // paths. A root that holds the checkout is fine, unless <root>/<repo> is the checkout itself.
  if (inside(root, checkout)) return { ok: false, error: `the worktree folder ${root} is inside the repository ${checkout}` }
  if (inside(plan.path, checkout)) return { ok: false, error: `the worktree ${plan.path} would be inside the repository ${checkout}` }
  const rootError = checkFolder(root, true, 'the worktree folder')
  if (rootError) return { ok: false, error: rootError }
  const repoError = checkFolder(repoDir, true, 'the worktree folder')
  if (repoError) return { ok: false, error: repoError }
  try {
    lstatSync(plan.path)
    return { ok: false, error: `${plan.path} already exists` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, error: `${plan.path} cannot be read` }
  }
  const existing = runGit(git, env, checkout, ['rev-parse', '--verify', '-q', `refs/heads/${plan.branch}`], READ_TIMEOUT_MS)
  if (existing.ok) return { ok: false, error: `a branch named ${plan.branch} already exists` }

  // uncommitted and untracked changes stay in the checkout (§2, A2): counted for the log only
  const status = runGit(git, { ...env, GIT_OPTIONAL_LOCKS: '0' }, checkout, ['status', '--porcelain=v1', '-z', '--no-renames'], READ_TIMEOUT_MS)
  const dirty = status.ok ? status.stdout.split('\0').filter(Boolean).length : null

  const worktree: CreatedWorktree = { checkout, path: plan.path, branch: plan.branch, baseSha, baseRef, dirty }
  const add = runGit(git, env, checkout, [
    'worktree', 'add', '--lock', '--reason', `agent-inbox launch ${o.launchId.slice(0, 8)}`, '-b', plan.branch, plan.path, baseSha,
  ], ADD_TIMEOUT_MS)
  if (!add.ok) {
    // the path and branch did not exist a moment ago, so whatever is there now is this add's
    undoWorktree(git, env, worktree)
    return { ok: false, error: add.message }
  }
  let real: string | null = null
  try { real = realPath(plan.path) } catch { /* checked below */ }
  if (real !== plan.path) {
    undoWorktree(git, env, worktree)
    return { ok: false, error: `${plan.path} did not resolve to itself after git created it` }
  }
  return { ok: true, worktree }
}

/**
 * Undoes a worktree this launch just created, after a later refusal (§2): the
 * worktree first (only git and the checkout hook have touched it), then the
 * branch, compare-and-delete at the base, so a branch that moved survives.
 * Returns whether the worktree is gone.
 */
export function undoWorktree(git: string, env: NodeJS.ProcessEnv, worktree: Pick<CreatedWorktree, 'checkout' | 'path' | 'branch' | 'baseSha'>): boolean {
  runGit(git, env, worktree.checkout, ['worktree', 'unlock', worktree.path], UNLOCK_TIMEOUT_MS)
  runGit(git, env, worktree.checkout, ['worktree', 'remove', '--force', worktree.path], ADD_TIMEOUT_MS)
  let gone = false
  try { lstatSync(worktree.path) } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ENOENT' }
  // git deletes a branch even while a worktree has it checked out (A8): only once that worktree is gone
  if (gone) runGit(git, env, worktree.checkout, ['update-ref', '-d', `refs/heads/${worktree.branch}`, worktree.baseSha], READ_TIMEOUT_MS)
  return gone
}

/** Unlocks the launch's worktree when it ends (§5); a parked launch keeps its lock. Returns git's refusal, or null. */
export function unlockWorktree(git: string, env: NodeJS.ProcessEnv, checkout: string, path: string): string | null {
  const result = runGit(git, env, checkout, ['worktree', 'unlock', path], UNLOCK_TIMEOUT_MS)
  return result.ok ? null : result.message
}

// ── Remove worktree (#432 §5): `driver-cli.js worktree inspect|remove` ─────────

/** What Remove worktree's confirmation shows, and the status a discard is bound to. */
export interface WorktreeState {
  /** Its folder was deleted by hand; git still lists it, and remove cleans only that entry. */
  missing: boolean
  /** Uncommitted and untracked entries in the worktree. */
  dirty: number
  /** Commits on the branch that its base (the checkout's branch then, else the base commit) lacks. */
  ahead: number
  upstream: boolean
  /** sha256 of `status --porcelain=v1 -z`: Discard and remove forces only while it still matches. */
  status: string
}

type LaunchWorktree = { git: string; env: NodeJS.ProcessEnv; checkout: string; path: string; branch: string; baseRef: string | null; baseSha: string }

// git's own entry for exactly this path on exactly this branch, or why not. A
// worktree whose folder is gone and that git no longer lists is already removed.
function listedEntry(o: LaunchWorktree): string | 'gone' | null {
  const list = runGit(o.git, o.env, o.checkout, ['worktree', 'list', '--porcelain', '-z'], READ_TIMEOUT_MS)
  if (!list.ok) return list.message
  // with -z, each attribute ends in NUL and each entry in an extra NUL
  const entries = list.stdout.split('\0\0').map((entry) => entry.split('\0'))
  const entry = entries.find((lines) => lines[0] === `worktree ${o.path}`)
  if (!entry) return missing(o.path) ? 'gone' : `git does not list ${o.path} as a worktree of ${o.checkout}`
  if (!entry.includes(`branch refs/heads/${o.branch}`)) return `${o.path} is no longer on ${o.branch}, so Agent Inbox leaves it to you`
  return null
}

function statusOf(o: LaunchWorktree): { dirty: number; status: string } | { error: string } {
  const status = runGit(o.git, { ...o.env, GIT_OPTIONAL_LOCKS: '0' }, o.path, ['status', '--porcelain=v1', '-z', '--no-renames'], READ_TIMEOUT_MS)
  if (!status.ok) return { error: status.message }
  return { dirty: status.stdout.split('\0').filter(Boolean).length, status: createHash('sha256').update(status.stdout).digest('hex') }
}

function missing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Reads what Remove worktree's confirmation shows (§5 step 2). */
export function inspectWorktree(o: LaunchWorktree): { ok: true; state: WorktreeState } | { ok: false; error: string } {
  const unlisted = listedEntry(o)
  if (unlisted && unlisted !== 'gone') return { ok: false, error: unlisted }
  const gone = missing(o.path)
  const status = gone ? { dirty: 0, status: createHash('sha256').update('').digest('hex') } : statusOf(o)
  if ('error' in status) return { ok: false, error: status.error }
  const ref = `refs/heads/${o.branch}`
  const base = o.baseRef && runGit(o.git, o.env, o.checkout, ['rev-parse', '--verify', '-q', `${o.baseRef}^{commit}`], READ_TIMEOUT_MS).ok ? o.baseRef : o.baseSha
  const ahead = runGit(o.git, o.env, o.checkout, ['rev-list', '--count', `${base}..${ref}`], READ_TIMEOUT_MS)
  const upstream = runGit(o.git, o.env, o.checkout, ['for-each-ref', '--format=%(upstream)', ref], READ_TIMEOUT_MS)
  return {
    ok: true,
    state: { missing: gone, ...status, ahead: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0, upstream: upstream.ok && upstream.stdout.trim() !== '' },
  }
}

/**
 * Removes the worktree, never its branch (§5 step 4). Without `discard`, git
 * refuses a worktree with changes; with it, `--force` is added only while the
 * status still hashes to what the human was shown. Ignored files go either way.
 */
export function removeLaunchWorktree(o: LaunchWorktree & { discard?: string }): { ok: true } | { ok: false; error: string } {
  const unlisted = listedEntry(o)
  if (unlisted === 'gone') return { ok: true }
  if (unlisted) return { ok: false, error: unlisted }
  if (o.discard !== undefined) {
    const now = missing(o.path) ? null : statusOf(o)
    if (!now || 'error' in now || now.status !== o.discard) return { ok: false, error: 'The worktree changed since you looked at it, so nothing was removed. Look at it again.' }
  }
  runGit(o.git, o.env, o.checkout, ['worktree', 'unlock', o.path], UNLOCK_TIMEOUT_MS)
  const removed = runGit(o.git, o.env, o.checkout, ['worktree', 'remove', ...(o.discard !== undefined ? ['--force'] : []), o.path], ADD_TIMEOUT_MS)
  return removed.ok ? { ok: true } : { ok: false, error: removed.message }
}
