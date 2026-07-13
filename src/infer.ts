import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function inferProject(cwd: string): string {
  const remote = git(cwd, ['remote', 'get-url', 'origin'])
  if (remote) {
    const name = basename(remote.replace(/\.git$/, ''))
    if (name) return name
  }
  return basename(cwd) || 'unknown'
}

export function inferStream(cwd: string): string {
  return git(cwd, ['branch', '--show-current']) ?? ''
}

export function inferAgent(clientName: string | undefined): string {
  if (!clientName) return 'unknown'
  const lower = clientName.toLowerCase()
  if (lower.includes('claude')) return 'claude-code'
  if (lower.includes('copilot')) return 'copilot'
  return clientName
}
