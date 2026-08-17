export function assertRuntimeSourceCommit<T extends { sourceCommit?: string | null }>(
  manifest: T,
  expectedCommit: string,
  label: string,
): T
