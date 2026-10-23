import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { join, basename } from 'node:path'
import { realpathSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { makeScope } from '../src/scope.js'
import { scratchDir } from './scratch.js'

// Issue #159 counts REAL git spawns: the spy delegates to the genuine
// execFileSync, so every repo below is still built and read by git itself.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// How many times git ran with exactly these arguments in `cwd`.
function gitSpawns(cwd: string, ...args: string[]): number {
  return vi.mocked(execFileSync).mock.calls.filter(([file, argv, options]) =>
    file === 'git' && JSON.stringify(argv) === JSON.stringify(args) && options?.cwd === cwd).length
}

describe('makeScope', () => {
  it('infers project/stream from cwd and agent from the client name', () => {
    const dir = scratchDir('plain-')
    const scope = makeScope(dir)
    const s = scope.get('claude-code')
    expect(s.project).toBe(basename(dir))
    expect(s.stream).toBe('')
    expect(s.agent).toBe('claude-code')
  })

  it('override replaces project/stream but agent still comes from the client', () => {
    const dir = scratchDir('plain-')
    const scope = makeScope(dir)
    scope.override({ project: 'oris', stream: 'release' })
    const s = scope.get('github-copilot')
    expect(s.project).toBe('oris')
    expect(s.stream).toBe('release')
    expect(s.agent).toBe('copilot')
  })
})

// ── issue #30: the link identity rides along on the same seam ────────────────

function tmpGitRepo(opts: { remote?: string; branch?: string } = {}): string {
  const dir = scratchDir('repo-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir })
  if (opts.branch) execFileSync('git', ['checkout', '-q', '-b', opts.branch], { cwd: dir })
  if (opts.remote) execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir })
  return dir
}

describe('makeScope carries the source link identity (issue #30)', () => {
  it('carries the inferred repo slug and branch-derived issue alongside project/stream', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: '30-source-links' })
    const s = makeScope(dir).get('claude-code')
    expect(s.repo).toBe('shariqh/agent-inbox')
    expect(s.stream).toBe('30-source-links')
    expect(s.issue).toBe(30)
  })

  it('is null-safe outside a git repo — no repo, no issue, and nothing throws', () => {
    const s = makeScope(scratchDir('plain-')).get('claude-code')
    expect(s.repo).toBeNull()
    expect(s.issue).toBeNull()
  })

  it('override replaces repo/issue and survives later gets', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: '30-source-links' })
    const scope = makeScope(dir)
    scope.override({ repo: 'acme/other', issue: 7 })
    expect(scope.get('claude-code').repo).toBe('acme/other')
    expect(scope.get('claude-code').issue).toBe(7)
  })

  // issueFor is the ONE place the override-then-infer precedence lives, so
  // src/mcp.ts never has to import branch-parsing policy from infer.ts
  it('issueFor derives the issue from a per-call branch, but an explicit override still outranks it', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: 'trunk' })
    const scope = makeScope(dir)
    expect(scope.issueFor('feat/41-links')).toBe(41)
    expect(scope.issueFor('trunk')).toBeNull()
    scope.override({ issue: 30 })
    // the escape hatch exists FOR unusual branch names — a per-call stream that
    // parses to a different number must not defeat it
    expect(scope.issueFor('feat/41-links')).toBe(30)
    expect(scope.issueFor('trunk')).toBe(30)
  })

  // issue #157 — the HEAD repository is where the branch is pushed, which a
  // register({ repo }) override of the BASE must not change: a fork contributor
  // registers the upstream as the base and still pushes to their fork.
  it('headFor names the repository a branch is pushed to, independent of the registered base repo', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:me/agent-inbox.git', branch: 'feature' })
    const scope = makeScope(dir)
    scope.override({ repo: 'shariqh/agent-inbox' })
    expect(scope.get('claude-code').repo).toBe('shariqh/agent-inbox')
    expect(scope.headFor('feature')).toBe('me/agent-inbox')
    execFileSync('git', ['remote', 'add', 'fork', 'git@github.com:fork/agent-inbox.git'], { cwd: dir })
    // pushRemote outranks any global remote.pushDefault on the machine running this
    execFileSync('git', ['config', 'branch.feature.pushRemote', 'fork'], { cwd: dir })
    expect(scope.headFor('feature'), 'the push config is re-read, never memoized').toBe('fork/agent-inbox')
  })

  it('headFor is null with no branch or no github remote', () => {
    expect(makeScope(scratchDir('plain-')).headFor('feature')).toBeNull()
    expect(makeScope(tmpGitRepo({ remote: 'git@github.com:me/agent-inbox.git' })).headFor('')).toBeNull()
  })
})

// ── issue #159: a found origin is read once per server process; the branch stays live ──
// One stdio server serves a CLI and all its subagents, and scope.get() runs on
// nearly every tool call — so each blocking git spawn here serializes them all.

describe('makeScope caches a found origin per process but follows the branch (issue #159)', () => {
  const ORIGIN = ['remote', 'get-url', 'origin'] as const
  const BRANCH = ['branch', '--show-current'] as const

  it('N get() calls spawn ONE origin lookup and N branch lookups; project and repo both come from it', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: '159-request-path' })
    const scope = makeScope(dir)
    for (let i = 0; i < 5; i++) {
      expect(scope.get('claude-code')).toMatchObject({
        project: 'agent-inbox', repo: 'shariqh/agent-inbox', stream: '159-request-path', issue: 159,
      })
    }
    expect(gitSpawns(dir, ...ORIGIN)).toBe(1)
    expect(gitSpawns(dir, ...BRANCH)).toBe(5)
  })

  // A missing origin must NOT be pinned: src/hook.ts infers the project live on
  // every hook event, so after `git remote add origin` / `gh repo create` in a
  // new folder (or one transient git failure) a server stuck on the folder name
  // would file work where the Stop-hook watch and prompt nudges never look.
  it('re-reads a missing origin once per call, then picks up and caches one added later', () => {
    const dir = tmpGitRepo()
    const scope = makeScope(dir)
    for (let i = 0; i < 3; i++) expect(scope.get('claude-code')).toMatchObject({ project: basename(dir), repo: null })
    expect(gitSpawns(dir, ...ORIGIN)).toBe(3)

    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:shariqh/shipped-app.git'], { cwd: dir })
    for (let i = 0; i < 3; i++) {
      expect(scope.get('claude-code')).toMatchObject({ project: 'shipped-app', repo: 'shariqh/shipped-app' })
    }
    expect(gitSpawns(dir, ...ORIGIN)).toBe(4)
  })

  it('a branch switch mid-session is reflected on the very next call', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: 'trunk' })
    const scope = makeScope(dir)
    expect(scope.get('claude-code')).toMatchObject({ stream: 'trunk', issue: null })
    execFileSync('git', ['checkout', '-q', '-b', 'feat/41-links'], { cwd: dir })
    expect(scope.get('claude-code')).toMatchObject({ project: 'agent-inbox', stream: 'feat/41-links', issue: 41 })
    expect(gitSpawns(dir, ...ORIGIN)).toBe(1)
    expect(gitSpawns(dir, ...BRANCH)).toBe(2)
  })

  it('register overrides still win, and skip the lookups they replace', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: '30-source-links' })
    const overridden = makeScope(dir)
    overridden.override({ project: 'oris', repo: 'acme/other', stream: 'release' })
    for (let i = 0; i < 3; i++) {
      expect(overridden.get('claude-code')).toMatchObject({ project: 'oris', repo: 'acme/other', stream: 'release' })
    }
    expect(gitSpawns(dir, ...ORIGIN)).toBe(0)
    expect(gitSpawns(dir, ...BRANCH)).toBe(0)

    // an override registered after origin was read still outranks it
    const later = makeScope(dir)
    expect(later.get('claude-code')).toMatchObject({ project: 'agent-inbox', repo: 'shariqh/agent-inbox' })
    later.override({ project: 'renamed' })
    expect(later.get('claude-code')).toMatchObject({ project: 'renamed', repo: 'shariqh/agent-inbox' })
    later.override({ repo: 'acme/other' })
    expect(later.get('claude-code')).toMatchObject({ project: 'renamed', repo: 'acme/other' })
    expect(gitSpawns(dir, ...ORIGIN)).toBe(1)
  })
})


// ── issues #157 × #159: head inference is a LIVE read, and only on writes ──────
// It resolves origin's PUSH url (pushurl, pushInsteadOf), which #159's cached
// fetch url cannot answer, and push config can change mid-session. So get() —
// the path nearly every tool call takes — never runs it, and headFor() never
// borrows the cache: each write pays its own spawns. Issue #183 added the
// branch's upstream ref and its remote to the one for-each-ref read; only an
// upstream git does not map to a remote-tracking ref costs a config read on top.

describe('headFor stays a live, write-only read beside the origin cache (issues #157, #159, #183)', () => {
  const ORIGIN = ['remote', 'get-url', 'origin'] as const
  const refs = (branch: string) => ['for-each-ref', '--format=%(refname)%00%(upstream:remoteref)%00%(upstream:remotename)%00%(push:remotename)', `refs/heads/${branch}`]
  const merge = (branch: string) => ['config', '--get-all', `branch.${branch}.merge`]
  const PUSH_URL = ['remote', 'get-url', '--push', 'origin'] as const
  // hermetic: a global remote.pushDefault names a push remote for every branch
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
  beforeAll(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
  })
  afterAll(() => {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('get() spawns no head lookup; each headFor() spawns exactly its two, leaving the origin cache alone', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: 'feature' })
    const scope = makeScope(dir)
    for (let i = 0; i < 3; i++) scope.get('claude-code')
    expect(gitSpawns(dir, ...refs('feature'))).toBe(0)
    expect(gitSpawns(dir, ...PUSH_URL)).toBe(0)
    for (let i = 0; i < 3; i++) expect(scope.headFor('feature')).toBe('shariqh/agent-inbox')
    expect(gitSpawns(dir, ...refs('feature'))).toBe(3)
    expect(gitSpawns(dir, ...PUSH_URL)).toBe(3)
    expect(gitSpawns(dir, ...merge('feature'))).toBe(0)
    expect(gitSpawns(dir, ...ORIGIN)).toBe(1)
  })

  // the common pushed branch: for-each-ref already names its upstream ref
  it('a tracking branch whose upstream git maps pays no config read', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: 'feature' })
    execFileSync('git', ['config', 'branch.feature.remote', 'origin'], { cwd: dir })
    execFileSync('git', ['config', 'branch.feature.merge', 'refs/heads/feature'], { cwd: dir })
    expect(makeScope(dir).headFor('feature')).toBe('shariqh/agent-inbox')
    expect(gitSpawns(dir, ...refs('feature'))).toBe(1)
    expect(gitSpawns(dir, ...merge('feature'))).toBe(0)
    expect(gitSpawns(dir, ...PUSH_URL)).toBe(1)
  })

  // gh pr checkout of a fork PR without maintainer edits: the unmapped
  // refs/pull/<n>/head upstream costs one config read, and settles the head
  // without resolving any push url
  it('a pull-ref checkout reads its merge ref once and no push url; get() still reads neither', () => {
    const dir = tmpGitRepo({ remote: 'https://github.com/upstream/x.git', branch: 'patch-1' })
    for (const [key, value] of [['remote', 'origin'], ['pushRemote', 'origin'], ['merge', 'refs/pull/7/head']]) {
      execFileSync('git', ['config', `branch.patch-1.${key}`, value!], { cwd: dir })
    }
    const scope = makeScope(dir)
    for (let i = 0; i < 3; i++) expect(scope.get('claude-code')).toMatchObject({ repo: 'upstream/x', stream: 'patch-1' })
    expect(gitSpawns(dir, ...merge('patch-1'))).toBe(0)
    expect(scope.headFor('patch-1')).toBe('refs/pull/7/head')
    expect(gitSpawns(dir, ...refs('patch-1'))).toBe(1)
    expect(gitSpawns(dir, ...merge('patch-1'))).toBe(1)
    expect(gitSpawns(dir, ...PUSH_URL)).toBe(0)
  })
})

// ── issue #324: the repository folder is a LIVE read, and only on writes ───────
// Like the branch it is never cached, because worktrees and checkouts move, and
// like the head repository it costs a git spawn, so get() (nearly every tool
// call, pending() polls included) never pays for it: mcp.ts asks on writes.

describe('rootFor stays a live, write-only read (issue #324)', () => {
  const TOPLEVEL = ['rev-parse', '--show-toplevel'] as const

  it('get() spawns no lookup; each rootFor() spawns exactly one and follows the working tree', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/agent-inbox.git', branch: 'feature' })
    const scope = makeScope(dir)
    for (let i = 0; i < 3; i++) scope.get('claude-code')
    expect(gitSpawns(dir, ...TOPLEVEL)).toBe(0)
    for (let i = 0; i < 3; i++) expect(scope.rootFor()).toBe(realpathSync(dir))
    expect(gitSpawns(dir, ...TOPLEVEL)).toBe(3)

    // the working tree goes away mid-session: the next write finds none, and a
    // restored one is found again, so nothing was memoized either way
    renameSync(join(dir, '.git'), join(dir, '.git-away'))
    expect(scope.rootFor()).toBeNull()
    renameSync(join(dir, '.git-away'), join(dir, '.git'))
    expect(scope.rootFor()).toBe(realpathSync(dir))
    expect(gitSpawns(dir, ...TOPLEVEL)).toBe(5)
  })

  it('is null outside a git repo, and a register() override changes nothing about it', () => {
    const plain = makeScope(scratchDir('plain-'))
    plain.override({ project: 'oris', repo: 'acme/other' })
    expect(plain.rootFor()).toBeNull()
  })
})
