export class UnsafeTreeModeError extends Error {}
export function assertSafeTreeModes(
  root: string,
  options?: { label?: string; privileged?: Record<string, number[]> },
): void
