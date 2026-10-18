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
   * installation must be untouched.
   */
  commit(): Promise<void>
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
