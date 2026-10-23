export type MacosReleaseKind = 'universal' | 'arm64'

export class MacosReleaseKindError extends Error {}

export function macosKindOf(architectures: unknown, label?: string): MacosReleaseKind

export function measuredMacosKind(options: {
  expected: unknown
  executable: unknown
  betterSqlite3: unknown
}): MacosReleaseKind

export interface MacosRelease {
  readonly kind: MacosReleaseKind
  readonly dmgName: string
  readonly architecture: 'universal' | 'arm64'
  readonly target: 'darwin-arm64+darwin-x64' | 'darwin-arm64'
  readonly needsNativeIntel: boolean
  readonly v1Manifest: 'release' | 'restamp'
}

export function macosRelease(options: { kind: MacosReleaseKind | string; tag: string }): MacosRelease
