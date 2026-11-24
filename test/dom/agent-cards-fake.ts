// A stand-in for src/mesh-agents.ts behind the viewer's real routes, for the Agent cards tab's DOM
// tests that need a file of their own (test/dom/agent-cards-keys.test.ts, agent-cards-links.test.ts): the
// harness keeps every boot's window and document listeners for the whole file, so a key or a hash
// is answered by every app booted before it. test/dom/mesh-agents.test.ts has the full stand-in.
import type { MeshAgents } from '../../src/mesh-agents.js'

type Json = Record<string, unknown>
const at = (ago: number) => new Date(Date.now() - ago).toISOString()

export const agent = (name: string, over: Json = {}): Json => ({
  key: `mesh.json:${name}`, name, kind: 'built-in', where: 'local', endpoint: 'http://127.0.0.1:4420', profile: null,
  state: 'up', reason: null, fix: null, checkedAt: at(60_000), card: null, cardJson: null, lastSeen: null, ...over,
})

export function fakeMesh(agents: Json[]) {
  const s = { version: { agents: agents.length } as { agents: number } | undefined, body: { on: true, agents, others: 0 } as Json, triggers: [] as string[] }
  const mesh: MeshAgents = {
    version: () => s.version,
    body: () => s.body,
    runs: (name) => ({ on: true, name, runs: [], older: false, skipped: 0, truncated: false, keptDays: 30, forget: '' }),
    trigger: async (trigger, name) => {
      s.triggers.push(name === undefined ? trigger : `${trigger} ${name}`)
      return true
    },
  }
  return { s, mesh }
}
