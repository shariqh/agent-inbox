export class MacReleaseError extends Error {}
export function assertPublishedEntries(directory: string, expectedNames: string[]): string[]
export function releaseDisposition(mode: string): {
  notaryEligible: boolean
  validationEvidenceOnly: boolean
  layer3Required: string[]
}
export function validateSigningOptions(options: {
  mode?: string
  identity?: string
  keychain?: string
}): {
  mode: 'adhoc' | 'developer-id'
  identity: string
  keychain?: string
}
export function verifyThinReport(options: {
  arm64App: string
  arm64Report: string
  packageVersion: string
  inputs: unknown
  provenance: { sourceCommit: string; sourceDirty: boolean }
  mode: 'adhoc' | 'developer-id'
}): Record<string, unknown>
/**
 * Every Electron Mach-O of the assembled app has exactly the expected CPU types
 * (macosArchitectures) and every runtime Mach-O exactly its own runtime's.
 */
export function verifyMachOArchitectures(
  app: string,
  appResources: string,
  inputs: {
    macosArchitectures: readonly string[]
    node: { distributions: Record<string, { arch: string }> }
  },
): {
  app: Array<{ path: string; architectures: string[] }>
  runtime: Array<{ path: string; architectures: string[] }>
}
export const RUNTIME_MACHO_FILES: readonly string[]
export function signPortableRuntime(options: {
  runtimeRoot: string
  signing: { mode: 'adhoc' | 'developer-id'; identity: string; keychain?: string }
  entitlementsRoot: string
}): string[]
