export class SourceProvenanceError extends Error {}
export function resolveSourceProvenance(
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): { sourceCommit: string; sourceDirty: boolean }
