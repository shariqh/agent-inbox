// A made agent's card file and stored description, read by the runner (agents a chat makes, step 1,
// D1). test/made-card-parity.test.ts runs the same shared cases against the app's src/mesh-made.ts,
// so meshctl new and the runner give the same verdict, in the same words, for every case.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMadeCard } from '../src/made-card.js'

type Case = { name: string; id?: string; stored?: boolean; doc?: Record<string, unknown>; text?: string; fill?: { key: string; char: string; count: number }; pad?: number; verdict: string; card?: unknown }
const FIXTURES = new URL('../../../test/fixtures/made-agents/', import.meta.url).pathname
const shared = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { servers: Record<string, 'claude-code' | 'address'>; cases: Case[] }
const kind = (name: string): 'claude-code' | 'address' | undefined => (Object.hasOwn(shared.servers, name) ? shared.servers[name] : undefined)

const textOf = (c: Case): string => {
  if (c.text !== undefined) return c.text
  const doc = { ...c.doc, ...(c.fill ? { [c.fill.key]: c.fill.char.repeat(c.fill.count) } : {}) }
  const text = JSON.stringify(doc)
  return c.pad ? text.padEnd(c.pad, ' ') : text
}

describe('made agent card files (D1): the runner\'s reader', () => {
  it('the shared cases cover each key\'s rule and every kind of refusal', () => {
    const words = shared.cases.map((c) => c.verdict).join('\n')
    for (const key of ['name', 'description', 'instructions', 'server', 'model']) expect(words, key).toContain(`"${key}" must`)
    for (const part of ['has no', 'holds the key', 'does not know', 'not valid JSON', 'one JSON object', 'larger than', '"schema"']) expect(words, part).toContain(part)
  })

  for (const c of shared.cases) {
    it(`packages/mesh: ${c.name}`, () => {
      const read = parseMadeCard(textOf(c), c.id ?? 'action-items', kind, c.stored === true)
      if (c.verdict !== 'ok') return void expect(read).toEqual({ refused: c.verdict })
      expect('card' in read, JSON.stringify(read)).toBe(true)
      if (c.card !== undefined) expect(read).toEqual({ card: c.card })
    })
  }

  it('a refusal never holds a value from the file', () => {
    const secret = 'sk-ant-CANARY0123456789abcdef'
    for (const doc of [
      { name: secret, description: 'd', instructions: 'i', server: 'claude' },
      { name: 'action-items', description: `${secret}\n`, instructions: 'i', server: 'claude' },
      { name: 'action-items', description: 'd', instructions: `${secret}\u0001`, server: 'claude' },
      { name: 'action-items', description: 'd', instructions: 'i', server: secret },
      { name: 'action-items', description: 'd', instructions: 'i', server: 'box', model: `${secret} x` },
      { name: 'action-items', description: 'd', instructions: 'i', server: 'claude', [secret]: 1 },
    ]) {
      const read = parseMadeCard(JSON.stringify(doc), 'action-items', kind, false)
      expect('refused' in read && !read.refused.includes('CANARY'), JSON.stringify(read)).toBe(true)
    }
  })
})
