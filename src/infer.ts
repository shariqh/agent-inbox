import { execFileSync } from 'node:child_process'
import { basename, isAbsolute } from 'node:path'

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

// `remote` is an origin the caller has ALREADY read: src/scope.ts reads it at
// most once per call, keeps a found one for the MCP server process's life, and
// derives both project and repo from it (issue #159). Omitted, it is read here.
// Only `undefined` triggers that read — an explicit null means "no origin" and
// is not looked up again.
export function inferProject(cwd: string, remote: string | null = remoteUrl(cwd)): string {
  if (remote) {
    const name = basename(remote.replace(/\.git$/, ''))
    if (name) return name
  }
  return basename(cwd) || 'unknown'
}

export function inferStream(cwd: string): string {
  return git(cwd, ['branch', '--show-current']) ?? ''
}

// ── issue #324: the repository folder repo-relative paths resolve against ────
//
// The top of the working tree the session runs in, as git reports it (symlinks
// resolved), so the viewer can open `docs/spec.md` or `public/app.js:7491` from
// an item this session wrote. Read live, never cached: worktrees and checkouts
// move. Null on any failure — no git, outside a repository, inside `.git` with
// no working tree — and for anything that is not one plain absolute path, so an
// item still inserts exactly as it would without it.
const ROOT_CONTROL = /[\u0000-\u001f\u007f]/
const MAX_ROOT_LENGTH = 4096

export function inferRepoRoot(cwd: string): string | null {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!root || root.length > MAX_ROOT_LENGTH || ROOT_CONTROL.test(root) || !isAbsolute(root)) return null
  return root
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

// `remote` follows inferProject's rule: a pre-read origin, or read here.
export function inferRepo(cwd: string, remote: string | null = remoteUrl(cwd)): string | null {
  return parseRepoSlug(remote)
}

// ── issue #157: the HEAD repository, i.e. where this branch is pushed ────────
//
// `repo` above is the BASE: where a PR for this work is searched for. GitHub's
// branch filter matches the head branch NAME in every fork, so the viewer must
// also know which repository the branch lives in to tell this branch's PR from a
// stranger's same-named one. Git already answers that locally: the remote
// `git push` would use for the branch. Read per write (the push config can
// change mid-session), never per call.

// One for-each-ref read answers three questions about exactly this branch. Its
// PUSH remote, by git's own precedence: branch.<name>.pushRemote, then
// remote.pushDefault, then branch.<name>.remote (the tracking remote). Each may
// hold a remote NAME or a URL; empty when none is configured, so the caller falls
// back to origin, which is git's default too. And its UPSTREAM ref on its
// tracking remote (branch.<name>.merge) with that remote's name, both of which
// git reports only when a fetch refspec maps the ref to a remote-tracking ref,
// as it does for an ordinary tracking branch. for-each-ref takes a PATTERN that
// also matches below a `/`, so only an exact refname line counts. NUL separates
// the fields: a URL may hold a space.
interface BranchRefs {
  upstream: string
  upstreamRemote: string
  push: string
}

function branchRefs(cwd: string, branch: string): BranchRefs | null {
  const ref = `refs/heads/${branch}`
  const format = '--format=%(refname)%00%(upstream:remoteref)%00%(upstream:remotename)%00%(push:remotename)'
  const out = git(cwd, ['for-each-ref', format, ref])
  for (const line of out?.split('\n') ?? []) {
    const [name, upstream = '', upstreamRemote = '', push = ''] = line.split('\0')
    if (name === ref) return { upstream: upstream.trim(), upstreamRemote: upstreamRemote.trim(), push: push.trim() }
  }
  return null
}

// Issue #183. For a fork PR whose author did not allow maintainer edits,
// `gh pr checkout` tracks the PR's head ref in the BASE repository: merge is
// refs/pull/<n>/head, and remote and pushRemote name the base, because nothing
// names the fork (cli/cli pkg/cmd/pr/checkout, cmdsForMissingRemote). The push
// destination is then the base, whose own same-named branch may have a PR that
// would verify. Under the default refspec git maps refs/pull/* to no
// remote-tracking ref, and a URL-valued remote maps nothing, so for-each-ref
// reports no upstream: only then, and only when a remote is configured at all (a
// merge ref means nothing without one), is the config itself read. Its first
// value is the one git tracks.
const PULL_REF = /^refs\/pull\/\d+\/(?:head|merge)$/

function upstreamRef(cwd: string, branch: string, refs: BranchRefs): string {
  if (refs.upstream || !refs.push) return refs.upstream
  return git(cwd, ['config', '--get-all', `branch.${branch}.merge`])?.split('\n')[0]?.trim() ?? ''
}

// A pull ref names the head only while the branch pushes back to the remote it
// tracks. Every gh shape does: gh writes pushRemote = remote, and an unmapped
// upstream reports no tracking remote at all. Work stacked on a PR's ref and
// pushed elsewhere (remote.pushDefault = the user's fork) is that remote's
// branch, and its PR is verified as any other.
function tracksPullRef(upstream: string, refs: BranchRefs | null): boolean {
  return PULL_REF.test(upstream) && (!refs?.upstreamRemote || refs.upstreamRemote === refs.push)
}

// The repository `git push <remote>` sends to: a configured remote's first PUSH
// url (its pushurl, else its url, with insteadOf/pushInsteadOf applied). Git also
// takes a URL in place of a remote name — `gh pr checkout` writes one for a fork
// with no local remote, and so does `git push -u <url>` — and that is no
// configured remote, so the value is read as the URL it is. A plain name cannot
// parse as one: it has no `:`.
function pushRepo(cwd: string, remote: string): string | null {
  return parseRepoSlug(git(cwd, ['remote', 'get-url', '--push', remote])?.split('\n')[0] || remote)
}

// `owner/name` of the github.com repository this branch is pushed to: its push
// destination's when that is on github.com, else origin's push url (origin is
// git's default push target). Null when neither is on github.com. A branch that
// tracks a pull request's ref and pushes back where it fetches from is the
// exception (#183): it is reported as that ref, `refs/pull/<n>/head`, which
// names no repository, so no listed PR can verify against it and none is
// linked. A wrong link is worse than no link.
//
// Spawns, on writes only: one for-each-ref; one config read only when the branch
// has a push remote but no upstream git maps; one push-url read unless the
// branch tracks a pull ref, and a second for origin when the push destination is
// not on github.com. An ordinary branch therefore still costs two.
export function inferHeadRepo(cwd: string, branch: string): string | null {
  if (!branch) return null
  const refs = branchRefs(cwd, branch)
  const upstream = refs ? upstreamRef(cwd, branch, refs) : ''
  if (tracksPullRef(upstream, refs)) return upstream
  const remote = refs?.push && !refs.push.startsWith('-') ? refs.push : 'origin'
  return pushRepo(cwd, remote) ?? (remote === 'origin' ? null : pushRepo(cwd, 'origin'))
}

// The CONSERVATIVE branch→issue heuristic. A link to the WRONG issue in the
// right repo is worse than no link at all, so a number only counts when a whole
// `/`-separated segment is essentially just that number:
//   30-source-links · feat/30-links · fix/issue-30 · issues/30 · gh-30 · gh30
// and deliberately NOT: agent-inbox-2026 (trailing year), v2-api, release/2.1,
// a segment that starts with a complete date (2026-10-14-review is not #2026,
// issue #157), or 0. `gh pr list`'s closingIssuesReferences overrides this the
// moment a PR exists, and `register({ issue })` is the manual escape hatch.
const ISSUE_BARE = /^(\d{1,6})(?:[-_].*)?$/
const ISSUE_PREFIXED = /^(?:issue|issues|gh)[-_]?#?(\d{1,6})(?:[-_].*)?$/i
const LEADING_DATE = /^\d{4}[-_]\d{2}[-_]\d{2}(?:$|[-_])/

export function inferIssueRef(branch: string | null | undefined): number | null {
  if (!branch) return null
  for (const segment of branch.split('/')) {
    if (LEADING_DATE.test(segment)) continue
    const m = ISSUE_BARE.exec(segment) ?? ISSUE_PREFIXED.exec(segment)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}
