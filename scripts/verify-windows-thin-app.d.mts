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
  setupAvailable: false
}
export function verifyWindowsThinApp(options: {
  app: string
  inputsPath?: string
  sourceCommit?: string
}): WindowsThinReport
