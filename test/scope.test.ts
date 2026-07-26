import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeScope } from '../src/scope.js'

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

