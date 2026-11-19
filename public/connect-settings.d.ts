// Types for public/connect-settings.js (#617 PR 3c): Settings → Use another Mac's Inbox.
export interface ConnectBridge {
  view(): Promise<unknown>
  connect(input: { address: string; code: string; replace?: boolean }): Promise<unknown>
  forget(id: string): Promise<unknown>
  show(id: string | null): Promise<unknown>
  onChange(callback: () => void): () => void
  /** #617 PR 4b: proposes the Open desk command ('' removes it); main stores it only after its native dialog */
  setDeskCommand?(input: { id: string; command: string }): Promise<unknown>
  /** #637: the connected Mac's update, by its id (electron/hub-update.cjs) */
  hubUpdate?(id: string): Promise<unknown>
  /** #637: asks the connected Mac to install the release its own update controller verified */
  updateHub?(id: string): Promise<unknown>
}
export interface DeskBridge {
  connection(): Promise<unknown>
  onConnection?(callback: (value: unknown) => void): () => void
  available?(): Promise<unknown>
  /** #617 PR 4b: the hub view's Open desk (electron/remote-preload.cjs) */
  open?(request: { session: string }): Promise<unknown>
}

/** One word per connection state: Online, Connecting…, Reconnecting…, Not connected, Checking…; shared with the strip. */
export function stateWord(hub: { state?: unknown; reason?: unknown } | null | undefined): string

/** The hub's pairing-code rule (normaliseCode in src/remote-pair.ts and electron/remote-connect-rules.cjs). */
export function normaliseCode(text: unknown): string | null

/**
 * Draws the section only where `connect` exists and `desk().connection()` answers `{ mode: 'local' }`;
 * null, with nothing drawn, without the bridge.
 */
export function renderConnectSettings(
  host: Element,
  opts?: {
    connect?: () => ConnectBridge | null | undefined
    desk?: () => DeskBridge | null | undefined
    documentRef?: Document
    platform?: () => string
    /** #637: how a follow-up read of the other Mac's update is scheduled (setTimeout by default) */
    schedule?: (fn: () => void, ms: number) => unknown
  },
): HTMLElement | null

/** Asks main for the section again (Settings opening). */
export function refreshConnectSettings(): Promise<unknown>
