export class WindowsRoundTripVerificationError extends Error {}
export type WindowsRoundTripEvidence = {
  schema: 1
  key: 'win32-x64'
  packageVersion: string
  appTreeDigest: string
  runtimeManifestDigest: string
  runtimeId: string
  runtimePayloadDigest: string
  runtimeSourceCommit: string
  nodeVersion: string
  nodeModulesAbi: string
  nativeAddonSelftests: 'passed'
  setupAvailable: false
}
export function verifyWindowsRoundTrip(options: {
  originalApp: string
  restoredApp: string
  originalRuntime: string
  restoredRuntime: string
  originalAppReport: string
  restoredAppReport: string
  originalRuntimeReport: string
  restoredRuntimeReport: string
  sourceCommit: string
  packageVersion: string
  nodeVersion: string
  nodeModulesAbi: string
}): WindowsRoundTripEvidence
