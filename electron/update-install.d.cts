import type {
  DownloadableInstallStrategy,
  UpdateDownloadFileHandle,
  VerifiedArtifact,
} from './update-download.cjs'

export type { DownloadableInstallStrategy, VerifiedArtifact }

export type UpdateInstallErrorCode =
  | 'not-feasible'
  | 'not-verified'
  | 'stale'
  | 'busy'
  | 'staging'
  | 'verification-failed'
  | 'commit-failed'

/** Messages are generic and never carry a path, URL or command output. */
export class UpdateInstallError extends Error {
  constructor(code: UpdateInstallErrorCode, message?: string)
  readonly code: UpdateInstallErrorCode
}

export interface InstallCandidate {
  version: string
  /**
   * The target's architecture (#343). Only the macOS installer reads it: it refuses a
   * candidate without `universal` or `arm64`, and `arm64` unless this process is arm64.
   */
  architecture?: string
  minimumSystemVersion?: string
}

/**
 * `message` is plain-language, user-safe copy shown in Settings → Updates and
 * NEVER contains a path. The controller replaces a message that contains `/`,
 * spans lines or exceeds 240 characters with generic copy.
 */
export type InstallFeasibility =
  | { ok: true }
  | { ok: false; reason: string; message: string }

/** An already-open read-only handle whose bytes were re-hashed THROUGH this same handle immediately before. */
export interface VerifiedInstallSource {
  record: VerifiedArtifact
  /** Positioned reads only; the CALLER closes it. */
  handle: Pick<UpdateDownloadFileHandle, 'read' | 'stat'>
}

export interface PreparedInstall {
  /**
   * The only step that changes the installation. Resolves once the swap/relaunch
   * hand-off is arranged; main quits right after. If it rejects, the running
   * installation must be untouched. `resultPath` (absolute, no dot segments, no
   * trailing slash) is where the platform helper writes its exit code, from
   * INSTALL_HELPER_EXIT, before it exits; the controller passes the attempt
   * store's path. Installers fall back to a path in their own work directory.
   */
  commit(options?: { resultPath?: string }): Promise<void>
  /** Removes everything prepare() staged. Idempotent; never rejects. */
  discard(): Promise<void>
}

export interface PlatformInstaller {
  readonly strategy: DownloadableInstallStrategy
  /**
   * Side-effect free; never rejects. Consulted at offer time (not ok => the
   * offer is notify-only: downloadable:false, no Download button, message
   * explains why) and again immediately before install.
   */
  feasibility(candidate: InstallCandidate): Promise<InstallFeasibility>
  /**
   * Stages AND fully verifies the new build from `source` without modifying
   * the running installation. Must hash the bytes it actually consumes from the
   * handle and require exact byteLength + sha256 equal to source.record before
   * using them. Throws UpdateInstallError.
   */
  prepare(source: VerifiedInstallSource, options?: { signal?: AbortSignal }): Promise<PreparedInstall>
  /**
   * Optional bounded startup cleanup (>1h old, exact name patterns it creates,
   * owned by this uid, never follows symlinks, bounded removals per pass).
   * Never rejects.
   */
  cleanup?(): Promise<void>
}

/** The subset of `node:fs/promises` copyVerifiedSource uses; injectable for failure tests. */
export interface InstallCopyFs {
  open(path: string, flags: 'wx', mode: number): Promise<{
    write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  unlink(path: string): Promise<void>
}

/**
 * Copies exactly `source.record.byteLength` bytes from the handle with
 * positioned reads into a new file opened `wx` (mode 0600 by default), hashing
 * the bytes it consumes. Keeps the copy only when they match the signed length
 * and SHA-256 (`not-verified` otherwise); a write failure or cancellation is
 * `staging`. Every failure removes the copy; an existing file is never touched.
 */
export function copyVerifiedSource(
  source: VerifiedInstallSource,
  destination: string,
  options?: { fsImpl?: InstallCopyFs; signal?: AbortSignal; mode?: number },
): Promise<void>

/**
 * The exit codes every platform's swap helper uses, and writes as its whole
 * result file (`"<code>\n"`) before it exits.
 */
export const INSTALL_HELPER_EXIT: Readonly<{
  /** The new build is in place and was launched. */
  installed: 0
  /** Arguments failed validation; nothing was touched. */
  badArguments: 64
  /** Refused before any change (the running app or staged build changed, or the backup path is taken). */
  refused: 65
  /** The running app could not be moved aside (for example, permission denied); the old app was reopened. */
  couldNotMoveAside: 70
  /** The new build could not be moved into place; the old app was restored and reopened. */
  couldNotMoveIn: 71
  /** The app (or its viewer) never exited; nothing was changed and nothing was reopened. */
  timedOut: 75
}>

/** last-attempt.json, written atomically just before commit(). */
export interface InstallAttemptRecord {
  schema: 1
  /** The running version that started the install. */
  from: string
  /** The version being installed. */
  to: string
  /** ISO time the attempt began. */
  at: string
  /** process.platform of the app that wrote it. */
  platform: string
  strategy: DownloadableInstallStrategy
}

export interface InstallAttemptOutcome extends Omit<InstallAttemptRecord, 'schema'> {
  /** The helper's reported exit code, or null when it never wrote a valid one. */
  exitCode: number | null
}

export interface InstallAttemptStore {
  /**
   * Writes last-attempt.json atomically (0600, in a private 0700 directory that
   * must not be a link), first removing any stale helper result. Resolves with
   * the path the helper must report to. Rejects when the record cannot be
   * written; nothing should be committed then.
   */
  begin(attempt: { from: string; to: string; strategy: DownloadableInstallStrategy }): Promise<{ resultPath: string }>
  /** Removes the record and any result (the hand-off never started). Never rejects. */
  abandon(): Promise<void>
  /**
   * Reads and deletes the record and the result, once, without following links.
   * Null when there was no valid record. A record without a result that is
   * younger than `inFlightMs` (default 150 s, the helpers' wait plus margin) is
   * left untouched for the app the helper reopens. Never rejects.
   */
  take(): Promise<InstallAttemptOutcome | null>
}

export interface InstallAttemptFs {
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; size: number; uid: number }>
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  open(path: string, flags: 'wx', mode: number): Promise<{
    write(data: string): Promise<unknown>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** The record and result live in `directory` (userData/update-install). */
export function createInstallAttemptStore(options: {
  directory: string
  platform?: string
  uid?: number
  fsImpl?: InstallAttemptFs
  now?: () => Date
  inFlightMs?: number
}): InstallAttemptStore
