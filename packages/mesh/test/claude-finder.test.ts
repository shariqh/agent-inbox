// The package's findClaude against the shared cases (Claude Code as a model server, D4).
// test/claude-finder.test.ts runs the same cases against the app's src/mesh-config.ts.
// No case runs a program: each only builds files and asks where claude would be.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findClaude } from '../src/mesh-config.js'

type Case = { name: string; files: Record<string, string>; path: string[] | null; fixed: string[]; expect: string | null }
const FIXTURES = new URL('../../../test/fixtures/claude-finder/', import.meta.url).pathname
const cases = (JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { cases: Case[] }).cases

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function build(c: Case, dir: string): void {
  for (const [rel, kind] of Object.entries(c.files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (kind === 'dir') mkdirSync(file)
    else if (kind.startsWith('link:')) symlinkSync(join(dir, kind.slice(5)), file)
    else {
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, kind === 'exec' ? 0o755 : kind === 'open' ? 0o775 : 0o644)
    }
  }
}

describe('findClaude (Claude Code as a model server, D4)', () => {
  for (const c of cases) {
    it(`packages/mesh: ${c.name}`, () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-finder-')))
      made.push(dir)
      build(c, dir)
      const at = (p: string): string => p.replace(/^\$/, dir)
      const env = c.path === null ? {} : { PATH: c.path.map(at).join(':') }
      const found = findClaude(env, join(dir, 'home'), c.fixed.map(at))
      expect(found === undefined ? null : found).toBe(c.expect === null ? null : realpathSync(join(dir, c.expect)))
    })
  }
})
