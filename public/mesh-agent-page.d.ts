import type { MeshAgentsInput } from './mesh-section.js'

export interface MeshRunsInput {
  /** the agent the runs body was read for */
  key: string
  body: any
  stale: boolean
}

export function installMeshAgentPage(deps: {
  doc?: Document
  /** the page's element inside the Agent cards tab */
  page: () => HTMLElement | null
  wireTablist?: (host: Element, orientation: string) => void
  /** the page's Refresh, for its agent */
  onRefresh?: (name: string) => void
  /** "← Agent cards": back to the grid */
  onBack?: () => void
}): {
  /** paints the open agent's page from the last bodies; nothing while no agent is open */
  paint(input: MeshAgentsInput | { body: any; stale: boolean } | null, nowMs: number, runsInput?: MeshRunsInput | null): void
  /** opens `key` in the one slot, replacing any other; each open starts on Run history. `pending`: just turned on, not yet read */
  open(key: string, name: string, opts?: { pending?: boolean }): void
  close(): void
  /** the open agent, or null */
  current(): { key: string; name: string; pending?: boolean } | null
  /** whether Run history is the inner tab showing: the runs read's gate */
  runsShowing(): boolean
  /** the window-local page state, for frameInputs() */
  state(): string
}
