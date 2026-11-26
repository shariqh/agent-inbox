// A made agent's card file and stored description, held twice (agents a chat makes, step 1, D1):
// packages/mesh cannot import the app's source, so the shared cases in test/fixtures/made-agents/
// run here against src/mesh-made.ts and in packages/mesh/test/made-card.test.ts against the
// runner's reader, with the same verdicts in the same words.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMadeCard } from '../src/mesh-made.js'

type Case = { name: string; id?: string; stored?: boolean; doc?: Record<string, unknown>; text?: string; fill?: { key: string; char: string; count: number }; pad?: number; verdict: string; card?: unknown }
const FIXTURES = new URL('./fixtures/made-agents/', import.meta.url).pathname
const shared = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { servers: Record<string, 'claude-code' | 'address'>; cases: Case[] }
const kind = (name: string): 'claude-code' | 'address' | undefined => (Object.hasOwn(shared.servers, name) ? shared.servers[name] : undefined)

const textOf = (c: Case): string => {
  if (c.text !== undefined) return c.text
  const text = JSON.stringify({ ...c.doc, ...(c.fill ? { [c.fill.key]: c.fill.char.repeat(c.fill.count) } : {}) })
  return c.pad ? text.padEnd(c.pad, ' ') : text
}

describe('made agent card files (D1): src/mesh-made.ts', () => {
  for (const c of shared.cases) {
    it(`src/mesh-made.ts: ${c.name}`, () => {
      const read = parseMadeCard(textOf(c), c.id ?? 'action-items', kind, c.stored === true)
      if (c.verdict !== 'ok') return void expect(read).toEqual({ refused: c.verdict })
      expect('card' in read, JSON.stringify(read)).toBe(true)
      if (c.card !== undefined) expect(read).toEqual({ card: c.card })
    })
  }
})
