export interface UpdatePreferences {
  schema: 1
  automaticChecks: boolean
  lastNotifiedVersion: string | null
}

export interface UpdatePreferencesStore {
  read(): Promise<UpdatePreferences>
  setAutomatic(automaticChecks: boolean): Promise<UpdatePreferences>
  setLastNotifiedVersion(lastNotifiedVersion: string): Promise<UpdatePreferences>
}

export interface UpdatePreferencesFs {
  readFile(path: string): Promise<string | Buffer>
  writeFile(path: string, data: string, options: {
    encoding: 'utf8'
    mode: number
    flag: 'wx'
  }): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  unlink(path: string): Promise<unknown>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
}

export function createUpdatePreferences(options:
  | {
      filePath: string
      fsImpl?: UpdatePreferencesFs
    }
  | {
      app: { getPath(name: 'userData'): string }
      filename?: string
      fsImpl?: UpdatePreferencesFs
    }
): UpdatePreferencesStore

/** Rollback high-water mark (#148), kept in userData `update-trust-state.json`. */
export interface UpdateTrustState {
  /** Highest release version whose signed manifest verified; null until the first one. */
  highestVerifiedVersion: string | null
}

export interface UpdateTrustStateStore {
  read(): Promise<UpdateTrustState>
  /** Raises the mark when `version` is higher; never lowers it or rewrites a newer schema. */
  recordVerifiedVersion(version: string): Promise<UpdateTrustState>
}

export function createUpdateTrustState(options:
  | {
      filePath: string
      fsImpl?: UpdatePreferencesFs
    }
  | {
      app: { getPath(name: 'userData'): string }
      filename?: string
      fsImpl?: UpdatePreferencesFs
    }
): UpdateTrustStateStore
