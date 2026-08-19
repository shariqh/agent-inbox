export class LinuxThinVerificationError extends Error {}
export const PROCESS_PROBE: string
export type LinuxThinReport = {
  schema: 1
  product: string
  packageVersion: string
  key: string
  arch: string
  electronVersion: string
  electronModulesAbi: string
  nodeVersion: string
  nodeModulesAbi: string
  runtimeManifestDigest: string
  setupInfoSchema: 2
  setupRuntimeKeys: string[]
  compatibility: Array<{
    path: string
    arch: 'arm64' | 'x64'
    maximumRequiredGlibc: string | null
    maximumRequiredLibstdcxx: string | null
  }>
  appTreeDigest: string
  nativeAddonSelftests: 'passed'
  exactHostSetupSelection: 'passed'
}
export function verifyLinuxThinApp(options: {
  app: string
  arch: string
  inputsPath?: string
  sourceCommit?: string
}): LinuxThinReport
