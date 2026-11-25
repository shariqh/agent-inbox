// The package's servers.json reader against the shared fixtures (model servers step 1, D1).
// test/servers-json-parity.test.ts runs the same cases against the app's src/mesh-config.ts, so
// both readers give the same verdict for every case.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readServers } from '../src/mesh-config.js'

type Case = { name: string; verdict: string; doc?: unknown; text?: string; mode?: number; pad?: number; kind?: 'symlink' | 'directory' | 'missing'; servers?: string[] }
const FIXTURES = new URL('../../../test/fixtures/servers-json/', import.meta.url).pathname
const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { files: Case[]; tooMany: { verdict: string } }
const EMPTY = '{"schema":1,"servers":{}}'

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'servers-pkg-'))
  made.push(dir)
  return dir
}

function materialise(c: Case, dir: string): void {
  const file = join(dir, 'mesh', 'servers.json')
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

describe('servers.json reader parity (model servers D1)', () => {
  for (const c of cases.files) {
    it(`packages/mesh: ${c.name}`, () => {
      const dir = scratch()
      materialise(c, dir)
      expect(verdictOf(dir)).toEqual(c.verdict === 'present' ? { verdict: 'present', servers: c.servers } : { verdict: c.verdict })
    })
  }

  it('packages/mesh: 32 servers are read, 33 refused', () => {
    for (const [n, verdict] of [[32, 'present'], [33, cases.tooMany.verdict]] as const) {
      const dir = scratch()
      const servers = Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { baseUrl: 'https://box.example' }]))
      materialise({ name: 'many', verdict, doc: { schema: 1, servers } }, dir)
      expect(verdictOf(dir).verdict).toBe(verdict)
    }
  })

  it('returns each entry as written', () => {
    const dir = scratch()
    materialise({ name: 'one', verdict: 'present', doc: { schema: 1, servers: { box: { baseUrl: 'https://box.example/llm', apiKey: { env: 'BOX_KEY' } }, open: { baseUrl: 'http://127.0.0.1:8080' } } } }, dir)
    expect(readServers(dir)).toEqual({ kind: 'present', servers: { box: { baseUrl: 'https://box.example/llm', apiKey: { env: 'BOX_KEY' } }, open: { baseUrl: 'http://127.0.0.1:8080' } } })
  })
})
