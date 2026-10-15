import { remoteUrl, inferProject, inferStream, inferAgent, inferRepo, inferIssueRef, inferHeadRepo } from './infer.js'

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
  headFor(branch: string): string | null
  override(patch: { project?: string; stream?: string; repo?: string; issue?: number }): void
} {
  let projectOverride: string | undefined
  let streamOverride: string | undefined
  let repoOverride: string | undefined
  let issueOverride: number | undefined
  // the cwd of a stdio session never changes, so once `git remote get-url origin`
  // FINDS an origin it is reused for the life of the server process, and both
  // project and repo are derived from it. Issue #159: re-reading it blocked
  // nearly every tool call on a subprocess, serializing a CLI and all of its
  // subagents; the accepted cost is that a later `git remote set-url` is not
  // followed. A MISSING origin is never cached: src/hook.ts infers the project
  // live on every hook event, so after a `git remote add origin` (or one
  // transient git failure) the server has to follow, or it files work where the
  // Stop-hook watch never looks. The BRANCH is deliberately NOT memoized
  // (worktrees, mid-session checkouts), so the stream and its issue are
  // re-derived on every read — and the scope as a whole is never cached: the
  // client name arrives lazily.
  let originCache: string | undefined
  const origin = (): string | null => {
    if (originCache === undefined) originCache = remoteUrl(cwd) ?? undefined
    return originCache ?? null
  }
  // The ONE place the override-then-infer precedence for `issue` lives. mcp.ts
  // calls this with the branch a flag was actually raised on (its per-call
  // `stream` override, or the session's), so branch-parsing policy never leaks
  // out of this seam — and an explicit register({ issue }) still outranks the
  // heuristic, which is the whole point of the escape hatch.
  const issueFor = (branch: string): number | null =>
    issueOverride !== undefined ? issueOverride : inferIssueRef(branch)
  // issue #157 — the repository the branch is PUSHED to, which a PR must come
  // from to be this branch's PR. Deliberately not part of get(): it costs git
  // calls, so mcp.ts asks only when it writes. And deliberately independent of
  // register({ repo }), which overrides the BASE: a fork contributor registers
  // the upstream and still pushes to their own fork.
  const headFor = (branch: string): string | null => inferHeadRepo(cwd, branch)
  return {
    get(clientName) {
      const stream = streamOverride ?? inferStream(cwd)
      // at most one origin read per call (a missing one is re-read), and none
      // when both values it feeds are overridden
      const remote = projectOverride === undefined || repoOverride === undefined ? origin() : null
      return {
        project: projectOverride ?? inferProject(cwd, remote),
        stream,
        agent: inferAgent(clientName),
        repo: repoOverride ?? inferRepo(cwd, remote),
        issue: issueFor(stream),
      }
    },
    issueFor,
    headFor,
    override(patch) {
      if (patch.project !== undefined) projectOverride = patch.project
      if (patch.stream !== undefined) streamOverride = patch.stream
      if (patch.repo !== undefined) repoOverride = patch.repo
      if (patch.issue !== undefined) issueOverride = patch.issue
    },
  }
}
