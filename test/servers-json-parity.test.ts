// The servers.json rule, held twice (model servers step 1, D1): packages/mesh cannot import the
// app's source, so the shared cases in test/fixtures/servers-json/ run here against
// src/mesh-config.ts and in packages/mesh/test/servers-config.test.ts against the package's
// reader, with the same expected verdicts.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SERVERS_REASONS, readServers, serversFile } from '../src/mesh-config.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

type Case = { name: string; verdict: string; doc?: unknown; text?: string; mode?: number; pad?: number; kind?: 'symlink' | 'directory' | 'missing'; servers?: string[] }
const FIXTURES = new URL('./fixtures/servers-json/', import.meta.url).pathname
const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { files: Case[]; tooMany: { verdict: string } }
const EMPTY = '{"schema":1,"servers":{}}'

function materialise(c: Case, dir: string): void {
  const file = serversFile(dir)
  mkdirSync(join(dir, 'mesh'), { mode: 0o700 })
  if (c.kind === 'missing') return
  if (c.kind === 'directory') return void mkdirSync(file)
  if (c.kind === 'symlink') {
    writeFileSync(join(dir, 'real.json'), EMPTY, { mode: 0o600 })
    return void symlinkSync(join(dir, 'real.json'), file)
  }
  writeFileSync(file, c.pad ? EMPTY.padEnd(c.pad, ' ') : c.text ?? JSON.stringify(c.doc))
  chmodSync(file, c.mode ?? 0o600)
}

const verdictOf = (dir: string): { verdict: string; servers?: string[] } => {
  const read = readServers(dir)
  return read.kind === 'present' ? { verdict: 'present', servers: Object.keys(read.servers) } : { verdict: read.kind === 'refused' ? read.reason : 'missing' }
}

describe('servers.json parity fixtures (model servers D1)', () => {
  it('cover every refusal reason but unreadable', () => {
    const seen = new Set([...cases.files.map((c) => c.verdict), cases.tooMany.verdict])
    for (const reason of Object.keys(SERVERS_REASONS)) if (reason !== 'unreadable') expect(seen, reason).toContain(reason)
  })

  for (const c of cases.files) {
    it(`src/mesh-config.ts: ${c.name}`, () => {
      const dir = scratchDir('servers-parity-')
      materialise(c, dir)
      expect(verdictOf(dir)).toEqual(c.verdict === 'present' ? { verdict: 'present', servers: c.servers } : { verdict: c.verdict })
    })
  }

  it('src/mesh-config.ts: 32 servers are read, 33 refused', () => {
    for (const [n, verdict] of [[32, 'present'], [33, cases.tooMany.verdict]] as const) {
      const dir = scratchDir('servers-parity-')
      const servers = Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { baseUrl: 'https://box.example' }]))
      materialise({ name: 'many', verdict, doc: { schema: 1, servers } }, dir)
      expect(verdictOf(dir).verdict).toBe(verdict)
    }
  })

  it('a reason names the rule, never a value from the file', () => {
    for (const words of Object.values(SERVERS_REASONS)) expect(words).not.toMatch(/box\.example|planted/)
  })
})
