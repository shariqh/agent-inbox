import { MACOS_RUNTIME_KEYS } from './runtime-targets.mjs'

export const DEFAULT_RELEASE_INPUTS: string
export { MACOS_RUNTIME_KEYS }
export const RUNTIME_KEYS: typeof MACOS_RUNTIME_KEYS
export const RELEASE_TOOL_PACKAGES: Record<string, string>
export class ReleaseInputError extends Error {}

export type RuntimeKey = (typeof RUNTIME_KEYS)[number]
export type ReleaseInputs = {
  schema: 1
  product: string
  bundleId: string
  minimumMacosVersion: string
  node: {
    version: string
    modulesAbi: string
    distributions: Record<RuntimeKey, {
      platform: 'darwin'
      arch: 'arm64' | 'x64'
      archive: string
      root: string
      url: string
      sha256: string
    }>
  }
  electron: {
    version: string
    packagerVersion: string
    rebuildVersion: string
    universalVersion: string
    osxSignVersion: string
    dmgVersion: string
  }
}

export function validateReleaseInputs(value: unknown): ReleaseInputs
export function loadReleaseInputs(path?: string): ReleaseInputs
export function validateInstalledReleaseTools(inputs: ReleaseInputs, repoRoot?: string): ReleaseInputs
export function sha256File(path: string): string
export function verifyArchiveDigest(path: string, expectedSha256: string): string
export function downloadArchive(options: {
  url: string
  destination: string
  expectedSha256: string
  fetchImpl?: typeof fetch
}): Promise<string>
