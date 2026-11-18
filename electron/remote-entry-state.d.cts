// Type declarations for electron/remote-entry-state.cjs (#617, PR 2e): the state the hub's
// remote-entry controller keeps across restarts, in userData `remote-entry-state.json`.
import type { UpdatePreferencesFs } from './update-preferences.cjs'

/** What `digest` holds while a review is due: no remote.json state has it. */
export const PENDING: 'pending'

/** What the controller keeps, and what it is for. */
export interface RemoteEntryStoredState {
  /** SHA-256 hex of the last remote.json state main wrote or accepted; PENDING while a review is due or a write is under way; null for none */
  digest: string | null
  /** the owner switched the entry on and has not switched it off since */
  wanted: boolean
  /** SHA-256 hex of remote.json's absolute path */
  file: string
  /** the viewer this state is for (the checkout build and the installed app share userData) */
  viewerPort: number
}

/** The store the controller takes as `stateStore`. Both may reject; the controller waits at most 5 seconds for either. */
export interface RemoteEntryStateStore {
  /** the kept state, or null for none (no file, a bad file, not a regular file this user owns, or a newer schema) */
  read(): Promise<RemoteEntryStoredState | null>
  /**
   * Rejects on a newer schema (never overwritten) or a failed write. Never raises `wanted` from false
   * (or none, or another file's or viewer's state) to true unless `allowRaise`; answers what it wrote.
   */
  write(state: RemoteEntryStoredState, how?: { allowRaise?: boolean }): Promise<{ wanted: boolean } | void>
}

/** The state's shape checked, else null (the controller checks what any store returns). */
export function storedState(value: unknown): RemoteEntryStoredState | null
/** What a state names for remote.json: the SHA-256 of its absolute path. */
export function fileId(file: string): string

export function createRemoteEntryState(options:
  | { filePath: string; fsImpl?: UpdatePreferencesFs & { open: (...args: never[]) => Promise<unknown> }; uid?: number }
  | { app: { getPath(name: 'userData'): string }; filename?: string; fsImpl?: UpdatePreferencesFs & { open: (...args: never[]) => Promise<unknown> }; uid?: number }
): RemoteEntryStateStore
