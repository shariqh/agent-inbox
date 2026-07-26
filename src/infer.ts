import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The origin URL, or null. Extracted so inferProject and inferRepo (issue #30)
// share ONE git lookup instead of drifting apart on how origin is read.
export function remoteUrl(cwd: string): string | null {
  return git(cwd, ['remote', 'get-url', 'origin']) || null
}

export function inferProject(cwd: string): string {
  const remote = remoteUrl(cwd)
  if (remote) {
    const name = basename(remote.replace(/\.git$/, ''))
    if (name) return name
  }
  return basename(cwd) || 'unknown'
}

export function inferStream(cwd: string): string {
  return git(cwd, ['branch', '--show-current']) ?? ''
}

export function inferAgent(clientName: string | undefined): string {
  if (!clientName) return 'unknown'
  const lower = clientName.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('copilot')) return 'copilot'
  return clientName
}

// ── issue #30: the source-link identity (repo slug + issue number) ───────────
//
// Both of these are LOCAL, git-only inferences made at write time by the stdio
// MCP server. No network, no `gh`, no model call — the live PR state is the
// viewer process's job (src/prstate.ts). Every function here returns null on
// any failure: a flag must insert exactly as it does today when the repo has no
// remote, sits on a detached HEAD, or is not on GitHub.

// `owner/name` for a github.com remote, null for anything else. The null is the
// deliberate GitLab / Bitbucket / GitHub-Enterprise seam: v1 renders nothing at
// all for those rather than a link that goes somewhere wrong.
//
// Takes `string | null` on purpose — remoteUrl() returns exactly that, so the
// composition below needs no guard at the call site.
export function parseRepoSlug(url: string | null): string | null {
  if (!url) return null
  const raw = url.trim()
  if (!raw) return null
  // scp-style (git@github.com:owner/name.git) is not a URL, so match it first
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(raw)
  let host: string
  let path: string
  if (scp && !raw.includes('://')) {
    host = scp[1]!
    path = scp[2]!
  } else {
    try {
      const u = new URL(raw)
      host = u.hostname
      path = u.pathname
    } catch {
      return null
    }
  }
  if (host.toLowerCase() !== 'github.com') return null
  const parts = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!owner || !name) return null
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return `${owner}/${name}`
}

export function inferRepo(cwd: string): string | null {
  return parseRepoSlug(remoteUrl(cwd))
}

// The CONSERVATIVE branch→issue heuristic. A link to the WRONG issue in the
// right repo is worse than no link at all, so a number only counts when a whole
// `/`-separated segment is essentially just that number:
//   30-source-links · feat/30-links · fix/issue-30 · issues/30 · gh-30 · gh30
// and deliberately NOT: agent-inbox-2026 (trailing year), v2-api, release/2.1,
// or 0. `gh pr list`'s closingIssuesReferences overrides this the moment a PR
// exists, and `register({ issue })` is the manual escape hatch.
const ISSUE_BARE = /^(\d{1,6})(?:[-_].*)?$/
const ISSUE_PREFIXED = /^(?:issue|issues|gh)[-_]?#?(\d{1,6})(?:[-_].*)?$/i

export function inferIssueRef(branch: string | null | undefined): number | null {
  if (!branch) return null
  for (const segment of branch.split('/')) {
    const m = ISSUE_BARE.exec(segment) ?? ISSUE_PREFIXED.exec(segment)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}
