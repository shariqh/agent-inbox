export interface MeshAgentsInput {
  /** the last `/api/mesh/agents` body */
  body: { on: boolean; agents: Array<Record<string, any>>; others?: number }
  /** the last read failed: the cards are what was last read */
  stale: boolean
}

export interface MeshRow {
  key: string
  name: string
  tone: 'up' | 'neutral' | 'amber'
  /** the state word alone, for the card's accessible name */
  word: string
  status: string
  fix: string
  facts: string
  /** unslop's "Today: …" line, or empty when its record has no usage */
  usage: string
  /** "Last run 14:02 · ok", "No runs yet", or empty for a body without `lastRun` */
  lastrun: string
  details: Array<[string, Array<string | { text: string; tags: string[] }>]>
  json: string | null
}

/** the section's model: one card per agent, by name, with §2.4's words and the server's reason and fix */
export function meshRows(body: MeshAgentsInput['body'] | null | undefined, nowMs: number): {
  title: string
  checked: string
  others: string
  rows: MeshRow[]
}

export function installMeshAgents(deps?: { doc?: Document; onRefresh?: () => void; onChange?: () => void; onOpen?: (key: string, name: string) => void }): {
  /** mounts the section in `slot` while `input` is set; with null, no section exists. `openKey`'s card carries aria-current */
  paint(slot: Element, input: MeshAgentsInput | null, nowMs: number, openKey?: string | null): void
  /** the window-local open state of the section, for frameInputs() */
  state(): string
}
