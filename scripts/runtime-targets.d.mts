export type RuntimeTargetKey =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64'

export type RuntimePlatform = 'darwin' | 'linux' | 'win32'
export type RuntimeArch = 'arm64' | 'x64'
export type NodeDistributionPlatform = 'darwin' | 'linux' | 'win'
export type NodeArchiveFormat = 'tar.xz' | 'zip'

export interface RuntimeTarget {
  readonly key: RuntimeTargetKey
  readonly platform: RuntimePlatform
  readonly arch: RuntimeArch
  readonly nodeDistPlatform: NodeDistributionPlatform
  readonly format: NodeArchiveFormat
  readonly nodeExecRelPath: string
  readonly npmCliRelPath: string
}

export const RUNTIME_TARGETS: Readonly<Record<RuntimeTargetKey, RuntimeTarget>>
export const MACOS_RUNTIME_KEYS: readonly ['darwin-arm64', 'darwin-x64']
export const LINUX_RUNTIME_KEYS: readonly ['linux-arm64', 'linux-x64']
export const WINDOWS_RUNTIME_KEYS: readonly ['win32-x64']
export const POSIX_SETUP_RUNTIME_KEYS: readonly [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
]

export function targetFor(key: string): RuntimeTarget
export function nodeDistributionIdentity(nodeVersion: string, key: string): {
  archive: string
  root: string
  url: string
}
