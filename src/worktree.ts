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
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'

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
  /** Uncommitted changes in the worktree: every changed tracked file and every untracked file. */
  dirty: number
  /** Up to 5 of them, for the confirmation. */
  examples: string[]
  /** Why Discard cannot be offered (a nested repository, a worktree too large to fingerprint), or null. */
  noDiscard: string | null
  /** Commits on the branch that its base (the checkout's branch then, else the base commit) lacks. */
  ahead: number
  upstream: boolean
  /**
   * The worktree's fingerprint, which Discard and remove is bound to: the status
   * of every file, the full diff of tracked files against HEAD, and each
   * untracked file's path, size, mtime and content hash. '' when it cannot be
   * taken (see noDiscard).
   */
  status: string
}

// The base as the row recorded it, before it reaches git's argv: a branch ref and a commit id only
// (the driver wrote both; a hand-edited row cannot turn them into an option)
const baseRefOf = (ref: string | null): string | null => (ref && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes('..') ? ref : null)
const isSha = (sha: string): boolean => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)

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

const MAX_FINGERPRINT_FILES = 20_000
// untracked files up to this size are hashed whole; above it, size and mtime stand in
const HASHED_FILE_BYTES = 8 * 1024 * 1024
// the content hashed in all, beyond which every further file is size and mtime only
const HASHED_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_DIFF_BYTES = 256 * 1024 * 1024
const EXAMPLE_LENGTH = 200

type Fingerprint = { dirty: number; examples: string[]; status: string; noDiscard: string | null }

function hashFile(path: string, hash: ReturnType<typeof createHash>): void {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n))
  } finally {
    closeSync(fd)
  }
}

// Any initialized submodule: a tracked gitlink (mode 160000) whose folder holds a
// `.git`, or this worktree's own `modules` folder in its git dir. `at` is the
// first such path ('' when only the modules folder shows one), or null for none.
function checkedOutSubmodule(o: LaunchWorktree, env: NodeJS.ProcessEnv): { at: string | null } | { error: string } {
  const staged = runGit(o.git, env, o.path, ['ls-files', '--stage', '-z'], READ_TIMEOUT_MS)
  if (!staged.ok) return { error: staged.message }
  for (const entry of staged.stdout.split('\0')) {
    if (!entry.startsWith('160000 ')) continue
    const name = entry.slice(entry.indexOf('\t') + 1)
    if (name && !missing(`${o.path}/${name}/.git`)) return { at: name }
  }
  const gitDir = runGit(o.git, env, o.path, ['rev-parse', '--absolute-git-dir'], READ_TIMEOUT_MS)
  if (!gitDir.ok) return { error: gitDir.message }
  return { at: missing(`${gitDir.stdout.trim()}/modules`) ? null : '' }
}

/**
 * What Discard would delete, and its fingerprint (review of #446). Every file
 * counts (`--untracked-files=all`); edits to an already-changed file and files
 * under an already-untracked folder change the fingerprint, so a discard never
 * forces away work the human was not shown. A nested repository, or a worktree
 * too large to fingerprint, refuses Discard instead of guessing.
 */
function fingerprintOf(o: LaunchWorktree): Fingerprint | { error: string } {
  const env = { ...o.env, GIT_OPTIONAL_LOCKS: '0' }
  const status = runGit(o.git, env, o.path, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], READ_TIMEOUT_MS)
  if (!status.ok) return { error: status.message }
  const entries = status.stdout.split('\0').filter(Boolean)
  const short = (name: string) => (name.length > EXAMPLE_LENGTH ? `${name.slice(0, EXAMPLE_LENGTH - 1)}…` : name)
  const examples = entries.slice(0, 5).map((entry) => short(entry.slice(3)))
  const refuse = (noDiscard: string): Fingerprint => ({ dirty: entries.length, examples, status: '', noDiscard })
  if (entries.length > MAX_FINGERPRINT_FILES) {
    return refuse(`It has more than ${MAX_FINGERPRINT_FILES.toLocaleString('en-US')} changed files, too many for Agent Inbox to check before deleting them; remove it yourself.`)
  }
  // a checked-out submodule shows as one ` M sub` line and a `-dirty` diff line however its files or
  // commits change, and --force would delete its files and its git data (review of #446)
  const submodule = checkedOutSubmodule(o, env)
  if ('error' in submodule) return submodule
  if (submodule.at !== null) {
    const where = submodule.at ? ` at ${short(submodule.at.replace(/\/?$/, '/'))}` : ''
    return refuse(`It contains a checked-out submodule${where}; Remove won’t delete it. Remove the submodule checkout first, or remove the worktree by hand.`)
  }
  const hash = createHash('sha256')
  hash.update(status.stdout).update('\0diff\0')
  // staged and unstaged changes to tracked files, contents included; no external diff or textconv runs
  const diff = spawnSync(o.git, ['-C', o.path, 'diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'], {
    env, cwd: '/', timeout: ADD_TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_DIFF_BYTES,
  })
  if (diff.error && (diff.error as NodeJS.ErrnoException).code === 'ENOBUFS') {
    return refuse('Its changes are too large for Agent Inbox to check before deleting them; remove it yourself.')
  }
  if (diff.error || diff.status !== 0) return { error: 'git diff failed' }
  hash.update(diff.stdout).update('\0untracked\0')
  let budget = HASHED_TOTAL_BYTES
  for (const entry of entries) {
    if (!entry.startsWith('?? ')) continue
    const name = entry.slice(3)
    const full = `${o.path}/${name.replace(/\/$/, '')}`
    let info
    try {
      info = lstatSync(full, { bigint: true })
    } catch {
      return { error: `${name} changed while Agent Inbox read it` }
    }
    // git lists a folder as one untracked entry only when it holds another repository
    if (info.isDirectory()) {
      const folder = short(name.replace(/\/?$/, '/'))
      return refuse(missing(`${full}/.git`)
        ? `It contains a folder git does not list file by file, ${folder}; remove it yourself.`
        : `It contains a nested git repository at ${folder}; move it out first.`)
    }
    hash.update(`${name}\0${info.size}\0${info.mtimeNs}\0`)
    if (info.isSymbolicLink()) {
      try { hash.update(`link:${readlinkSync(full)}`) } catch { return { error: `${name} changed while Agent Inbox read it` } }
    } else if (info.isFile() && info.size <= BigInt(HASHED_FILE_BYTES) && info.size <= BigInt(budget)) {
      try { hashFile(full, hash) } catch { return { error: `${name} changed while Agent Inbox read it` } }
      budget -= Number(info.size)
    }
    hash.update('\0')
  }
  return { dirty: entries.length, examples, status: hash.digest('hex'), noDiscard: null }
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
  const status: Fingerprint | { error: string } = gone ? { dirty: 0, examples: [], status: '', noDiscard: null } : fingerprintOf(o)
  if ('error' in status) return { ok: false, error: status.error }
  const ref = `refs/heads/${o.branch}`
  const baseRef = baseRefOf(o.baseRef)
  const base = baseRef && runGit(o.git, o.env, o.checkout, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`], READ_TIMEOUT_MS).ok ? baseRef : o.baseSha
  const ahead = !isSha(o.baseSha) && base === o.baseSha ? { ok: false, stdout: '' } : runGit(o.git, o.env, o.checkout, ['rev-list', '--count', `${base}..${ref}`], READ_TIMEOUT_MS)
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
    const now = missing(o.path) ? null : fingerprintOf(o)
    if (now && !('error' in now) && now.noDiscard) return { ok: false, error: `Nothing was removed. ${now.noDiscard}` }
    if (!now || 'error' in now || !now.status || now.status !== o.discard) return { ok: false, error: 'The worktree changed since you looked at it, so nothing was removed. Look at it again.' }
  }
  runGit(o.git, o.env, o.checkout, ['worktree', 'unlock', o.path], UNLOCK_TIMEOUT_MS)
  const removed = runGit(o.git, o.env, o.checkout, ['worktree', 'remove', ...(o.discard !== undefined ? ['--force'] : []), o.path], ADD_TIMEOUT_MS)
  return removed.ok ? { ok: true } : { ok: false, error: removed.message }
}

// ── the turn-end summary (#432 §6) ─────────────────────────────────────────────

/** What the worktree holds now, written to the launch row at each turn end, at park and at end. */
export interface WorktreeSummary {
  v: 1
  at: string
  head: string
  /** The branch checked out now (the agent can switch); '' when HEAD is detached. */
  branch: string
  /** Commits on HEAD that the base lacks, and commits on the base that HEAD lacks. */
  ahead: number
  behind: number
  /** Files changed between the base commit and HEAD. */
  files: number
  /** Uncommitted and untracked entries. */
  dirty: number
}

const SUMMARY_TIMEOUT_MS = 10_000

type GitRun = (args: string[]) => Promise<GitResult>

async function summarize(run: GitRun, base: { ref: string | null; sha: string }): Promise<WorktreeSummary | null> {
  if (!isSha(base.sha)) return null
  const head = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  if (!head.ok) return null
  const branch = await run(['branch', '--show-current'])
  // one base for every count: the checkout's branch while it still resolves, else the base commit
  const baseRef = baseRefOf(base.ref)
  const ref = baseRef && (await run(['rev-parse', '--verify', '-q', `${baseRef}^{commit}`])).ok ? baseRef : base.sha
  const counts = await run(['rev-list', '--left-right', '--count', `${ref}...HEAD`])
  const files = await run(['diff', '--name-only', '-z', `${ref}...HEAD`])
  // every file, whatever status.showUntrackedFiles says: the count Remove worktree's dialog shows
  const status = await run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
  if (!branch.ok || !counts.ok || !files.ok || !status.ok) return null
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number)
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null
  const entries = (text: string) => text.split('\0').filter(Boolean).length
  return {
    v: 1, at: new Date().toISOString(), head: head.stdout.trim(), branch: branch.stdout.trim(),
    ahead: ahead!, behind: behind!, files: entries(files.stdout), dirty: entries(status.stdout),
  }
}

// the final summary's whole budget: park and end wait at most this, its git killed past it
const FINAL_SUMMARY_MS = 15_000

/**
 * The driver's summaries of a launch's worktree (§6). `request()` runs git off
 * the driver's event queue (async, one read at a time, a request during a read
 * runs once after it) and hands each summary to `write`; `final()` is awaited
 * at park and at end, while the driver still holds its lease: it drops a queued
 * repeat and gives up within `finalMs` (15 s), killing any git still running.
 * A failed or abandoned read writes nothing, so the last summary stays.
 */
export function worktreeSummarizer(o: {
  git: string
  env: NodeJS.ProcessEnv
  path: string
  baseRef: string | null
  baseSha: string
  write: (summary: WorktreeSummary) => void
  finalMs?: number
}): { request(): void; final(): Promise<void> } {
  const env = { ...o.env, GIT_OPTIONAL_LOCKS: '0' }
  const inflight = new Set<ReturnType<typeof execFile>>()
  let abandoned = false
  const run: GitRun = (args) => new Promise((resolve) => {
    if (abandoned) return resolve({ ok: false, code: null, stdout: '', message: 'abandoned' })
    const child = execFile(o.git, ['-C', o.path, ...args], { env, cwd: '/', encoding: 'utf8', timeout: SUMMARY_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      inflight.delete(child)
      resolve({ ok: !error, code: error ? null : 0, stdout: String(stdout ?? ''), message: error ? 'git failed' : '' })
    })
    inflight.add(child)
  })
  let running: Promise<void> | null = null
  let again = false
  const once = async (): Promise<void> => {
    try {
      const summary = await summarize(run, { ref: o.baseRef, sha: o.baseSha })
      if (summary && !abandoned) o.write(summary)
    } catch { /* a summary never stops the session */ }
  }
  const request = (): void => {
    if (abandoned) return
    if (running) {
      again = true
      return
    }
    running = once().finally(() => {
      running = null
      if (again) {
        again = false
        request()
      }
    })
  }
  return {
    request,
    async final() {
      // the read in flight finishes (or is killed); a repeat it queued is dropped: final() reads once more itself
      again = false
      const timer = setTimeout(() => {
        abandoned = true
        for (const child of inflight) child.kill('SIGKILL')
      }, o.finalMs ?? FINAL_SUMMARY_MS)
      try {
        if (running) await running
        await once()
      } finally {
        clearTimeout(timer)
        abandoned = true
      }
    },
  }
}
