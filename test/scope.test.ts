import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { makeScope } from '../src/scope.js'

describe('makeScope', () => {
  it('infers project/stream from cwd and agent from the client name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    const scope = makeScope(dir)
    const s = scope.get('claude-code')
    expect(s.project).toBe(basename(dir))
    expect(s.stream).toBe('')
    expect(s.agent).toBe('claude-code')
  })

  it('override replaces project/stream but agent still comes from the client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    const scope = makeScope(dir)
    scope.override({ project: 'oris', stream: 'release' })
    const s = scope.get('github-copilot')
    expect(s.project).toBe('oris')
    expect(s.stream).toBe('release')
    expect(s.agent).toBe('copilot')
  })
})
