export interface MeshAgentsInput {
  /** the last `/api/mesh/agents` body */
  body: { on: boolean; agents: Array<Record<string, any>>; others?: number; othersFix?: string }
  /** the last read failed: the cards are what was last read */
  stale: boolean
}

export interface MeshRow {
  key: string
  name: string
  tone: 'up' | 'neutral' | 'amber'
  /** the state word alone, for the card and its accessible name */
  word: string
  /** the state word and the server's reason, for the agent's page */
  status: string
  fix: string
  facts: string
  /** the card's description; a built-in agent's own line while no card text is known; or empty */
  description: string
  /** the fix line is a quiet note (a missing card copy), not a warning */
  quiet: boolean
  /** an added agent's "the app does not check it" line, from the server; empty for the others */
  note: string
  /** an agent the add command wrote: the app never checks it */
  added: boolean
  /** "Built in" or "Added by you" */
  tag: string
  /** unslop's "Today: …" line, or empty when its record has no usage */
  usage: string
  /** "Last run 14:02 · ok", "No runs yet", or empty for a body without `lastRun` */
  lastrun: string
}

/** the section's model: one card per agent, by name, with §2.4's words and the server's reason and fix */
export function meshRows(body: MeshAgentsInput['body'] | null | undefined, nowMs: number): {
  title: string
  count: string
  /** "checked 1m ago" for the built-in agents; empty when there are none */
  checked: string
  others: string
  rows: MeshRow[]
}

export function installMeshAgents(deps?: { doc?: Document; onRefresh?: () => void; onOpen?: (key: string, name: string) => void }): {
  /** mounts the section in `slot` while `input` is set; with null, no section exists. `openKey`'s card carries aria-current */
  paint(slot: Element, input: MeshAgentsInput | null, nowMs: number, openKey?: string | null): void
  /** the card button for `key`, or null */
  cardFor(key: string): HTMLButtonElement | null
}
