import type { PlatformInstaller } from './update-install.cjs'

export type AppImageInfeasibleReason =
  | 'unsupported-platform'
  | 'not-packaged'
  | 'not-appimage'
  | 'name-too-long'
  | 'not-regular-file'
  | 'not-owner'
  | 'read-only'
  | 'not-recognized'
  | 'changed-since-launch'
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
  mtimeNs: bigint
}

export interface AppImageInstallFileHandle {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  write(buffer: Uint8Array, offset: number, length: number, position?: number | null): Promise<{ bytesWritten: number }>
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

export interface AppImageHelperOptions {
  detached: true
  stdio: 'ignore'
  env: Record<string, string>
  cwd: string
}

export interface AppImageHelperProcess {
  on(event: string, listener: (...args: any[]) => void): unknown
  once(event: string, listener: (...args: any[]) => void): unknown
  unref(): void
}

/** `child_process.spawn`, narrowed to the one call the installer makes. */
export type AppImageSpawn = (
  command: string,
  args: readonly string[],
  options: AppImageHelperOptions,
) => AppImageHelperProcess

export interface AppImageInstaller extends PlatformInstaller {
  readonly strategy: 'appimage-self-replace'
  cleanup(): Promise<void>
}

export function createAppImageInstaller(options: {
  /** `process.env`: APPIMAGE and APPDIR locate the AppImage; the restart helper inherits the rest, minus the old mount. */
  env: Readonly<Record<string, string | undefined>>
  /** `process.execPath`; must sit inside APPDIR, the running AppImage's mount. */
  execPath: string
  /** `process.getuid()`; the AppImage file must belong to this user. */
  uid: number
  platform: string
  isPackaged: boolean
  /** `process.pid`: the restart helper starts the new build only after this process exits. */
  pid: number
  /** Read at commit time: a viewer child process this app started, if any; the helper waits for it as well. */
  viewerPid?: () => number | null
  /** `child_process.spawn`; used once per commit, for the detached `/bin/sh` restart helper. */
  spawnImpl: AppImageSpawn
  /** How long the helper waits for those processes before giving up. Default 120 s. */
  helperTimeoutMs?: number
  fsImpl?: AppImageInstallFs
  randomImpl?: (size: number) => Uint8Array
}): AppImageInstaller
