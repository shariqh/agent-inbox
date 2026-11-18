// Types for public/connect-settings.js (#617 PR 3c): Settings → Use another Mac's Inbox.
export interface ConnectBridge {
  view(): Promise<unknown>
  connect(input: { address: string; code: string; replace?: boolean }): Promise<unknown>
  forget(id: string): Promise<unknown>
  show(id: string | null): Promise<unknown>
  onChange(callback: () => void): () => void
}
export interface DeskBridge {
  connection(): Promise<unknown>
  onConnection?(callback: (value: unknown) => void): () => void
  available?(): Promise<unknown>
}

/** One word per connection state: Online, Connecting…, Reconnecting…, No longer paired, Checking…; shared with the strip. */
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
  },
): HTMLElement | null

/** Asks main for the section again (Settings opening). */
export function refreshConnectSettings(): Promise<unknown>
