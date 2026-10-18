// Issue #197 — where a session's MCP server runs from decides which advice can
// update it, so the server records it once at startup. The marker is the one
// scripts/install-agents.sh itself uses: an installed agent runtime (Setup's
// ~/.agent-inbox/runtime/<id>/, or a payload inside the app bundle) carries
// runtime-manifest.json beside its dist/; a checkout never does.
import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectServerSource } from '../src/server-source.js'

function layout(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'server-source-'))
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}
const moduleUrl = (...parts: string[]): string => pathToFileURL(join(...parts)).href

describe('detectServerSource', () => {
  it('an installed agent runtime has runtime-manifest.json beside its dist/', () => {
    const root = layout(['runtime-manifest.json', 'dist/mcp.js', 'bin/node', 'scripts/install-agents.sh'])
    expect(detectServerSource(moduleUrl(root, 'dist', 'mcp.js'))).toBe('runtime')
  })

  it('a checkout runs its built dist/ or its src/ with no runtime manifest', () => {
    const root = layout(['package.json', 'dist/mcp.js', 'src/mcp.ts'])
    expect(detectServerSource(moduleUrl(root, 'dist', 'mcp.js'))).toBe('checkout')
    expect(detectServerSource(moduleUrl(root, 'src', 'mcp.ts'))).toBe('checkout')
  })

  it('a runtime-manifest.json that is not a file does not make a runtime', () => {
    const root = layout(['dist/mcp.js'])
    mkdirSync(join(root, 'runtime-manifest.json'))
    expect(detectServerSource(moduleUrl(root, 'dist', 'mcp.js'))).toBe('checkout')
  })
})
