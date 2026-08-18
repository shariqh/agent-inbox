export type SetupEntryKind = 'file' | 'directory'
export type DirectoryReplacement = 'refuse' | 'swap'

export interface SetupPathStat {
  dev: bigint
  ino: bigint
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface SetupFilesystemIO {
  lstat(path: string): SetupPathStat
  realpath(path: string): string
  mkdir(path: string, options: { recursive: boolean }): void
  mkdtemp(prefix: string): string
  rename(from: string, to: string): void
  remove(path: string, options: { recursive: boolean; force: boolean }): void
}

export interface SetupFilesystemOptions {
  platform?: NodeJS.Platform
  io?: SetupFilesystemIO
}

export interface SetupPathIdentity {
  readonly path: string
  readonly canonicalPath: string
  readonly kind: SetupEntryKind
  readonly device: string
  readonly inode: string
}

export interface StageDirectoryResult<T> {
  readonly path: string
  readonly prepared: T
  readonly replaced: boolean
}

export interface RemoveDirectoryResult {
  readonly path: string
  readonly identity: SetupPathIdentity
}

export interface SetupFilesystem {
  identify(path: string, expectedKind: SetupEntryKind): SetupPathIdentity
  assertIdentity(identity: SetupPathIdentity, path?: string): SetupPathIdentity
  stageDirectory<T>(options: {
    destination: string
    replacement: DirectoryReplacement
    prepare(stageDirectory: string): T
    validate(stageDirectory: string, prepared: T): void
  }): StageDirectoryResult<T>
  removeDirectory(options: {
    target: string
    validate(target: string): void
  }): RemoveDirectoryResult
}

export function createSetupFilesystem(
  options?: SetupFilesystemOptions,
): Readonly<SetupFilesystem>
