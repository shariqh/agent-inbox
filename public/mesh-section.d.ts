export interface MeshAgentsInput {
  /** the last `/api/mesh/agents` body */
  body: { on: boolean; agents: Array<Record<string, any>>; others?: number }
  /** the last read failed: the rows are what was last read */
  stale: boolean
}

export interface MeshRow {
  key: string
  name: string
  tone: 'up' | 'neutral' | 'amber'
  status: string
  fix: string
  facts: string
  /** unslop's "Today: …" line, or empty when its record has no usage */
  usage: string
  details: Array<[string, Array<string | { text: string; tags: string[] }>]>
  json: string | null
}

/** the section's model: one row per agent, by name, with §2.4's words and the server's reason and fix */
export function meshRows(body: MeshAgentsInput['body'] | null | undefined, nowMs: number): {
  title: string
  checked: string
  others: string
  rows: MeshRow[]
}

export function installMeshAgents(deps?: { doc?: Document; onRefresh?: () => void; onChange?: () => void }): {
  /** mounts the section in `slot` while `input` is set; with null, no section exists */
  paint(slot: Element, input: MeshAgentsInput | null, nowMs: number): void
  /** the window-local open state (section, rows, Card JSON), for frameInputs() */
  state(): string
}
