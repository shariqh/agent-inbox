import { WINDOWS_RUNTIME_KEYS } from './runtime-targets.mjs'

export const DEFAULT_WINDOWS_RELEASE_INPUTS: string
export { WINDOWS_RUNTIME_KEYS }
export const WINDOWS_RELEASE_TOOL_PACKAGES: Record<string, string>
export type WindowsRuntimeKey = (typeof WINDOWS_RUNTIME_KEYS)[number]
export type WindowsReleaseInputs = {
  schema: 1
  product: string
  bundleId: string
  minimumWindowsVersion: string
  node: {
    version: string
    modulesAbi: string
    distributions: Record<WindowsRuntimeKey, {
      platform: 'win32'
      arch: 'x64'
      archive: string
      root: string
      url: string
      sha256: string
    }>
  }
  electron: {
    version: string
    modulesAbi: string
    packagerVersion: string
    rebuildVersion: string
  }
}
export function validateWindowsReleaseInputs(value: unknown): WindowsReleaseInputs
export function loadWindowsReleaseInputs(path?: string): WindowsReleaseInputs
export function validateInstalledWindowsReleaseTools(
  inputs: WindowsReleaseInputs,
  repoRoot?: string,
): WindowsReleaseInputs
