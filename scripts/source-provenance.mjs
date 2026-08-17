import { execFileSync } from 'node:child_process'

export class SourceProvenanceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SourceProvenanceError'
  }
}

export function resolveSourceProvenance(repoRoot, env = process.env) {
  const sourceCommit = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim()
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new SourceProvenanceError('checkout HEAD must be a full 40-character lowercase Git SHA')
  }
  const expectedSourceCommit = env.AGENT_INBOX_RELEASE_SOURCE_SHA ?? env.GITHUB_SHA
  const expectedSourceLabel = env.AGENT_INBOX_RELEASE_SOURCE_SHA === undefined
    ? 'GITHUB_SHA'
    : 'AGENT_INBOX_RELEASE_SOURCE_SHA'
  if (expectedSourceCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(expectedSourceCommit)) {
      throw new SourceProvenanceError(`${expectedSourceLabel} must be a full 40-character lowercase Git SHA`)
    }
    if (expectedSourceCommit !== sourceCommit) {
      throw new SourceProvenanceError(`${expectedSourceLabel} does not match checkout HEAD ${sourceCommit}`)
    }
  }
  const sourceDirty = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().length > 0
  if (expectedSourceCommit && sourceDirty) {
    throw new SourceProvenanceError('CI release build has a dirty source tree')
  }
  return { sourceCommit, sourceDirty }
}
