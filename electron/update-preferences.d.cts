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

/** Which signed manifest a version was verified in: update-manifest.json or update-manifest-v2.json (#343). */
export type UpdateManifestName = 'v1' | 'v2'

/** Rollback high-water marks (#148), one per manifest (#343), in userData `update-trust-state.json`. */
export interface UpdateTrustState {
  /** Highest version verified in update-manifest.json; the only mark apps from 1.3 to 1.6 know. */
  highestVerifiedVersion: string | null
  /** Highest version verified in update-manifest-v2.json; null until the first one. */
  highestVerifiedVersionV2: string | null
}

export interface UpdateTrustStateStore {
  read(): Promise<UpdateTrustState>
  /**
   * Raises the mark of the manifest `version` verified in when it is higher; never lowers
   * either mark, touches the other, or rewrites a newer schema. Resolves both marks.
   */
  recordVerifiedVersion(version: string, manifest: UpdateManifestName): Promise<UpdateTrustState>
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

/** One userData JSON file behind a cross-process lock, written by temp file and rename (#300 reuses it). */
export interface LockedFile {
  readBytes(): Promise<string | Buffer | null>
  atomicWrite(value: unknown): Promise<void>
  mutate<T>(operation: () => Promise<T>): Promise<T>
  settled(): Promise<unknown>
}

export function createLockedFile(filePath: string, fsImpl: UpdatePreferencesFs): LockedFile

export function resolveFilePath(
  options: { filePath?: string; app?: { getPath(name: 'userData'): string }; filename?: string },
  defaultFilename: string,
): string
