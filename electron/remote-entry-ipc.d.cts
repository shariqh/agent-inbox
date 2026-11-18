// Type declarations for electron/remote-entry-ipc.cjs (#617, PR 2d): Settings → Other devices, main's half.
import type { ListenError, RemoteChanges, RemoteEntryController, StopReason } from './remote-entry.cjs'

export const CHANNELS: Readonly<{
  get: 'agent-inbox:remote-entry'
  turnOn: 'agent-inbox:remote-entry-turn-on'
  turnOff: 'agent-inbox:remote-entry-turn-off'
  removeDevice: 'agent-inbox:remote-entry-remove-device'
  clearUnreadable: 'agent-inbox:remote-entry-clear-unreadable'
  repairPermissions: 'agent-inbox:remote-entry-repair'
  acknowledge: 'agent-inbox:remote-entry-acknowledge'
  test: 'agent-inbox:remote-entry-test'
  addDevice: 'agent-inbox:remote-entry-add-device'
  setOpenAtLogin: 'agent-inbox:remote-entry-open-at-login'
  turnOnRemovingDevices: 'agent-inbox:remote-entry-turn-on-remove-devices'
  recheck: 'agent-inbox:remote-entry-recheck'
}>
export const CHANGED: 'agent-inbox:remote-entry-changed'

export type Unavailable = { available: false; reason?: 'unsupported' | 'unowned' }
export type Answer = { ok: true; [field: string]: unknown } | { ok: false; reason: string; step?: string; rose?: string | null; devices?: number }

/** What the panel draws: never a login, a secret hash, the owner token, a code's id or a raw Tailscale answer. */
export interface PanelView {
  available: true
  enabled: boolean
  host: string | null
  port: number
  devices: Array<{ id: string; label: string; pairedAt: string | null }>
  unreadableDevices: number
  problem: string | null
  flag: boolean
  digest: string | null
  wanted: boolean
  stopped: { reason: string; willResume: boolean } | null
  resume: { waiting: string; nextAt: number | null } | null
  needsOwner: 'identity_changed' | null
  stateSaved: boolean | null
  serve: { ok: true } | { ok: false; reason: string | null } | null
  removalHint: string | null
  command: string
  loginItem: { available: boolean; openAtLogin: boolean; needsApproval: boolean }
  /** the viewer's last status said it listens on this build's port; false when that read failed */
  listening: boolean
  /** the viewer's bind failure for this port (review round 1, item 3) */
  listenError: ListenError | null
  /** while flagged: what changed, as facts (review round 1, item 7) */
  changes: RemoteChanges | null
  /** the last refused switch-on, until a later operation works or the state changes (item 4) */
  refusal: { reason: string; step: string | null; devices: number | null; at: number } | null
}

export interface LoginItem {
  read(): { available: boolean; openAtLogin: boolean; needsApproval: boolean }
  set(value: unknown): { ok: true; openAtLogin: boolean } | { ok: false; reason: 'unavailable' | 'failed' }
}

export interface RemoteEntryPanel {
  get(): Promise<PanelView>
  turnOn(): Promise<Answer>
  turnOff(): Promise<Answer>
  removeDevice(id: string): Promise<Answer>
  clearUnreadable(): Promise<Answer>
  repairPermissions(): Promise<Answer>
  acknowledge(digest: string): Promise<Answer>
  test(): Promise<Answer>
  addDevice(): Promise<Answer>
  setOpenAtLogin(value: boolean): Promise<Answer>
  turnOnRemovingDevices(): Promise<Answer>
  recheck(): Promise<{ ok: true }>
}

export function registerRemoteEntryIpc(options: {
  ipcMain: { handle(channel: string, handler: (event: never, ...args: never[]) => unknown): unknown }
  platform: string
  panel: () => RemoteEntryPanel | null
  settled: () => Promise<unknown>
  isTrusted: (event: never) => boolean
  isOwned: (event: never) => boolean
}): void

export function createRemoteEntryPanel(options: {
  controller: Pick<RemoteEntryController, 'port' | 'entryStatus' | 'recheckHint' | 'review' | 'state' | 'turnOn' | 'turnOff' | 'removeDevice' | 'clearUnreadable' | 'repairPermissions' | 'acknowledge' | 'selfTest' | 'requestCode'> | Record<string, unknown>
  loginItem: LoginItem | { read(): unknown; set(value: boolean): unknown }
  changed?: () => void
  now?: () => number
}): RemoteEntryPanel

type Words = { reasonFamily(kind: string, reason: unknown, step?: unknown): string; familyWords(family: string): { why: string } }
export function createRemoteNotifier(options: {
  show: (note: { title: string; body: string }) => void
  words: Words | Promise<Words>
  changed?: () => void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}): {
  /** the app started: a pause in the next 2 minutes is held */
  started(): void
  onStopped(reason: StopReason | string, detail: { off: boolean; willResume: boolean }): void
  onResumed(): void
  onPaired(label: string): void
  onOutsideChange(): void
}

export function loginItemFor(options: {
  app: { isPackaged: boolean; getLoginItemSettings(): { openAtLogin: boolean }; setLoginItemSettings(settings: { openAtLogin: boolean }): void }
  platform: string
}): LoginItem

/** stop(), then settled() waited for at most 5 seconds. */
export function stopRemoteEntry(
  controller: { stop(): void; settled(): Promise<void> } | Record<string, unknown>,
  options?: { setTimeout?: (fn: () => void, ms: number) => unknown },
): Promise<void>

export function watchRemoteEntry(options: {
  panel: { get(): Promise<unknown> }
  changed: () => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}): { stop(): void }
