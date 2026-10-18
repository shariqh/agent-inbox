import type {
  UpdateArtifact,
  UpdateCheckResult,
  UpdateRendererState,
  VerifiedAvailableUpdate,
} from './update-fetch.cjs'
import type {
  UpdateDownloader,
  VerifiedArtifact,
} from './update-download.cjs'
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

export interface OfferedUpdate extends VerifiedAvailableUpdate {
  /** True only for a pinned macos-dmg/appimage-self-replace artifact; deb-notify never downloads. */
  downloadable: boolean
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
  /** The verified file while the state is 'verified'; null otherwise. Main-process only. */
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
