// Type declarations for electron/hub-update.cjs (#637): the connecting Mac's half of updating the
// hub from here. Runtime lives in the .cjs.

export type HubUpdatePhase = 'idle' | 'updating' | 'restarting' | 'done' | 'failed' | 'not_back' | 'offline' | 'old_hub' | 'unreadable'

export type HubUpdateState =
  | {
    ok: true
    phase: HubUpdatePhase
    /** the hub's running version, as last seen */
    version: string | null
    status: 'current' | 'checking' | 'available' | 'downloading' | 'installing' | 'failed' | null
    newer: string | null
    canStart: boolean
    reason: 'setup_running' | 'installing' | 'not_here' | 'nothing_newer' | 'busy' | 'not_ready' | null
  }
  | { ok: false; reason: 'not_found' | 'failed' }

export type HubUpdateStart = { ok: true } | { ok: false; reason: string }

/** How long the hub may stay away after a start before this Mac says it did not come back. */
export const NOT_BACK_MS: number

export interface HubUpdate {
  state(id: string): Promise<HubUpdateState>
  start(id: string): Promise<HubUpdateStart>
}

export function createHubUpdate(options: {
  connect: () => {
    connection(): Record<string, unknown>
    hubBase(id: string): string | null
    hubFetch(): (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<Response>
    kick(): Promise<unknown>
  } | null
  now?: () => number
}): HubUpdate
