import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { inferProject, inferStream, inferAgent, remoteUrl, parseRepoSlug, inferRepo, inferIssueRef, inferHeadRepo } from '../src/infer.js'

const REPO_ROOT = new URL('..', import.meta.url).pathname

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

  // issue #157 — a leading COMPLETE date is a date, not issue #2026
  it('never reads a segment that starts with a complete YYYY-MM-DD date as an issue', () => {
    for (const branch of ['2026-10-14-review', 'feat/2026-10-14-cleanup', '2026-10-14', '2026_10_14_notes', 'hotfix/2026-01-02']) {
      expect(inferIssueRef(branch), branch).toBeNull()
    }
  })

  it('still reads a four-digit issue number that is not the start of a date', () => {
    expect(inferIssueRef('feat/2026-cleanup')).toBe(2026)
    expect(inferIssueRef('issue-2026')).toBe(2026)
    // the date segment is skipped, not the whole branch
    expect(inferIssueRef('2026-10-14/30-retry')).toBe(30)
  })
})

// ── issue #157: the repository a branch is PUSHED to ─────────────────────────
// `gh pr list --head <branch>` matches the head branch NAME in every fork, so a
// PR is only this branch's PR when its head repository is where the branch goes.

describe('inferHeadRepo', () => {
  const UPSTREAM = 'git@github.com:shariqh/agent-inbox.git'
  const FORK = 'https://github.com/me/agent-inbox.git'
  // Hermetic: a developer's GLOBAL remote.pushDefault would outrank the
  // per-branch config these tests write, exactly as git itself ranks it.
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
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  const withFork = (branch = 'feature') => {
    const dir = tmpGitRepo({ remote: UPSTREAM, branch })
    git(dir, 'remote', 'add', 'fork', FORK)
    return dir
  }

  it('falls back to origin when the branch has no push remote configured', () => {
    expect(inferHeadRepo(withFork(), 'feature')).toBe('shariqh/agent-inbox')
  })

  it("follows the branch's tracking remote", () => {
    const dir = withFork()
    git(dir, 'config', 'branch.feature.remote', 'fork')
    git(dir, 'config', 'branch.feature.merge', 'refs/heads/feature')
    expect(inferHeadRepo(dir, 'feature')).toBe('me/agent-inbox')
  })

  // a triangular workflow pulls from upstream and pushes to the fork; the PR's
  // head is where the branch is PUSHED, by git's own precedence
  it('prefers the push remote (branch.<name>.pushRemote, then remote.pushDefault) over the tracking remote', () => {
    const dir = withFork()
    git(dir, 'config', 'branch.feature.remote', 'origin')
    git(dir, 'config', 'remote.pushDefault', 'fork')
    expect(inferHeadRepo(dir, 'feature')).toBe('me/agent-inbox')
    git(dir, 'remote', 'add', 'other', 'git@github.com:other/agent-inbox.git')
    git(dir, 'config', 'branch.feature.pushRemote', 'other')
    expect(inferHeadRepo(dir, 'feature')).toBe('other/agent-inbox')
  })

  it('reads the named branch, not whatever happens to be checked out', () => {
    const dir = withFork('trunk')
    git(dir, 'branch', 'feature')
    git(dir, 'config', 'branch.feature.remote', 'fork')
    expect(inferHeadRepo(dir, 'feature')).toBe('me/agent-inbox')
    expect(inferHeadRepo(dir, 'trunk')).toBe('shariqh/agent-inbox')
  })

  // for-each-ref matches a pattern up to a `/`: a branch that does not exist must
  // not borrow the push remote of a real branch it happens to be a prefix of
  it('never borrows the push remote of a different branch', () => {
    const dir = withFork('trunk')
    git(dir, 'branch', 'feat/x')
    git(dir, 'config', 'branch.feat/x.remote', 'fork')
    expect(inferHeadRepo(dir, 'feat')).toBe('shariqh/agent-inbox')
    expect(inferHeadRepo(dir, 'feat/*')).toBe('shariqh/agent-inbox')
  })

  it('falls back to origin when the push remote is not on github, and is null with no github remote at all', () => {
    const dir = withFork()
    git(dir, 'remote', 'add', 'lab', 'git@gitlab.com:me/agent-inbox.git')
    git(dir, 'config', 'branch.feature.remote', 'lab')
    expect(inferHeadRepo(dir, 'feature')).toBe('shariqh/agent-inbox')
    expect(inferHeadRepo(tmpGitRepo({ branch: 'feature' }), 'feature')).toBeNull()
    expect(inferHeadRepo(mkdtempSync(join(tmpdir(), 'plain-')), 'feature')).toBeNull()
    expect(inferHeadRepo(dir, '')).toBeNull()
  })

  // Git takes a URL wherever a remote NAME goes. `gh pr checkout` writes one into
  // branch.<name>.remote AND .pushRemote for a fork PR with no local fork remote
  // (cli/cli cmdsForMissingRemote), and `git push -u <url>` writes one too. Such a
  // value is no configured remote, so it is read as the URL it is — falling back
  // to origin here is what picked the base repo's same-named PR instead.
  const URL_VALUED: Array<[string, Array<[string, string]>]> = [
    ['gh pr checkout, https', [
      ['branch.patch-1.remote', 'https://github.com/contributor/x.git'],
      ['branch.patch-1.pushRemote', 'https://github.com/contributor/x.git'],
      ['branch.patch-1.merge', 'refs/heads/patch-1'],
    ]],
    ['gh pr checkout, ssh', [
      ['branch.patch-1.remote', 'git@github.com:contributor/x.git'],
      ['branch.patch-1.pushRemote', 'git@github.com:contributor/x.git'],
      ['branch.patch-1.merge', 'refs/heads/patch-1'],
    ]],
    ['git push -u <url>', [
      ['branch.patch-1.remote', 'https://github.com/contributor/x'],
      ['branch.patch-1.merge', 'refs/heads/patch-1'],
    ]],
    ['remote.pushDefault', [['remote.pushDefault', 'git@github.com:contributor/x.git']]],
  ]
  it.each(URL_VALUED)('reads a push destination written as a URL (%s)', (_how, config) => {
    const dir = tmpGitRepo({ remote: 'https://github.com/upstream/x.git', branch: 'patch-1' })
    for (const [key, value] of config) git(dir, 'config', key, value)
    expect(inferHeadRepo(dir, 'patch-1')).toBe('contributor/x')
  })

  it('never mistakes a plain name that is no configured remote for a URL', () => {
    const dir = tmpGitRepo({ remote: 'https://github.com/upstream/x.git', branch: 'patch-1' })
    git(dir, 'config', 'branch.patch-1.remote', 'fork')
    expect(inferHeadRepo(dir, 'patch-1')).toBe('upstream/x')
  })

  // `git push` sends to a remote's pushurl when it has one — origin included
  const PUSHURL: Array<[string, Array<[string, string]>, string]> = [
    ['origin, with no push config', [], 'me/x'],
    ['origin, named as the tracking remote', [['branch.feature.remote', 'origin']], 'me/x'],
    ['another remote', [['branch.feature.remote', 'fork']], 'fork-push/x'],
  ]
  it.each(PUSHURL)("follows a remote's pushurl (%s)", (_which, config, expected) => {
    const dir = tmpGitRepo({ remote: 'https://github.com/upstream/x.git', branch: 'feature' })
    git(dir, 'config', 'remote.origin.pushurl', 'git@github.com:me/x.git')
    git(dir, 'remote', 'add', 'fork', 'https://github.com/fork/x.git')
    git(dir, 'config', 'remote.fork.pushurl', 'https://github.com/fork-push/x.git')
    for (const [key, value] of config) git(dir, 'config', key, value)
    expect(inferHeadRepo(dir, 'feature')).toBe(expected)
  })

  // the stdio MCP server speaks its protocol on stdout: git's answer has to be
  // CAPTURED, never inherited. Run in a child whose stdout we can inspect whole.
  it("keeps git's output off the caller's stdout", () => {
    const dir = withFork()
    git(dir, 'config', 'branch.feature.remote', 'fork')
    const script = `import { inferHeadRepo } from ${JSON.stringify(join(REPO_ROOT, 'src/infer.ts'))}
      console.error(JSON.stringify(inferHeadRepo(${JSON.stringify(dir)}, 'feature')))`
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr.trim().split('\n').at(-1)).toBe('"me/agent-inbox"')
  })
})
