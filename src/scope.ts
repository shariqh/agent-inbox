import { remoteUrl, inferProject, inferStream, inferAgent, inferRepo, inferIssueRef } from './infer.js'

export interface Scope {
  project: string
  stream: string
  agent: string
  // issue #30 — the source-link identity. Both null whenever the answer is not
  // unambiguous (no origin, a non-github remote, a branch that carries no issue
  // number); nothing downstream renders for a null.
  repo: string | null
  issue: number | null
}

export function makeScope(cwd: string): {
  get(clientName: string | undefined): Scope
  issueFor(branch: string): number | null
  override(patch: { project?: string; stream?: string; repo?: string; issue?: number }): void
} {
  let projectOverride: string | undefined
  let streamOverride: string | undefined
  let repoOverride: string | undefined
  let issueOverride: number | undefined
  // the cwd of a stdio session never changes, and `git remote get-url` is the
  // one lookup here that cannot change under us — so it runs at most ONCE per
  // server process, and both project and repo are derived from that one answer
  // (a missing origin is remembered too). Issue #159: re-reading it blocked
  // nearly every tool call on a subprocess, serializing a CLI and all of its
  // subagents. The BRANCH is deliberately NOT memoized (worktrees, mid-session
  // checkouts), so the stream and its issue are re-derived on every read — and
  // the scope as a whole is never cached: the client name arrives lazily.
  let originCache: { value: string | null } | undefined
  const origin = (): string | null => {
    if (originCache === undefined) originCache = { value: remoteUrl(cwd) }
    return originCache.value
  }
  // The ONE place the override-then-infer precedence for `issue` lives. mcp.ts
  // calls this with the branch a flag was actually raised on (its per-call
  // `stream` override, or the session's), so branch-parsing policy never leaks
  // out of this seam — and an explicit register({ issue }) still outranks the
  // heuristic, which is the whole point of the escape hatch.
  const issueFor = (branch: string): number | null =>
    issueOverride !== undefined ? issueOverride : inferIssueRef(branch)
  return {
    get(clientName) {
      const stream = streamOverride ?? inferStream(cwd)
      return {
        project: projectOverride ?? inferProject(cwd, origin()),
        stream,
        agent: inferAgent(clientName),
        repo: repoOverride ?? inferRepo(cwd, origin()),
        issue: issueFor(stream),
      }
    },
    issueFor,
    override(patch) {
      if (patch.project !== undefined) projectOverride = patch.project
      if (patch.stream !== undefined) streamOverride = patch.stream
      if (patch.repo !== undefined) repoOverride = patch.repo
      if (patch.issue !== undefined) issueOverride = patch.issue
    },
  }
}
