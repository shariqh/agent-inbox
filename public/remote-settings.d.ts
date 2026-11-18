// Types for public/remote-settings.js (#617, PR 2d).
export interface RemoteEntryBridge {
  get(): Promise<unknown>
  turnOn(): Promise<unknown>
  turnOff(): Promise<unknown>
  removeDevice(id: string): Promise<unknown>
  clearUnreadable(): Promise<unknown>
  repairPermissions(): Promise<unknown>
  acknowledge(digest: string): Promise<unknown>
  test(): Promise<unknown>
  addDevice(): Promise<unknown>
  setOpenAtLogin(on: boolean): Promise<unknown>
  onChange(callback: (() => void) | null): boolean
}

/** Settings → Other devices; null, with nothing drawn, without the desktop bridge. */
export function renderRemoteSettings(
  host: Element,
  opts?: { bridge?: () => RemoteEntryBridge | null | undefined; documentRef?: Document },
): HTMLElement | null

/** Asks main for the section again (Settings opening); null when nothing is shown. */
export function refreshRemoteSettings(): Promise<unknown>
