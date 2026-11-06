// The mesh.json reading rule, held twice (#483, unslop design §4.2): packages/mesh
// cannot import the app's source, so the shared cases in test/fixtures/mesh-json/
// run here against src/mesh-config.ts (through meshctl status, which applies the
// file checks) and in packages/mesh/test/mesh-config.test.ts against the
// package's reader, with the same expected verdicts.
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MESH_REASONS, meshDir, meshFile } from '../src/mesh-config.js'
import { runMeshctl } from '../src/meshctl.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

type Case = { name: string; verdict: string; file?: string; pad?: number; kind?: 'symlink' | 'directory' | 'missing' }
const FIXTURES = new URL('./fixtures/mesh-json/', import.meta.url).pathname
const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as {
  dirs: Array<{ env: Record<string, string>; home: string; dir: string }>
  files: Case[]
}

function materialise(c: Case, dir: string): void {
  const target = meshFile(dir)
  if (c.file) copyFileSync(join(FIXTURES, c.file), target)
  else if (c.pad) writeFileSync(target, `{"schema":1,"pad":"${'x'.repeat(c.pad - 21)}"}`)
  else if (c.kind === 'symlink') symlinkSync(join(FIXTURES, 'schema-1.json'), target)
  else if (c.kind === 'directory') mkdirSync(target)
}

function verdict(dir: string): string {
  let out = ''
  runMeshctl(['status'], { env: { AGENT_INBOX_MESH_DIR: dir }, home: '/nonexistent-home', out: (t) => { out += t } })
  if (out.includes('Mesh: off. No ')) return 'missing'
  if (out.includes('turns on no piece')) return 'present'
  const found = Object.entries(MESH_REASONS).filter(([, words]) => out.includes(words))
  return found.length === 1 ? found[0]![0] : `unrecognised: ${out}`
}

describe('mesh.json parity fixtures (#483)', () => {
  it('cover every refusal reason the file checks can produce, except unreadable', () => {
    const seen = new Set(cases.files.map((c) => c.verdict))
    for (const reason of Object.keys(MESH_REASONS)) if (reason !== 'unreadable') expect(seen).toContain(reason)
  })

  it('meshDir gives every fixture folder', () => {
    for (const d of cases.dirs) expect(meshDir(d.env, d.home)).toBe(d.dir)
  })

  for (const c of cases.files) {
    it(`src/mesh-config.ts: ${c.name}`, () => {
      const dir = scratchDir('mesh-parity-')
      materialise(c, dir)
      expect(verdict(dir)).toBe(c.verdict)
    })
  }
})
