// Type declarations for electron/remote-entry-state.cjs (#617, PR 2e): the state the hub's
// remote-entry controller keeps across restarts, in userData `remote-entry-state.json`.
import type { UpdatePreferencesFs } from './update-preferences.cjs'

/** What the controller keeps: the digest of the last remote.json state it wrote or accepted, and the owner's intent. */
export interface RemoteEntryStoredState {
  /** SHA-256 hex, or null when none is kept yet */
  digest: string | null
  /** the owner switched the entry on and has not switched it off since */
  wanted: boolean
}

/** The store the controller takes as `stateStore`. Both may reject; the controller copes. */
export interface RemoteEntryStateStore {
  /** the kept state, or null for none (no file, a bad file, or a newer schema) */
  read(): Promise<RemoteEntryStoredState | null>
  /** rejects on a newer schema (never overwritten) or a failed write */
  write(state: RemoteEntryStoredState): Promise<void>
}

/** `{ digest, wanted }` when both are the right shape, else null (the controller checks what any store returns). */
export function storedState(value: unknown): RemoteEntryStoredState | null

export function createRemoteEntryState(options:
  | { filePath: string; fsImpl?: UpdatePreferencesFs }
  | { app: { getPath(name: 'userData'): string }; filename?: string; fsImpl?: UpdatePreferencesFs }
): RemoteEntryStateStore
