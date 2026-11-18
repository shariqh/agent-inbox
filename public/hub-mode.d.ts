// Types for public/hub-mode.js (#617 PR 3c): the page when another Mac shows it.
import type { DeskBridge } from './connect-settings.js'

export interface HubMode {
  ready(): Promise<void>
  local(): boolean
  renderSettingsNote(host: Element): HTMLElement
}
export function installHubMode(opts?: { desk?: () => DeskBridge | null | undefined; documentRef?: Document }): HubMode
