export type SetupEntryKind = 'file' | 'directory'
export type DirectoryReplacement = 'refuse' | 'swap'

export interface SetupPathStat {
  dev: bigint
  ino: bigint
  uid?: bigint | number
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
  readdir(path: string): string[]
}

export interface SetupFilesystemOptions {
  platform?: NodeJS.Platform
  io?: SetupFilesystemIO
  // The owner leftover trash must have to be removed; null retains it all.
  uid?: number | null
}

// One rename and the checks that must pass before it; check() throws to refuse.
export interface RenameAttempt {
  check(): void
  rename(): void
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

export interface LeftoverTrashResult {
  readonly removed: string[]
  readonly retained: string[]
}

export interface SetupFilesystem {
  identify(path: string, expectedKind: SetupEntryKind): SetupPathIdentity
  assertIdentity(identity: SetupPathIdentity, path?: string): SetupPathIdentity
  stageDirectory<T>(options: {
    destination: string
    replacement: DirectoryReplacement
    prepare(stageDirectory: string): T
    validate(stageDirectory: string, prepared: T): void
    // Retry a publishing rename Windows refused, re-running every check before
    // each attempt (#333); the default renames once.
    retryBusyRename?: boolean
  }): StageDirectoryResult<T>
  removeDirectory(options: {
    target: string
    validate(target: string): void
  }): RemoveDirectoryResult
  removeLeftoverTrash(parent: string): LeftoverTrashResult
}

export function createSetupFilesystem(
  options?: SetupFilesystemOptions,
): Readonly<SetupFilesystem>

export function isTrashName(name: string): boolean

// On win32 only, retries a rename refused with EPERM, EACCES or EBUSY for about
// nine seconds of growing waits, running check() before every attempt (#333).
export function renameWithRetry(attempt: RenameAttempt & {
  platform?: NodeJS.Platform
  sleep?(ms: number): void
}): void
