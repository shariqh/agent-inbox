import type {
  UpdateInstallStrategy,
  UpdateManifestTarget,
  UpdateRegistry,
  UpdateTargetPackageType,
} from './update-manifest.cjs'

export const MANIFEST_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json'
export const SIGNATURE_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'stale'
  | 'unverified'
  | 'unsupported'

export interface VerifiedAvailableUpdate {
  version: string
  tag: string
  releaseUrl: string
  target: {
    packageType: UpdateTargetPackageType
    installStrategy: UpdateInstallStrategy
  }
}

export interface UpdateRendererState {
  status: UpdateStatus
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  message: string
  available?: VerifiedAvailableUpdate
}

/**
 * The signed manifest's exact target for this host plus its release identity.
 * Main-process only: it carries the download URL, length and digest, so it is
 * returned only when `includeArtifact` is set and is never sent to a renderer.
 */
export interface UpdateArtifact extends UpdateManifestTarget {
  version: string
  tag: string
}

export interface UpdateCheckResult extends UpdateRendererState {
  artifact?: UpdateArtifact
}

export interface FetchResponse {
  status: number
  headers?: { get(name: string): string | null }
  body?: {
    cancel?(): Promise<unknown>
    getReader?(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
      cancel?(): Promise<unknown>
      releaseLock?(): void
    }
    [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array | Buffer>
  } | null
}

export interface UpdateCheckOptions {
  fetchImpl(
    url: string,
    init: {
      redirect: 'manual'
      signal: AbortSignal
      headers: { 'cache-control': 'no-cache' }
    },
  ): Promise<FetchResponse>
  registry: UpdateRegistry
  currentVersion: string
  automaticChecks?: boolean
  /**
   * Called once, only after the manifest's signature, schema and expiry verify: persists
   * that version as a rollback high-water candidate and resolves the stored mark (or null).
   * A verified manifest below the resolved mark yields the `stale` status.
   */
  recordVerifiedVersion?(version: string): Promise<string | null>
  platform: string
  arch: string
  isPackaged: boolean
  /** `process.env.APPIMAGE`; with `appDir` and `execPath`, selects the AppImage target (see runsFromAppImage). */
  appImagePath?: string
  /** `process.env.APPDIR`, the running AppImage's mount. */
  appDir?: string
  /** `process.execPath`; must sit inside `appDir` for the AppImage target. */
  execPath?: string
  /** Attach the verified target as `artifact` for the main-process downloader. */
  includeArtifact?: boolean
  now?: () => Date
  timeoutMs?: number
  setTimeoutImpl?: (callback: () => void, delay: number) => unknown
  clearTimeoutImpl?: (timer: any) => void
}

export function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult>

/**
 * True only when APPIMAGE and APPDIR are canonical absolute paths, APPDIR is not
 * the root, and the executable sits inside APPDIR: proof the app runs from that
 * AppImage rather than from a .deb install that inherited another image's variables.
 */
export function runsFromAppImage(options: { appImagePath?: string; appDir?: string; execPath?: string }): boolean
