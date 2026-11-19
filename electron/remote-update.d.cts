// Type declarations for electron/remote-update.cjs (#637): main's half of updating the hub from the
// connecting Mac. Runtime lives in the .cjs.

export type UpdateStatus = 'current' | 'checking' | 'available' | 'downloading' | 'installing' | 'failed'
export type UpdateRefusal = 'setup_running' | 'installing' | 'not_here' | 'nothing_newer' | 'busy'

export interface UpdateSummary {
  current: string
  status: UpdateStatus
  newer: string | null
  canStart: boolean
  reason: UpdateRefusal | null
}

/** How often main reports to its viewer, in milliseconds. */
export const REPORT_EVERY_MS: number

/** What a paired device may see of this hub's update, from the controller's state and main's gates. */
export function updateSummary(input: {
  state: unknown
  version: string
  setupRunning: boolean
  quitting: boolean
  installing: boolean
  running: boolean
}): UpdateSummary

export interface RemoteUpdateLink {
  /** one report to the viewer, and what its answer asks for; never rejects */
  sync(): Promise<void>
  /** the controller's state changed: report again */
  changed(): void
  /** resolves once a remote update this link started has settled */
  settled(): Promise<unknown>
  start(): void
  stop(): void
}

export function createRemoteUpdateLink(options: {
  controller: () => unknown
  version: string
  /** the owned viewer's loopback base, with a trailing slash */
  base: string
  ownerToken: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  setupRunning: () => boolean
  quitting: () => boolean
  deviceLabel: (id: string) => Promise<string | null> | string | null
  notify: (notice: { label: string | null; version: string }) => void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}): RemoteUpdateLink
