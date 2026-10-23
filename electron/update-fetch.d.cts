import type {
  UpdateInstallStrategy,
  UpdateManifestTarget,
  UpdateRegistry,
  UpdateTargetPackageType,
} from './update-manifest.cjs'
import type { UpdateManifestName } from './update-preferences.cjs'

export const MANIFEST_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json'
export const SIGNATURE_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest.json.sig'
/** update-manifest-v2.json, which 1.7.0 and later read first (#343). */
export const MANIFEST_V2_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json'
export const SIGNATURE_V2_URL: 'https://github.com/shariqh/agent-inbox/releases/latest/download/update-manifest-v2.json.sig'

/**
 * Why an offer can't be downloaded or installed here (#343): the release ships only an
 * arm64 DMG, this process isn't arm64, and update-manifest.json offers nothing newer.
 * `apple-silicon` on an Intel Mac, `rosetta` when the app runs translated on Apple silicon.
 */
export type UpdateBlockedReason = 'apple-silicon' | 'rosetta'

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
  blocked?: UpdateBlockedReason
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
  /** The manifest an `available` result came from; main-process only (#343). */
  manifest?: UpdateManifestName
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
   * Called once per manifest, only after its signature, schema and expiry verify: persists
   * that version in the manifest's rollback high-water mark and resolves the mark its stale
   * decision uses (or null): the v1 mark for `v1`, the higher of both marks for `v2`. A
   * verified manifest below the resolved mark yields the `stale` status.
   */
  recordVerifiedVersion?(version: string, manifest: UpdateManifestName): Promise<string | null>
  platform: string
  /** `process.arch`; only an `arm64` process is ever offered an arm64-only DMG. */
  arch: string
  /** `app.runningUnderARM64Translation`: chooses the blocked copy only (`rosetta`). */
  translated?: boolean
  isPackaged: boolean
  /** `process.env.APPIMAGE`; with `appDir` and `execPath`, selects the AppImage target (see runsFromAppImage). */
  appImagePath?: string
  /** `process.env.APPDIR`, the running AppImage's mount. */
  appDir?: string
  /** `process.execPath`; must sit inside `appDir` for the AppImage target. */
  execPath?: string
  /** What the AppImage proof reads; this machine's lstat and /proc/self/mountinfo by default. */
  appImageProbe?: AppImageProbe
  /** Attach the verified target as `artifact` for the main-process downloader. */
  includeArtifact?: boolean
  now?: () => Date
  timeoutMs?: number
  setTimeoutImpl?: (callback: () => void, delay: number) => unknown
  clearTimeoutImpl?: (timer: any) => void
}

export function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult>

/** What the AppImage proof reads from the system; injectable for tests. */
export interface AppImageProbe {
  /** `fs.lstatSync(path, { bigint: true })`. */
  lstat(path: string): { dev: bigint | number; isDirectory(): boolean }
  /** The text of `/proc/self/mountinfo`. */
  mountInfo(): string
}

/**
 * True only when APPIMAGE and APPDIR are canonical absolute paths, APPDIR is not
 * the root, the executable sits inside APPDIR, and APPDIR is the runtime's FUSE
 * mount of that image: a mount point (another device than its parent) whose
 * visible /proc/self/mountinfo entry has type `fuse.<name>` and source `<name>`,
 * `<name>` being APPIMAGE's file name (libfuse's default subtype). Proof the app
 * runs from that AppImage rather than from a .deb install or an extracted
 * squashfs-root that inherited another image's variables. Never throws.
 */
export function runsFromAppImage(options: {
  appImagePath?: string
  appDir?: string
  execPath?: string
  appImageProbe?: AppImageProbe
}): boolean
