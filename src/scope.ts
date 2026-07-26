import { inferProject, inferStream, inferAgent, inferRepo, inferIssueRef } from './infer.js'

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
  // one lookup here that cannot change under us — memoize it. The BRANCH is
  // deliberately NOT memoized (worktrees, mid-session checkouts), so the issue
  // is re-derived on every read.
  let repoCache: { value: string | null } | undefined
  const repo = (): string | null => {
    if (repoOverride !== undefined) return repoOverride
    if (repoCache === undefined) repoCache = { value: inferRepo(cwd) }
    return repoCache.value
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
        project: projectOverride ?? inferProject(cwd),
        stream,
        agent: inferAgent(clientName),
        repo: repo(),
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
