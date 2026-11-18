// Types for public/hub-strip.js (#617 PR 3c): the strip this Mac's page draws while another Mac's Inbox is on screen.
import type { ConnectBridge, DeskBridge } from './connect-settings.js'

/** The strip's height in CSS pixels: electron/hub-view.cjs lays the hub's view out this far below the top. */
export const HUB_STRIP_HEIGHT: number

/** Null, with nothing drawn, without the bridge; draws only where `desk().connection()` answers `{ mode: 'local' }`. */
export function installHubStrip(opts?: {
  connect?: () => ConnectBridge | null | undefined
  desk?: () => DeskBridge | null | undefined
  documentRef?: Document
}): { refresh(): Promise<unknown> } | null
