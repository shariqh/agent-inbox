import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inferProject, inferStream, inferAgent } from '../src/infer.js'

function tmpGitRepo(opts: { remote?: string; branch?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir })
  if (opts.branch) execFileSync('git', ['checkout', '-q', '-b', opts.branch], { cwd: dir })
  if (opts.remote) execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir })
  return dir
}

describe('inferProject', () => {
  it('uses the git remote origin basename', () => {
    const dir = tmpGitRepo({ remote: 'git@github.com:shariqh/social-agent.git' })
    expect(inferProject(dir)).toBe('social-agent')
  })
  it('falls back to cwd basename with no remote', () => {
    const dir = tmpGitRepo()
    expect(inferProject(dir)).toBe(basename(dir))
  })
  it('falls back to cwd basename outside any git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferProject(dir)).toBe(basename(dir))
  })
})

describe('inferStream', () => {
  it('returns the current branch', () => {
    const dir = tmpGitRepo({ branch: 'feat/x' })
    expect(inferStream(dir)).toBe('feat/x')
  })
  it('returns empty string outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plain-'))
    expect(inferStream(dir)).toBe('')
  })
})

describe('inferAgent', () => {
  it('maps claude client names', () => {
    expect(inferAgent('claude-code')).toBe('claude-code')
    expect(inferAgent('Claude Code')).toBe('claude-code')
  })
  it('maps copilot client names', () => {
    expect(inferAgent('github-copilot-cli')).toBe('copilot')
  })
  it('passes through an unknown name, and defaults when absent', () => {
    expect(inferAgent('aider')).toBe('aider')
    expect(inferAgent(undefined)).toBe('unknown')
    expect(inferAgent('')).toBe('unknown')
  })
})
