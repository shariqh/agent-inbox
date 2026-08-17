export const UNIVERSAL_RUNTIME_GLOB: string
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
export function verifyThinReports(options: {
  arm64App: string
  x64App: string
  arm64Report: string
  x64Report: string
  packageVersion: string
  inputs: unknown
  provenance: { sourceCommit: string; sourceDirty: boolean }
  mode: 'adhoc' | 'developer-id'
}): Record<'arm64' | 'x64', Record<string, unknown>>
