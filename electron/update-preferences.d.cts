export interface UpdatePreferences {
  schema: 1
  automaticChecks: boolean
  lastNotifiedVersion: string | null
  /** Highest release version whose signed manifest verified here; absent until the first one. */
  highestVerifiedVersion?: string
}

export interface UpdatePreferencesStore {
  read(): Promise<UpdatePreferences>
  setAutomatic(automaticChecks: boolean): Promise<UpdatePreferences>
  setLastNotifiedVersion(lastNotifiedVersion: string): Promise<UpdatePreferences>
  /** Raises the high-water mark to `version` when higher; never lowers it. */
  recordVerifiedVersion(version: string): Promise<UpdatePreferences>
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
