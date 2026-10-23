import type { PlatformInstaller } from './update-install.cjs'

/** The constant POSIX sh helper commit() writes and runs; it never interpolates its arguments. */
export const HELPER_SCRIPT: string

export const MAC_INSTALL_BINARIES: Readonly<{
  hdiutil: '/usr/bin/hdiutil'
  codesign: '/usr/bin/codesign'
  spctl: '/usr/sbin/spctl'
  ditto: '/usr/bin/ditto'
  plutil: '/usr/bin/plutil'
  open: '/usr/bin/open'
  sh: '/bin/sh'
}>

export interface MacInstallBinaries {
  hdiutil: string
  codesign: string
  spctl: string
  ditto: string
  plutil: string
  open: string
  sh: string
}

export interface MacExecOptions {
  encoding: 'utf8'
  env: Record<string, string>
  timeout: number
  maxBuffer: number
  windowsHide: boolean
  signal?: AbortSignal
}

/** `child_process.execFile`'s shape: argv arrays only, never a shell. */
export type MacExecFile = (
  file: string,
  args: readonly string[],
  options: MacExecOptions,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => { stdin?: { end(): void } | null } | undefined

export interface MacSpawnOptions {
  detached: true
  stdio: 'ignore'
  env: Record<string, string>
  cwd: string
}

export interface MacSpawnedHelper {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  unref(): void
}

export type MacSpawn = (command: string, args: readonly string[], options: MacSpawnOptions) => MacSpawnedHelper

export interface MacInstallerStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  dev: number | bigint
  ino: number | bigint
  uid: number | bigint
  mode: number | bigint
  mtimeMs: number | bigint
}

/** The subset of `node:fs/promises` the installer uses; injectable for failure tests. */
export interface MacInstallerFs {
  access(path: string, mode: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string, options?: { bigint?: boolean }): Promise<MacInstallerStat>
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<unknown>
  mkdtemp(prefix: string): Promise<string>
  open(path: string, flags: 'wx', mode: number): Promise<{
    write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  /** The staged executable's header (#343): `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, at most 4 KiB read. */
  open(path: string, flags: number): Promise<{
    stat(): Promise<{ isFile(): boolean }>
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
    close(): Promise<void>
  }>
  readdir(path: string): Promise<string[]>
  realpath(path: string): Promise<string>
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  rmdir(path: string): Promise<void>
  stat(path: string, options?: { bigint?: boolean }): Promise<MacInstallerStat>
  unlink(path: string): Promise<void>
  writeFile(path: string, data: string, options: { mode: number; flag: 'wx' }): Promise<void>
}

export interface MacInstallerOptions {
  /** The running `<X>.app`, from bundlePathFromExecPath(process.execPath); null when unknown. */
  bundlePath: string | null
  expectedBundleId?: string
  teamId?: string
  /** process.getSystemVersion() */
  systemVersion: string
  /** This app's process; the helper waits for it to exit. */
  pid: number
  /**
   * Read when committing: the PID of a viewer process this app started and
   * stops when it quits, or null when the viewer runs in-process or was
   * reused. The helper waits for it too, so the relaunched app never finds the
   * old viewer still answering on its port.
   */
  viewerPid?: () => number | null
  uid: number
  platform?: string
  /**
   * process.arch (#343): an arm64-only build is refused unless this is `arm64` (under
   * Rosetta it is `x64`), and the staged executable must carry this architecture's slice.
   */
  hostArch?: string
  isPackaged: boolean
  /** userData/update-install */
  workDirectory: string
  execFileImpl?: MacExecFile
  spawnImpl?: MacSpawn
  fsImpl?: MacInstallerFs
  binaries?: Partial<MacInstallBinaries>
  nowMs?: () => number
}

/** `<X>.app/Contents/MacOS/<executable>` -> `<X>.app`; null for anything else. */
export function bundlePathFromExecPath(execPath: string): string | null

export function createMacInstaller(options: MacInstallerOptions): PlatformInstaller & {
  readonly strategy: 'macos-dmg'
  cleanup(): Promise<void>
}
