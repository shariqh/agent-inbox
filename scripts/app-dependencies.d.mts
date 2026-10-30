import type { ElectronHeaders, downloadArchive } from './release-inputs.mjs'

export const UNREACHABLE_HEADER_URL: string
export class AppDependenciesError extends Error {}
export function importLibraryKey(platform: string, arch: string): string | null
export function provisionElectronHeaders(options: {
  headers: ElectronHeaders | undefined
  electronVersion: string
  platform?: string
  arch: string
  parent: string
  download?: typeof downloadArchive
  systemRoot?: string
  tar?: string
}): Promise<string>
export function assertNoNodeGypHeaderOverrides(env?: Record<string, string | undefined>): void
export function configuredNodedir(stageRoot: string): string
export function installAppDependencies(options: {
  stageRoot: string
  npmCli: string
  electronVersion: string
  arch: string
  electronHeaders: ElectronHeaders
  env?: NodeJS.ProcessEnv
  download?: typeof downloadArchive
  rebuildImpl?: (options: Record<string, unknown>) => Promise<void>
  log?: (line: string) => void
}): Promise<void>
