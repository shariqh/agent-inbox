import { MACOS_RUNTIME_KEYS } from './runtime-targets.mjs'

export const DEFAULT_RELEASE_INPUTS: string
export { MACOS_RUNTIME_KEYS }
export const RUNTIME_KEYS: typeof MACOS_RUNTIME_KEYS
export const RELEASE_TOOL_PACKAGES: Record<string, string>
export class ReleaseInputError extends Error {}
export function requireExactKeys(value: unknown, expected: readonly string[], field: string): void
export function requireString(value: unknown, field: string, pattern?: RegExp): void
export function validateNodeReleaseInputs<T>(node: T, runtimeKeys: readonly string[]): T
export function validateElectronReleaseInputs<T>(electron: T, fields: readonly string[]): T

export type ElectronHeaders = {
  archive: string
  root: string
  url: string
  sha256: string
  importLibraries?: Record<string, { url: string, sha256: string }>
}
export const ELECTRON_HEADERS_BASE_URL: string
export const ELECTRON_HEADERS_ROOT: string
export function electronHeadersIdentity(version: string): { archive: string, root: string, url: string }
export function electronImportLibraryUrl(version: string, key: string): string
export function requireElectronHeadersPin(value: unknown): void
export function validateElectronHeaders<T>(headers: T, version: string, importLibraryKeys?: readonly string[]): T

export type RuntimeKey = (typeof RUNTIME_KEYS)[number]
export type ReleaseInputs = {
  schema: 1
  product: string
  bundleId: string
  minimumMacosVersion: string
  macosArchitectures: readonly string[]
  node: {
    version: string
    modulesAbi: string
    distributions: Record<RuntimeKey, {
      platform: 'darwin'
      arch: 'arm64'
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
    osxSignVersion: string
    dmgVersion: string
  }
  electronHeaders: ElectronHeaders
}

export function validateReleaseInputs(value: unknown): ReleaseInputs
export function loadReleaseInputs(path?: string): ReleaseInputs
export function validateInstalledReleaseTools(inputs: ReleaseInputs, repoRoot?: string): ReleaseInputs
export function validateInstalledReleaseToolsFor<T>(
  inputs: T,
  toolPackages: Record<string, string>,
  repoRoot?: string,
): T
export function loadElectronChecksums(options: {
  version: string
  platform: string
  arch: string
  repoRoot?: string
  env?: Record<string, string | undefined>
}): Record<string, string>
export function sha256File(path: string): string
export function verifyArchiveDigest(path: string, expectedSha256: string): string
export function downloadArchive(options: {
  url: string
  destination: string
  expectedSha256: string
  fetchImpl?: typeof fetch
  followRedirects?: boolean
}): Promise<string>
