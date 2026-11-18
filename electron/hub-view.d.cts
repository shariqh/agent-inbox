// Type declarations for electron/hub-view.cjs (#617, PR 3b): the hub's page in its own sealed-off
// view on the connecting Mac, and the IPC that view and the local page may use. Runtime lives in
// the .cjs.
import type { Connection, RemoteConnect } from './remote-connect.cjs'

export const INPUT_WINDOW_MS: 5000
export const DESK_CHANNELS: Readonly<{ connection: 'agent-inbox:desk-connection'; retry: 'agent-inbox:desk-retry'; changed: 'agent-inbox:desk-changed' }>
export const CONNECT_CHANNELS: Readonly<{
  view: 'agent-inbox:connect-view'; connect: 'agent-inbox:connect-connect'; forget: 'agent-inbox:connect-forget'; show: 'agent-inbox:connect-show'
  changed: 'agent-inbox:connect-changed'
}>

/** `persist:hub-<id>` for an 8-hex id; throws for anything else. */
export function partitionFor(id: unknown): string
/** The headers to send: every device header the page set removed, then the one `deviceHeaderFor(details.url)` answers, if any. */
export function sendHeaders(
  details: { url?: unknown; requestHeaders?: Record<string, string | string[]> } | null | undefined,
  deviceHeaderFor: (url: unknown) => string | null,
): Record<string, string | string[]>
/** An `https` URL on the hub's exact origin, or the shipped offline file's exact `file:` URL. */
export function allowNavigation(url: unknown, origin: unknown, offlineUrl: unknown): boolean
/** Only `clipboard-sanitized-write`, only for the hub origin's top frame. */
export function allowPermission(permission: unknown, requestingUrl: unknown, origin: unknown, isMainFrame: unknown): boolean
/** The view has focus and its last input event is under 5 seconds old. */
export function mayOpenExternally(input: { focused: unknown; lastInputAt: unknown; now: unknown }): boolean
/** Whether an IPC event comes from the hub view's top frame on the hub origin (`hub`) or on the offline file (`offline`). */
export function trustedDeskSender(event: unknown, view: unknown, origin: unknown, offlineUrl: unknown): 'hub' | 'offline' | null

export interface DeskConnection { mode: 'hub'; label: string; state: 'online' | 'retrying' | 'refused'; version: string | null }
/** What the hub view may learn of the connection: label, state and version, nothing else. */
export function deskConnection(connection: unknown): DeskConnection | null
/** `Agent Inbox`, or `Agent Inbox — <label>` while the hub view is on top. */
export function windowTitle(connection: Connection | null | undefined, showing: string | null): string
export interface HubMenuItem { label: string; type: 'radio'; checked: boolean; click: () => void }
/** The View menu's This Mac and <label> pair, or none with no hub. */
export function hubMenuItems(input: { connection: Connection | null | undefined; showing: string | null; show: (id: string | null) => unknown }): HubMenuItem[]
/** Calls `onBack` when `isOnline()` turns from false to true, read every `intervalMs` (10 s by default). */
export function watchOnline(input: {
  isOnline: () => boolean
  onBack: () => void
  setInterval?: (fn: () => void, ms: number) => unknown
  intervalMs?: number
}): unknown

export interface HubView {
  /** Puts the hub view (its id) or This Mac (null) on top. */
  /** `busy`: the hub's page closed its own view more than 3 times in a minute. */
  show(id: unknown): { ok: true; showing: string | null } | { ok: false; reason: 'bad_id' | 'not_found' | 'destroyed' | 'busy' }
  /** The id of the hub shown on top, or null for This Mac. */
  current(): string | null
  /** Reloads the hub page when one is loaded. */
  reload(): void
  /** Closes the view; its partition's storage stays (a forget clears it). */
  destroy(): void
  /** Sizes the view to the window's content area. */
  layout(): void
  /** Writes the partition's storage to disk (before quit). */
  flush(): void
  /** Resolves when the partitions being cleared (after a forget or a replace, or at start) are cleared, or after 5 seconds. */
  cleared(): Promise<void>
  /** Checks the node and probes now; loads the hub page when it is online. */
  retry(): Promise<{ ok: boolean }>
  /** `trustedDeskSender` for the active view. */
  trusts(event: unknown): 'hub' | 'offline' | null
}

export interface HubViewOptions {
  window: unknown
  session: unknown
  WebContentsView: unknown
  connect: Pick<RemoteConnect, 'connection' | 'onConnection' | 'view' | 'deviceHeaderFor' | 'kick'>
  openWebLink: (url: string) => unknown
  offlineFile: string
  preload: string
  now?: () => number
  onChange?: () => void
  /** A packaged app closes developer tools as soon as they open on the hub view; true by default. */
  isPackaged?: boolean
  /** The names in the profile's Partitions folder; every hub-<8 hex> one but the stored hub's is cleared at start. */
  readPartitions?: () => string[]
  setTimeout?: (fn: () => void, ms: number) => unknown
}
export function createHubView(options: HubViewOptions): HubView

export interface HubIpcOptions {
  ipcMain: { handle(channel: string, listener: (event: never, ...args: never[]) => unknown): void }
  settled: () => Promise<unknown>
  isOwned: (event: never) => boolean
  connect: () => RemoteConnect | null
  hubView: () => HubView | null
}
export function registerHubIpc(options: HubIpcOptions): void
