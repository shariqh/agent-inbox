import type {
  UpdateArtifact,
  UpdateCheckResult,
  UpdateRendererState,
  VerifiedAvailableUpdate,
} from './update-fetch.cjs'
import type {
  DownloadableInstallStrategy,
  UpdateDownloader,
  VerifiedArtifact,
} from './update-download.cjs'
import type { PlatformInstaller } from './update-install.cjs'
import type {
  UpdatePreferences,
  UpdatePreferencesStore,
  UpdateTrustStateStore,
} from './update-preferences.cjs'

export type {
  UpdateArtifact,
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
   * Plain-language reason, without any path, that a registered installer cannot
   * install this offer here. Present only on such notify-only offers.
   */
  reason?: string
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
}

export interface UpdateNotification {
  version: string
  tag: string
  releaseUrl: string
  downloadable: boolean
  installable: boolean
}

export interface UpdateCheckerInput {
  currentVersion: string
  automaticChecks: boolean
  /** Records a just-verified release, saves the session's highest one, and resolves the rollback high-water mark. */
  recordVerifiedVersion(version: string): Promise<string | null>
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
  /** Consulted synchronously when an install starts; an install is refused while it returns true. */
  isSetupRunning?: () => boolean
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
