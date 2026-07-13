import { inferProject, inferStream, inferAgent } from './infer.js'

export interface Scope {
  project: string
  stream: string
  agent: string
}

export function makeScope(cwd: string): {
  get(clientName: string | undefined): Scope
  override(patch: { project?: string; stream?: string }): void
} {
  let projectOverride: string | undefined
  let streamOverride: string | undefined
  return {
    get(clientName) {
      return {
        project: projectOverride ?? inferProject(cwd),
        stream: streamOverride ?? inferStream(cwd),
        agent: inferAgent(clientName),
      }
    },
    override(patch) {
      if (patch.project !== undefined) projectOverride = patch.project
      if (patch.stream !== undefined) streamOverride = patch.stream
    },
  }
}
