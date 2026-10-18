// Issue #197 — where this MCP server runs from, recorded on its Live presence row
// so the older-build hint can give advice that actually updates THIS session.
//
// The marker is the one scripts/install-agents.sh itself uses to tell the two
// apart: an installed agent runtime carries runtime-manifest.json in its root,
// beside dist/ — Setup's ~/.agent-inbox/runtime/<runtime-id>/, and a payload
// inside the app bundle (Resources/app/runtime/<platform-arch>/). A checkout,
// running its built dist/ or its src/ through tsx, never does.
//
// MCP-process code: a single stat, no stdout, never throws.
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ServerSource = 'runtime' | 'checkout'

/** `moduleUrl` is the `import.meta.url` of a module in dist/ or src/. */
export function detectServerSource(moduleUrl: string): ServerSource {
  try {
    const manifest = join(dirname(fileURLToPath(moduleUrl)), '..', 'runtime-manifest.json')
    return statSync(manifest).isFile() ? 'runtime' : 'checkout'
  } catch {
    return 'checkout'
  }
}
