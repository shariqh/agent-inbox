import type {
  UpdateArtifact,
  UpdateBlockedReason,
  UpdateCheckResult,
  UpdateRendererState,
  VerifiedAvailableUpdate,
} from './update-fetch.cjs'
import type {
  DownloadableInstallStrategy,
  UpdateDownloader,
  VerifiedArtifact,
} from './update-download.cjs'
import type { InstallAttemptStore, PlatformInstaller } from './update-install.cjs'
import type {
  UpdateManifestName,
  UpdatePreferences,
  UpdatePreferencesStore,
  UpdateTrustStateStore,
} from './update-preferences.cjs'

export type {
  UpdateArtifact,
  UpdateBlockedReason,
  UpdateCheckResult,
  UpdatePreferences,
  UpdateRendererState,
  VerifiedArtifact,
  VerifiedAvailableUpdate,
}

export const MANUAL_RELEASES_URL: 'https://github.com/shariqh/agent-inbox/releases'

export type UpdateControllerStatus =
  | UpdateRendererState['status']
  | 'downloading'
  | 'verified'
  | 'download-failed'
  | 'installing'
  | 'install-failed'

export interface OfferedUpdate extends VerifiedAvailableUpdate {
  /** True only for a pinned macos-dmg/appimage-self-replace artifact; deb-notify never downloads. */
  downloadable: boolean
  /** True only when a registered installer said it can install this offer here. Implies downloadable. */
  installable: boolean
  /**
   * True only while main would accept this window's install request (#216): it
   * is bound to the viewer this app started and owns, and no quit has begun.
   * Implies installable. False after a reload or crash main could not re-prove,
   * when Settings asks for a restart instead of offering Install and restart.
   */
  installPermitted: boolean
  /**
   * Plain-language reason, without any path, that a registered installer cannot
   * install this offer here, or that this Mac can't run the release (`blocked`).
   * Present only on such notify-only offers.
   */
  reason?: string
  /**
   * Set when the release ships only an arm64 DMG and this Mac can't run it (#343): never
   * downloadable or installable, with fixed copy in `reason`. Settings hides Review release
   * for `apple-silicon`, and main refuses to open it.
   */
  blocked?: UpdateBlockedReason
}

export interface UpdateDownloadProgress {
  receivedBytes: number
  totalBytes: number
}

/** What the renderer receives. It never carries a download URL, digest or path. */
export interface UpdateControllerState {
  status: UpdateControllerStatus
  currentVersion: string
  automaticChecks: boolean
  checkedAt: string | null
  message: string
  available?: OfferedUpdate
  download?: UpdateDownloadProgress
  /**
   * Plain-language report, without any path, that the previous install attempt
   * left this app on its old version. Kept until that release is no longer
   * offered or a new install starts.
   */
  installNotice?: string
}

export interface InstallFailureReport {
  /** The version that could not be installed. */
  version: string
  /** The version still running. */
  currentVersion: string
  /** The same text as UpdateControllerState.installNotice. */
  message: string
}

export interface UpdateNotification {
  version: string
  tag: string
  releaseUrl: string
  downloadable: boolean
  installable: boolean
  /** Only `rosetta`: an `apple-silicon` offer never notifies (#343). */
  blocked?: UpdateBlockedReason
}

export interface UpdateCheckerInput {
  currentVersion: string
  automaticChecks: boolean
  /**
   * Records a release just verified in `manifest`, saves that manifest's session high, and
   * resolves the mark its stale decision uses: the v1 mark for `v1`, the higher of both
   * marks for `v2` (#148, #343).
   */
  recordVerifiedVersion(version: string, manifest: UpdateManifestName): Promise<string | null>
}

export interface UpdateController {
  getState(): UpdateControllerState
  rendererReady(): Promise<UpdateControllerState>
  checkNow(): Promise<UpdateControllerState>
  runScheduledCheck(): Promise<UpdateControllerState>
  setAutomaticChecks(automaticChecks: boolean): Promise<UpdateControllerState>
  refreshSchedule(): Promise<UpdateControllerState>
  /** User-initiated. Resolves with the final state; never rejects. */
  downloadNow(): Promise<UpdateControllerState>
  cancelDownload(): Promise<UpdateControllerState>
  /**
   * User-initiated; never rejects. Requires a verified (or install-failed)
   * download of an installable offer, re-checks the running version, the
   * re-read high-water mark, Setup, any check in flight and the installer's
   * feasibility, then reopens the file through the downloader, prepares,
   * commits and requests the restart. Stays `installing` once committed.
   */
  installNow(): Promise<UpdateControllerState>
  /** Aborts an install that has not reached commit and resolves once it has settled. */
  cancelInstall(): Promise<UpdateControllerState>
  /** Publishes `install-failed` with `message` (generic copy if unsafe), keeping the download. */
  refuseInstall(message: string): UpdateControllerState
  /**
   * Republishes the offer when `isInstallPermitted()` changed its
   * `installPermitted`; otherwise returns the state. After `refuseInstall()`, a
   * window that may install again gets its `verified` download back.
   */
  refreshInstallPermission(): UpdateControllerState
  /** True from installNow()'s first synchronous step until it settles, and forever after a commit. */
  isInstalling(): boolean
  /** The verified file while the state is 'verified' or 'install-failed'; null otherwise. Main-process only. */
  getVerifiedArtifact(): VerifiedArtifact | null
  dispose(): void
}

export function createUpdateController(options: {
  currentVersion: string
  preferences: UpdatePreferencesStore
  /** Persists the rollback high-water mark; without it the mark lasts only for this process. */
  trustState?: UpdateTrustStateStore
  checker(input: UpdateCheckerInput): Promise<UpdateCheckResult>
  notifier(notification: UpdateNotification): Promise<unknown> | unknown
  downloader?: Pick<UpdateDownloader, 'normalize' | 'download' | 'cancel' | 'prune'>
    & Partial<Pick<UpdateDownloader, 'openVerified'>>
  /**
   * A strategy without an installer stays download-only. Registering any
   * installer requires `downloader.openVerified` and `requestRestart`.
   */
  installers?: Partial<Record<DownloadableInstallStrategy, PlatformInstaller>>
  /**
   * Records each attempt just before commit() (an attempt that cannot be
   * recorded is not handed off) and is read once by the first rendererReady(),
   * before any cleanup, to report an install that did not take effect.
   */
  attemptStore?: Pick<InstallAttemptStore, 'begin' | 'abandon' | 'take'>
  /** Called once when the previous attempt left this app on its old version. */
  notifyInstallFailure?: (report: InstallFailureReport) => Promise<unknown> | unknown
  /** Consulted synchronously when an install starts; an install is refused while it returns true. */
  isSetupRunning?: () => boolean
  /** True once the app has begun to quit (main's beginAppQuit()); no new install starts then. */
  isQuitting?: () => boolean
  /**
   * Whether main would accept its window's install request now (#216); read on
   * every publish into `available.installPermitted`. Defaults to always; a
   * throw counts as not permitted.
   */
  isInstallPermitted?: () => boolean
  /** Called once, right after a commit resolves; main quits so the helper can swap the app. */
  requestRestart?: () => void
  clock?: () => Date
  setTimeoutImpl?: (
    callback: () => void | Promise<void>,
    delay: number,
  ) => unknown
  clearTimeoutImpl?: (timer: any) => void
  random?: () => number
  initialDelayMs?: number
  jitterRatio?: number
  emit?: (state: UpdateControllerState) => void
}): UpdateController
