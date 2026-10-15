import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeScope } from '../src/scope.js'

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
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    const scope = makeScope(dir)
    const s = scope.get('claude-code')
    expect(s.project).toBe(basename(dir))
    expect(s.stream).toBe('')
    expect(s.agent).toBe('claude-code')
  })

  it('override replaces project/stream but agent still comes from the client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'repo-'))
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
    const s = makeScope(mkdtempSync(join(tmpdir(), 'plain-'))).get('claude-code')
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

