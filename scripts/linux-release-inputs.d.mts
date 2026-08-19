import { LINUX_RUNTIME_KEYS } from './runtime-targets.mjs'

export const DEFAULT_LINUX_RELEASE_INPUTS: string
export { LINUX_RUNTIME_KEYS }
export const LINUX_RELEASE_TOOL_PACKAGES: Record<string, string>
export type LinuxRuntimeKey = (typeof LINUX_RUNTIME_KEYS)[number]
export type LinuxReleaseInputs = {
  schema: 1
  product: string
  bundleId: string
  minimumKernelVersion: string
  minimumGlibcVersion: string
  minimumLibstdcxxVersion: string
  maximumGlibcxxVersion: string
  distributionFloor: {
    ubuntu: string
    debian: string
    rhel: string
  }
  node: {
    version: string
    modulesAbi: string
    distributions: Record<LinuxRuntimeKey, {
      platform: 'linux'
      arch: 'arm64' | 'x64'
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
export function validateLinuxReleaseInputs(value: unknown): LinuxReleaseInputs
export function loadLinuxReleaseInputs(path?: string): LinuxReleaseInputs
export function validateInstalledLinuxReleaseTools(
  inputs: LinuxReleaseInputs,
  repoRoot?: string,
): LinuxReleaseInputs
