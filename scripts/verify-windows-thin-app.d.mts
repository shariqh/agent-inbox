export class WindowsThinVerificationError extends Error {}
export const WINDOWS_PROCESS_PROBE: string
export type WindowsThinReport = {
  schema: 1
  product: string
  packageVersion: string
  key: 'win32-x64'
  arch: 'x64'
  electronVersion: string
  electronModulesAbi: string
  nodeVersion: string
  nodeModulesAbi: string
  runtimeManifestDigest: string
  setupInfoSchema: 2
  setupRuntimeKeys: ['win32-x64']
  compatibility: Array<{ path: string; arch: 'x64'; format: 'PE32+' }>
  appTreeDigest: string
  nativeAddonSelftests: 'passed'
  electronSqliteCheck: 'passed'
  setupAvailable: false
}
export function verifyWindowsSetupMetadata(options: { resources: string }): {
  setupInfo: { schema: 2; version: string; runtimePayloads: Record<'win32-x64', { path: string; digest: string }> }
  setupKeys: ['win32-x64']
  runtimeManifestDigest: string
}
export function verifyWindowsThinApp(options: {
  app: string
  inputsPath?: string
  sourceCommit?: string
}): WindowsThinReport
