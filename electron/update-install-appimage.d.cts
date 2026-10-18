import type { DownloadableInstallStrategy, UpdateDownloadFileHandle, VerifiedArtifact } from './update-download.cjs'

// #196 part 3, phase 1: a structural copy of the shared install contract that
// electron/update-install.d.cts (part 2) owns. Replaced by imports from there
// once part 2 lands; keep every declaration identical until then.
export type UpdateInstallErrorCode =
  | 'not-feasible'
  | 'not-verified'
  | 'stale'
  | 'busy'
  | 'staging'
  | 'verification-failed'
  | 'commit-failed'

export interface InstallCandidate {
  version: string
  minimumSystemVersion?: string
}

/** `message` is plain-language and user-safe: it never contains a path. */
export type InstallFeasibility = { ok: true } | { ok: false; reason: string; message: string }

/** An already-open read-only handle whose bytes were re-hashed through this same handle immediately before. */
export interface VerifiedInstallSource {
  record: VerifiedArtifact
  /** Positioned reads only; the caller closes it. */
  handle: Pick<UpdateDownloadFileHandle, 'read' | 'stat'>
}

export interface PreparedInstall {
  /**
   * The only step that changes the installation. Resolves once the
   * swap/relaunch hand-off is arranged; main quits right after. If it rejects,
   * the running installation is untouched.
   */
  commit(): Promise<void>
  /** Removes everything prepare() staged. Idempotent; never rejects. */
  discard(): Promise<void>
}

export interface PlatformInstaller {
  readonly strategy: DownloadableInstallStrategy
  /** Side-effect free; never rejects. */
  feasibility(candidate: InstallCandidate): Promise<InstallFeasibility>
  /**
   * Stages and fully verifies the new build from `source` without modifying
   * the running installation. Throws UpdateInstallError.
   */
  prepare(source: VerifiedInstallSource, options?: { signal?: AbortSignal }): Promise<PreparedInstall>
  /** Bounded startup cleanup. Never rejects. */
  cleanup?(): Promise<void>
}

export type AppImageInfeasibleReason =
  | 'unsupported-platform'
  | 'not-packaged'
  | 'not-appimage'
  | 'name-too-long'
  | 'not-regular-file'
  | 'not-owner'
  | 'read-only'
  | 'not-recognized'
  | 'unexpected'

export interface AppImageInstallStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  dev: bigint
  ino: bigint
  uid: bigint
  size: bigint
  mtimeMs: bigint
}

export interface AppImageInstallFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>
  stat(options: { bigint: true }): Promise<AppImageInstallStat>
  chmod(mode: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** The subset of `node:fs/promises` the installer uses; injectable for failure tests. */
export interface AppImageInstallFs {
  lstat(path: string, options: { bigint: true }): Promise<AppImageInstallStat>
  access(path: string, mode: number): Promise<void>
  open(path: string, flags: number, mode?: number): Promise<AppImageInstallFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
}

export interface AppImageInstaller extends PlatformInstaller {
  readonly strategy: 'appimage-self-replace'
  cleanup(): Promise<void>
}

export function createAppImageInstaller(options: {
  /** `process.env`; only APPIMAGE and APPDIR are read. */
  env: Readonly<Record<string, string | undefined>>
  /** `process.execPath`; must sit inside APPDIR, the running AppImage's mount. */
  execPath: string
  /** `process.getuid()`; the AppImage file must belong to this user. */
  uid: number
  platform: string
  isPackaged: boolean
  /** Called once, only after the new build replaced the AppImage file. */
  relaunch(): void
  fsImpl?: AppImageInstallFs
  randomImpl?: (size: number) => Uint8Array
}): AppImageInstaller
