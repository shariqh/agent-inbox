import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inferProject, inferStream, inferAgent, remoteUrl, parseRepoSlug, inferRepo, inferIssueRef } from '../src/infer.js'

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

describe('inferProject', () => {
  it('uses the git remote origin basename', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/social-agent.git' })
    expect(inferProject(dir)).toBe('social-agent')
  })
  it('falls back to cwd basename with no remote', () => {
    const dir = tmpGitRepo()
    expect(inferProject(dir)).toBe(basename(dir))
  })
  it('falls back to cwd basename outside any git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferProject(dir)).toBe(basename(dir))
  })
})

describe('inferStream', () => {
  it('returns the current branch', () => {
    const dir = tmpGitRepo({ branch: 'feat/x' })
    expect(inferStream(dir)).toBe('feat/x')
  })
  it('returns empty string outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferStream(dir)).toBe('')
  })
})

describe('inferAgent', () => {
  it('maps claude client names', () => {
    expect(inferAgent('claude-code')).toBe('claude-code')
    expect(inferAgent('Claude Code')).toBe('claude-code')
  })
  it('maps copilot client names', () => {
    expect(inferAgent('github-copilot-cli')).toBe('copilot')
  })
  it('passes through an unknown name, and defaults when absent', () => {
    expect(inferAgent('aider')).toBe('aider')
    expect(inferAgent(undefined)).toBe('unknown')
    expect(inferAgent('')).toBe('unknown')
  })
})

// ── issue #30: the source link identity, inferred locally at write time ──────
// Everything here returns null rather than throwing: a flag must never be lost
// because a repo has no remote, sits on a detached HEAD, or lives on GitLab.

describe('remoteUrl', () => {
  it('reads origin from a real temp repo, and returns null when there is none', () => {
    expect(remoteUrl(tmpGitRepo({ remote: 'git@github.com:shariqh/social-agent.git' })))
      .toBe('git@github.com:shariqh/social-agent.git')
    expect(remoteUrl(tmpGitRepo())).toBeNull()
    expect(remoteUrl(mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull()
  })
})

describe('parseRepoSlug', () => {
  it('reads owner/name from ssh, https and ssh:// github remotes', () => {
    expect(parseRepoSlug('git@github.com:shariqh/social-agent.git')).toBe('shariqh/social-agent')
    expect(parseRepoSlug('https://github.com/shariqh/agent-inbox')).toBe('shariqh/agent-inbox')
    expect(parseRepoSlug('https://github.com/shariqh/agent-inbox.git')).toBe('shariqh/agent-inbox')
    expect(parseRepoSlug('ssh://git@github.com/shariqh/agent-inbox.git')).toBe('shariqh/agent-inbox')
    expect(parseRepoSlug('https://github.com/shariqh/agent-inbox/')).toBe('shariqh/agent-inbox')
  })

  // the null IS the GitLab / Enterprise / Bitbucket seam — a non-github repo
  // renders exactly as it does today (nothing), it does not render a broken link
  it('returns null for a non-github host, so GitLab/Enterprise simply render as today', () => {
    expect(parseRepoSlug('git@gitlab.com:acme/thing.git')).toBeNull()
    expect(parseRepoSlug('https://bitbucket.org/acme/thing.git')).toBeNull()
    expect(parseRepoSlug('git@github.acme-corp.com:acme/thing.git')).toBeNull()
    expect(parseRepoSlug('https://evil.com/github.com/a/b')).toBeNull()
  })

  // remoteUrl returns string | null; parseRepoSlug has to accept that directly
  it('accepts null/garbage without throwing', () => {
    expect(parseRepoSlug(null)).toBeNull()
    expect(parseRepoSlug('')).toBeNull()
    expect(parseRepoSlug('   ')).toBeNull()
    expect(parseRepoSlug('not a url at all')).toBeNull()
    expect(parseRepoSlug('https://github.com/onlyowner')).toBeNull()
  })
})

describe('inferRepo', () => {
  it('uses the git remote origin of a real temp repo', () => {
    expect(inferRepo(tmpGitRepo({ remote: 'git@github.com:shariqh/social-agent.git' }))).toBe('shariqh/social-agent')
  })
  it('returns null with no remote, and outside any git repo', () => {
    expect(inferRepo(tmpGitRepo())).toBeNull()
    expect(inferRepo(mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull()
  })
})

describe('inferIssueRef', () => {
  // The CONSERVATIVE rule: a link to the WRONG issue is worse than no link, so
  // a number only counts when a `/`-separated segment is essentially only that
  // number (optionally with an issue/gh prefix and a slug suffix).
  const yes: Array<[string, number]> = [
    ['30-source-links', 30],
    ['feat/30-links', 30],
    ['fix/issue-30', 30],
    ['issues/30', 30],
    ['gh-30', 30],
    ['gh30', 30],
    ['30', 30],
    ['30_source_links', 30],
    ['issue_7', 7],
    ['shariq/issue-30/retry', 30],
  ]
  const no = ['main', 'agent-inbox-2026', 'v2-api', 'release/2.1', 'feat/x', '', 'feat/post-rebuild-backlog', '0', '0-nothing', '1234567', 'sprint-2026-q3']

  it('reads the issue number out of a conventional branch name', () => {
    for (const [branch, n] of yes) expect(inferIssueRef(branch), branch).toBe(n)
  })

  // the null cases are the point of this test
  it('refuses anything that is not unambiguously an issue number', () => {
    for (const branch of no) expect(inferIssueRef(branch), branch).toBeNull()
  })
})
