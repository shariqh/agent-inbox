// The package's mesh.json reader against the shared fixtures (#483, unslop design
// §4.2). test/mesh-json-parity.test.ts runs the same cases against the app's
// src/mesh-config.ts, so both readers give the same verdict for every case.
import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshDir, meshFile, readMesh } from '../src/mesh-config.js'

type Case = { name: string; verdict: string; file?: string; pad?: number; kind?: 'symlink' | 'directory' | 'missing' }
const FIXTURES = new URL('../../../test/fixtures/mesh-json/', import.meta.url).pathname
const cases = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as {
  dirs: Array<{ env: Record<string, string>; home: string; dir: string }>
  files: Case[]
}

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-pkg-'))
  made.push(dir)
  return dir
}

function materialise(c: Case, dir: string): void {
  const target = meshFile(dir)
  if (c.file) copyFileSync(join(FIXTURES, c.file), target)
  else if (c.pad) writeFileSync(target, `{"schema":1,"pad":"${'x'.repeat(c.pad - 21)}"}`)
  else if (c.kind === 'symlink') symlinkSync(join(FIXTURES, 'schema-1.json'), target)
  else if (c.kind === 'directory') mkdirSync(target)
}

describe('mesh.json reader parity (#483)', () => {
  it('meshDir gives every fixture folder', () => {
    for (const d of cases.dirs) expect(meshDir(d.env, d.home)).toBe(d.dir)
  })

  for (const c of cases.files) {
    it(`packages/mesh: ${c.name}`, () => {
      const dir = scratch()
      materialise(c, dir)
      const read = readMesh(meshFile(dir))
      expect(read.kind === 'refused' ? read.reason : read.kind).toBe(c.verdict)
    })
  }

  it('returns the document when it is on', () => {
    const dir = scratch()
    copyFileSync(join(FIXTURES, 'agents-unslop.json'), meshFile(dir))
    const read = readMesh(meshFile(dir))
    expect(read.kind === 'present' && read.doc['agents']).toEqual({ unslop: { endpoint: 'http://127.0.0.1:4420', profile: 'unslop' } })
  })
})
