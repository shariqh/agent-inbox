// findClaude, held twice (Claude Code as a model server, D4): packages/mesh cannot import the
// app's source, so the shared cases in test/fixtures/claude-finder/ run here against
// src/mesh-config.ts and in packages/mesh/test/claude-finder.test.ts against the package's copy.
// No case runs a program: each only builds files and asks where claude would be.
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { findClaude } from '../src/mesh-config.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

afterEach(() => removeScratchDirs())

type Case = { name: string; files: Record<string, string>; path: string[] | null; fixed: string[]; home?: string; expect: string | null }
const FIXTURES = new URL('./fixtures/claude-finder/', import.meta.url).pathname
const cases = (JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8')) as { cases: Case[] }).cases

function build(c: Case, dir: string): void {
  for (const [rel, kind] of Object.entries(c.files)) {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    if (kind === 'dir') mkdirSync(file)
    else if (kind.startsWith('link:')) symlinkSync(join(dir, kind.slice(5)), file)
    else {
      writeFileSync(file, '#!/bin/sh\nexit 0\n')
      chmodSync(file, kind === 'exec' ? 0o755 : kind === 'open' ? 0o775 : kind === 'others' ? 0o757 : 0o644)
    }
  }
}

describe('findClaude (Claude Code as a model server, D4)', () => {
  for (const c of cases) {
    it(`src/mesh-config.ts: ${c.name}`, () => {
      const dir = realpathSync(scratchDir('claude-finder-'))
      build(c, dir)
      const at = (p: string): string => p.replace(/^\$/, dir)
      const env = c.path === null ? {} : { PATH: c.path.map(at).join(':') }
      const home = c.home === undefined ? join(dir, 'home') : c.home.startsWith('rel:') ? relative(process.cwd(), at(c.home.slice(4))) : at(c.home)
      if (c.home?.startsWith('rel:')) expect(isAbsolute(home)).toBe(false)
      const found = findClaude(env, home, c.fixed.map(at))
      expect(found === undefined ? null : found).toBe(c.expect === null ? null : realpathSync(join(dir, c.expect)))
    })
  }
})
