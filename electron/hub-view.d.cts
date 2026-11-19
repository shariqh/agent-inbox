// Type declarations for electron/hub-view.cjs (#617, PR 3b): the hub's page in its own sealed-off
// view on the connecting Mac, and the IPC that view and the local page may use. Runtime lives in
// the .cjs.
import type { Connection, RemoteConnect } from './remote-connect.cjs'
import type { DeskOpen } from './desk-open.cjs'

export const INPUT_WINDOW_MS: 5000
/** #617 PR 3c: the strip's height in the local page's CSS pixels; the view starts insetFor(zoom) window pixels below the top. */
export const HUB_STRIP_HEIGHT: 36
/** The view's top inset in window pixels: HUB_STRIP_HEIGHT times the local page's zoom factor, rounded (1 for a bad factor). */
export function insetFor(zoom: unknown): number
export interface ZoomMenuItem { label: string; accelerator: string; click: () => void }
/** Actual Size, Zoom In and Zoom Out for the focused contents, each then calling `after`. */
export function zoomMenuItems(input: {
  focused: () => { getZoomLevel(): number; setZoomLevel(level: number): void; isDestroyed?(): boolean } | null
  after: () => void
}): ZoomMenuItem[]
export const DESK_CHANNELS: Readonly<{
  connection: 'agent-inbox:desk-connection'; retry: 'agent-inbox:desk-retry'
  /** #617 PR 4b */
  available: 'agent-inbox:desk-available'; open: 'agent-inbox:desk-open'
  changed: 'agent-inbox:desk-changed'
}>
export const CONNECT_CHANNELS: Readonly<{
  view: 'agent-inbox:connect-view'; connect: 'agent-inbox:connect-connect'; forget: 'agent-inbox:connect-forget'; show: 'agent-inbox:connect-show'
  /** #617 PR 4b */
  deskCommand: 'agent-inbox:connect-desk-command'
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
  /**
   * `busy`: the hub's page closed its own view more than 3 times in a minute. `not_owned`: this
   * window's page is not the one the app owns, so it could not draw the strip. `not_ready`: no view
   * exists or is being built for it (one is started).
   */
  show(id: unknown): { ok: true; showing: string | null } | { ok: false; reason: 'bad_id' | 'not_found' | 'destroyed' | 'busy' | 'not_owned' | 'not_ready' }
  /** The id of the hub whose view is really on top, or null: never one being built. */
  current(): string | null
  /** Whether the hub may be shown now: `mayShow()`. */
  canShow(): boolean
  /** Call when the local page gains or loses the binding; This Mac comes forward when it is lost. */
  ownerChanged(): void
  /** Reloads the hub page when one is loaded. */
  reload(): void
  /** Closes the view; its partition's storage stays (a forget clears it). */
  destroy(): void
  /** Sizes the view to the window's content area below insetFor(the local page's zoom factor). */
  layout(): void
  /** Writes the partition's storage to disk (before quit). */
  flush(): void
  /** Resolves when the partitions being cleared (after a forget or a replace, or at start) are cleared, or after 5 seconds. */
  cleared(): Promise<void>
  /** Checks the node and probes now; loads the hub page when it is online. */
  retry(): Promise<{ ok: boolean }>
  /**
   * #617 PR 4a: sets `location.hash` in the hub's page, only when `id` is the active hub, its view is
   * alive, the hub's own page (not the offline file) is loaded, and `hash` is one item link
   * (`#item/<1–200 of A-Z a-z 0-9 % . _ ~ ->`). Anything else does nothing.
   */
  land(id: unknown, hash: unknown): { ok: boolean }
  /** `trustedDeskSender` for the active view. */
  trusts(event: unknown): 'hub' | 'offline' | null
  /**
   * #617 PR 4b: the active hub's id when `event` is from its view's top frame on the hub's page, the
   * view is focused and its last key press or click is under 5 seconds old; that input is used up.
   * Else null, and nothing is used up.
   */
  takeGesture(event: unknown): string | null
  /** #617 PR 4b: sends the hub's page the empty change message, so it asks again (after the Open desk command changed). */
  pageChanged(): void
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
  /** The one guard for showing the hub: true only while this window's page is the one the app owns. False when absent. */
  mayShow?: () => boolean
  /** The view's opaque background, set before it is added (this window's own). */
  backgroundColor?: () => string
}
export function createHubView(options: HubViewOptions): HubView

export interface HubIpcOptions {
  ipcMain: { handle(channel: string, listener: (event: never, ...args: never[]) => unknown): void }
  settled: () => Promise<unknown>
  isOwned: (event: never) => boolean
  connect: () => RemoteConnect | null
  hubView: () => HubView | null
  /** #617 PR 4b: Open desk's handler (electron/desk-open.cjs), or null; null when left out. */
  deskOpen?: () => DeskOpen | null
}
export function registerHubIpc(options: HubIpcOptions): void
