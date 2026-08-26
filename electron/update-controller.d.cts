import type {
  UpdateRendererState,
  VerifiedAvailableUpdate,
} from './update-fetch.cjs'
import type {
  UpdatePreferences,
  UpdatePreferencesStore,
} from './update-preferences.cjs'

export type {
  UpdatePreferences,
  UpdateRendererState,
  VerifiedAvailableUpdate,
}

export const MANUAL_RELEASES_URL: 'https://github.com/shariqh/agent-inbox/releases'

export interface UpdateNotification {
  version: string
  tag: string
  releaseUrl: string
}

export interface UpdateCheckerInput {
  currentVersion: string
  automaticChecks: boolean
}

export interface UpdateController {
  getState(): UpdateRendererState
  rendererReady(): Promise<UpdateRendererState>
  checkNow(): Promise<UpdateRendererState>
  runScheduledCheck(): Promise<UpdateRendererState>
  setAutomaticChecks(automaticChecks: boolean): Promise<UpdateRendererState>
  refreshSchedule(): Promise<UpdateRendererState>
  dispose(): void
}

export function createUpdateController(options: {
  currentVersion: string
  preferences: UpdatePreferencesStore
  checker(input: UpdateCheckerInput): Promise<UpdateRendererState>
  notifier(notification: UpdateNotification): Promise<unknown> | unknown
  clock?: () => Date
  setTimeoutImpl?: (
    callback: () => void | Promise<void>,
    delay: number,
  ) => unknown
  clearTimeoutImpl?: (timer: any) => void
  random?: () => number
  initialDelayMs?: number
  jitterRatio?: number
  emit?: (state: UpdateRendererState) => void
}): UpdateController
