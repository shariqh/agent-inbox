export class PruneNodeModulesError extends Error {}
export function isLicenseFile(name: string): boolean
export function pruneNodeModules(root: string): { removedFiles: number; removedBytes: number }
export function assertPrunedNodeModules(root: string, label: string): void
