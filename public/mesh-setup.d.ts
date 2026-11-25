/** The mesh bridge's shape as the page uses it (electron/setup-preload.cjs, `agentInboxMesh`). */
export interface MeshBridge {
  available(): Promise<{ available: true } | { available: false; reason: string }>
  run(operation: string, values: Record<string, string | boolean>): Promise<Record<string, any>>
  chooseFile(purpose: 'key' | 'token'): Promise<{ ok: true; handle: string; name: string } | { ok: false; reason: string }>
}

export function installMeshSetup(deps: {
  doc?: Document
  /** the local window's bridge, or null (a browser, another Mac's page) */
  bridge: () => MeshBridge | null | undefined
  /** resolves to whether the page is this Mac's own */
  local: () => Promise<boolean>
  /** the tab's home, its set-up page slot and the agent's page */
  home: () => HTMLElement | null
  setupPage: () => HTMLElement | null
  agentPage: () => HTMLElement | null
  /** the tab's panel, where focus is kept after an operation */
  panel: () => HTMLElement | null
  /** where focus goes when the control that opened a page is gone */
  heading: () => HTMLElement | null
  /** whether the Agent cards tab is the current one */
  active: () => boolean
  /** repaint the tab from the module's state */
  changed: () => void
  /** ask the tab's data again after something changed */
  reload: () => void
  /** an agent was turned on: show its own page */
  turnedOn: (name: string) => void
  /** the open agent was turned off or removed: back to the tab's home */
  turnedOff: () => void
  /** an agent was added by its card address: show its own page */
  added: (id: string) => void
  /** check this one agent now, as its page's Refresh does */
  check: (name: string) => void
  /** show the page from its top: a set-up page that opens does not keep the scroll it was opened from */
  toTop: () => void
}): {
  usable(): boolean
  refreshAvailable(): Promise<boolean>
  entered(): Promise<void>
  open(): boolean
  title(): string | null
  back(): boolean
  paint(input: { body: any; agent: { name: string; added?: boolean } | null }): void
  state(): number
}
