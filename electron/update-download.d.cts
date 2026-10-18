import type { FetchResponse, UpdateArtifact } from './update-fetch.cjs'
import type { UpdateTargetPackageType } from './update-manifest.cjs'

export type { UpdateArtifact }

export type DownloadableInstallStrategy = 'macos-dmg' | 'appimage-self-replace'

/**
 * A file whose exact length and SHA-256 matched the signed manifest. This is
 * the seam the install steps consume; call `verify()` again immediately before
 * acting on it, because the file can change after it was verified.
 */
export interface VerifiedArtifact {
  path: string
  version: string
  tag: string
  filename: string
  sha256: string
  byteLength: number
  packageType: UpdateTargetPackageType
  installStrategy: DownloadableInstallStrategy
  minimumSystemVersion?: string
}

export type UpdateDownloadErrorCode =
  | 'invalid-artifact'
  | 'unsupported-strategy'
  | 'redirect-rejected'
  | 'too-many-redirects'
  | 'http-status'
  | 'network'
  | 'timeout'
  | 'too-large'
  | 'too-short'
  | 'hash-mismatch'
  | 'disk'
  | 'cancelled'
  | 'superseded'
  | 'not-verified'

export class UpdateDownloadError extends Error {
  constructor(code: UpdateDownloadErrorCode, message?: string)
  readonly code: UpdateDownloadErrorCode
}

export interface DownloadFetchInit {
  redirect: 'manual'
  signal: AbortSignal
  credentials: 'omit'
  headers: { 'cache-control': 'no-cache' }
}

export interface UpdateDownloadFileHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  stat(): Promise<{ isFile(): boolean; size: number }>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface UpdateDownloadStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
  mode: number
  mtimeMs: number
}

/** The subset of `node:fs/promises` the downloader uses; injectable for failure tests. */
export interface UpdateDownloadFs {
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<unknown>
  mkdtemp(prefix: string): Promise<string>
  open(path: string, flags: number | string, mode?: number): Promise<UpdateDownloadFileHandle>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  rmdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  lstat(path: string): Promise<UpdateDownloadStat>
  readdir(path: string): Promise<string[]>
  chmod(path: string, mode: number): Promise<void>
}

export interface UpdateDownloader {
  /**
   * Returns the frozen, re-validated artifact when its strategy downloads,
   * `null` for a notify-only strategy (`deb-notify`), and throws
   * `UpdateDownloadError('invalid-artifact')` for anything malformed.
   */
  normalize(artifact: unknown): UpdateArtifact | null
  /**
   * Downloads exactly `artifact`, reusing an already-verified copy or joining
   * an in-flight download of the same artifact. A different artifact
   * supersedes the in-flight one. Never executes, opens or installs anything.
   */
  download(
    artifact: UpdateArtifact,
    options?: { onProgress?(receivedBytes: number, totalBytes: number): void },
  ): Promise<VerifiedArtifact>
  /** Cancels the in-flight download; resolves once its partial files are gone. */
  cancel(): Promise<void>
  /** Re-hashes a verified artifact at its expected location. */
  verify(record: VerifiedArtifact): Promise<VerifiedArtifact>
  /**
   * Bounded cleanup. Removes abandoned staging directories, downloads at or
   * below `currentVersion`, and, when `keep` is supplied, every download other
   * than `keep` (`keep: null` removes them all). Never rejects.
   */
  prune(options?: { keep?: UpdateArtifact | null; currentVersion?: string }): Promise<void>
}

export function createUpdateDownloader(options: {
  directory: string
  fetchImpl(url: string, init: DownloadFetchInit): Promise<FetchResponse>
  fsImpl?: UpdateDownloadFs
  stallTimeoutMs?: number
  totalTimeoutMs?: number
  staleAfterMs?: number
  setTimeoutImpl?: (callback: () => void, delay: number) => unknown
  clearTimeoutImpl?: (timer: any) => void
  nowMs?: () => number
}): UpdateDownloader
